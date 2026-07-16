import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import OpenAI from 'openai';
import {
  IGNORED_FOLDERS,
  TEXT_EXTENSIONS,
  EXTRACT_DIR,
  getOpenAIConfig,
  RATE_LIMIT_PAUSE_MS
} from '../config/index.js';
import { ensureDirectoryExists } from '../utils/file.js';

// ---------------------------------------------------------------------------
// Lazy OpenAI client — created on first call so dotenv has time to load
// ---------------------------------------------------------------------------
let _openai = null;

function getClient() {
  if (!_openai) {
    const config = getOpenAIConfig();
    if (!config.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Please configure it in server/.env or as an environment variable.'
      );
    }
    _openai = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey
    });
  }
  return _openai;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple promise-based delay.
 */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes a chat completion call with the given messages and optional JSON mode.
 */
async function callLLM(systemInstruction, userContent, jsonMode = false) {
  const client = getClient();

  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userContent }
  ];

  const config = getOpenAIConfig();
  const requestOptions = {
    model: config.model,
    messages
  };

  if (jsonMode) {
    requestOptions.response_format = { type: 'json_object' };
  }

  const response = await client.chat.completions.create(requestOptions);
  const content = response.choices?.[0]?.message?.content;
  if (content == null || String(content).trim() === '') {
    throw new Error('AI returned an empty response.');
  }
  return content;
}

/** Config / tooling files that the AI must never overwrite. */
const PROTECTED_OUTPUT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'angular.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.spec.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'vite.config.js',
  '.gitignore',
  'index.html',
  'eslint.config.js',
  '.browserslistrc'
]);

/**
 * Resolve a write path that must stay inside the migration workspace.
 * Returns null if the path is unsafe or points at a protected config file.
 */
function resolveSafeWritePath(workspaceRoot, relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;

  let normalized = relativePath.replace(/\\/g, '/').trim().replace(/^\.?\//, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  // Drop accidental leading project-folder prefixes
  normalized = normalized.replace(/^(migrated-(?:angular|react)-project\/)+/i, '');

  const baseName = path.posix.basename(normalized);
  if (PROTECTED_OUTPUT_FILES.has(baseName)) {
    return null;
  }

  // Only allow application source (and public assets) under known roots
  if (
    !normalized.startsWith('src/') &&
    !normalized.startsWith('public/')
  ) {
    return null;
  }

  const fullPath = path.resolve(workspaceRoot, normalized);
  const root = path.resolve(workspaceRoot);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    return null;
  }

  return { relative: normalized, full: fullPath };
}

/**
 * Safely filters out framework bloat and reads only real text files.
 */
function readDirectoryRecursively(dirPath, baseDir = dirPath, fileList = {}) {
  if (!fs.existsSync(dirPath)) return fileList;

  const items = fs.readdirSync(dirPath);

  for (const item of items) {
    const fullPath = path.join(dirPath, item);
    const relativePath = path.relative(baseDir, fullPath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (IGNORED_FOLDERS.has(item) || item.startsWith('.')) {
        continue;
      }
      readDirectoryRecursively(fullPath, baseDir, fileList);
    } else {
      const ext = path.extname(item).toLowerCase();
      if (TEXT_EXTENSIONS.includes(ext)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          fileList[relativePath] = content;
        } catch (e) {
          console.warn(`Skipping unreadable file: ${relativePath}`);
        }
      }
    }
  }
  return fileList;
}

/**
 * Build a context string from the files map.
 */
function buildFilesContext(filesMap) {
  let context = '';
  for (const [filePath, content] of Object.entries(filesMap)) {
    context += `\n--- START OF FILE: ${filePath} ---\n${content}\n--- END OF FILE: ${filePath} ---\n`;
  }
  return context;
}

/**
 * Find the best base search path from an extracted directory.
 * Handles nested 'src' folders and flat zips.
 */
function findBaseSearchPath(extractPath) {
  // Check if src exists at root
  if (fs.existsSync(path.join(extractPath, 'src'))) {
    return extractPath;
  }

  // Check if package.json exists at root (flat zip)
  if (fs.existsSync(path.join(extractPath, 'package.json'))) {
    return extractPath;
  }

  // Look for a nested src folder one level deep
  try {
    const entries = fs.readdirSync(extractPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_FOLDERS.has(entry.name) && !entry.name.startsWith('.')) {
        const nestedSrc = path.join(extractPath, entry.name, 'src');
        if (fs.existsSync(nestedSrc)) {
          return path.join(extractPath, entry.name);
        }
        // Maybe the project files are directly in this subdirectory
        const nestedPkg = path.join(extractPath, entry.name, 'package.json');
        if (fs.existsSync(nestedPkg)) {
          return path.join(extractPath, entry.name);
        }
      }
    }
  } catch {
    // ignore
  }

  return extractPath;
}

// ---------------------------------------------------------------------------
// Angular workspace template injection
// ---------------------------------------------------------------------------

function injectAngularWorkspaceTemplates(destPath) {
  // Keep all @angular/* packages on the same minor line to avoid npm ERESOLVE conflicts.
  const angularVersion = '20.3.0';
  const angularToolingVersion = '20.3.16';

  // 1. package.json - Angular 20 with @angular/build (standalone bootstrap; no platform-browser-dynamic)
  const packageJson = {
    name: 'migrated-angular-project',
    version: '0.0.0',
    scripts: {
      ng: 'ng',
      start: 'ng serve',
      build: 'ng build',
      watch: 'ng build --watch --configuration development',
      test: 'ng test'
    },
    dependencies: {
      '@angular/animations': `^${angularVersion}`,
      '@angular/common': `^${angularVersion}`,
      '@angular/compiler': `^${angularVersion}`,
      '@angular/core': `^${angularVersion}`,
      '@angular/forms': `^${angularVersion}`,
      '@angular/platform-browser': `^${angularVersion}`,
      '@angular/router': `^${angularVersion}`,
      'rxjs': '~7.8.0',
      'tslib': '^2.3.0',
      'zone.js': '~0.15.0'
    },
    devDependencies: {
      '@angular/build': `^${angularToolingVersion}`,
      '@angular/cli': `^${angularToolingVersion}`,
      '@angular/compiler-cli': `^${angularVersion}`,
      'typescript': '~5.9.2'
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  // 2. angular.json - using @angular/build:application
  const angularJson = {
    $schema: './node_modules/@angular/cli/lib/config/schema.json',
    version: 1,
    newProjectRoot: 'projects',
    projects: {
      'migrated-angular-project': {
        projectType: 'application',
        schematics: {},
        root: '',
        sourceRoot: 'src',
        prefix: 'app',
        architect: {
          build: {
            builder: '@angular/build:application',
            options: {
              outputPath: 'dist/migrated-angular-project',
              index: 'src/index.html',
              browser: 'src/main.ts',
              polyfills: ['zone.js'],
              tsConfig: 'tsconfig.app.json',
              assets: [],
              styles: ['src/styles.css'],
              scripts: []
            },
            configurations: {
              production: {
                budgets: [
                  { type: 'initial', maximumWarning: '500kB', maximumError: '1MB' },
                  { type: 'anyComponentStyle', maximumWarning: '4kB', maximumError: '8kB' }
                ],
                outputHashing: 'all'
              },
              development: {
                optimization: false,
                extractLicenses: false,
                sourceMap: true
              }
            },
            defaultConfiguration: 'production'
          },
          serve: {
            builder: '@angular/build:dev-server',
            configurations: {
              production: { buildTarget: 'migrated-angular-project:build:production' },
              development: { buildTarget: 'migrated-angular-project:build:development' }
            },
            defaultConfiguration: 'development'
          },
          test: {
            builder: '@angular/build:karma',
            options: {
              tsConfig: 'tsconfig.spec.json',
              assets: [],
              styles: ['src/styles.css'],
              scripts: []
            }
          }
        }
      }
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'angular.json'),
    JSON.stringify(angularJson, null, 2)
  );

  // 3. tsconfig.json
  const tsConfig = {
    compileOnSave: false,
    compilerOptions: {
      outDir: './dist/out-tsc',
      forceConsistentCasingInFileNames: true,
      strict: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      skipLibCheck: true,
      esModuleInterop: true,
      experimentalDecorators: true,
      moduleResolution: 'node',
      importHelpers: true,
      target: 'ES2022',
      module: 'ES2022',
      useDefineForClassFields: false,
      lib: ['ES2022', 'dom']
    },
    angularCompilerOptions: {
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      strictTemplates: true
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'tsconfig.json'),
    JSON.stringify(tsConfig, null, 2)
  );

  // 4. tsconfig.app.json — include all app sources so generated components always compile
  const tsConfigApp = {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: './out-tsc/app',
      types: []
    },
    files: ['src/main.ts'],
    include: ['src/**/*.d.ts', 'src/**/*.ts'],
    exclude: ['src/**/*.spec.ts']
  };
  fs.writeFileSync(
    path.join(destPath, 'tsconfig.app.json'),
    JSON.stringify(tsConfigApp, null, 2)
  );

  // 5. tsconfig.spec.json - fixed to remove non-existent src/test.ts
  const tsConfigSpec = {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: './out-tsc/spec',
      types: ['jasmine']
    },
    include: ['src/**/*.spec.ts', 'src/**/*.d.ts']
  };
  fs.writeFileSync(
    path.join(destPath, 'tsconfig.spec.json'),
    JSON.stringify(tsConfigSpec, null, 2)
  );

  // 6. index.html scaffold
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Migrated Angular Project</title>
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/x-icon" href="favicon.ico">
</head>
<body>
  <app-root></app-root>
</body>
</html>
`;
  ensureDirectoryExists(path.join(destPath, 'src'));
  fs.writeFileSync(path.join(destPath, 'src', 'index.html'), indexHtml);

  // 7. app.config.ts - consolidated providers
  const appConfigTs = `import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(),
    provideRouter([]),
    provideAnimations()
  ]
};
`;
  ensureDirectoryExists(path.join(destPath, 'src', 'app'));
  fs.writeFileSync(path.join(destPath, 'src', 'app', 'app.config.ts'), appConfigTs);

  // 8. main.ts - simplified, uses appConfig
  const mainTs = `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
`;
  fs.writeFileSync(path.join(destPath, 'src', 'main.ts'), mainTs);

  // 9. styles.css scaffold
  fs.writeFileSync(path.join(destPath, 'src', 'styles.css'), '/* Global styles */\n');

  // 10. .gitignore
  const gitignore = `# Compiled output
/dist
/tmp
/out-tsc
/bazel-out

# Node
/node_modules
npm-debug.log
yarn-error.log

# IDEs and editors
.idea/
.project
.classpath
.c9/
*.launch
.settings/
*.sublime-workspace

# Visual Studio Code
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
.history/*

# Miscellaneous
/.angular/cache
.sass-cache/
/connect.lock
/coverage
/libpeerconnection.log
testem.log
/typings
__screenshots__/

# System files
.DS_Store
Thumbs.db
`;
  fs.writeFileSync(path.join(destPath, '.gitignore'), gitignore);

  // 11. Ensure app directory exists
  ensureDirectoryExists(path.join(destPath, 'src', 'app'));
}

// ---------------------------------------------------------------------------
// React workspace template injection
// ---------------------------------------------------------------------------

function injectReactWorkspaceTemplates(destPath) {
  // 1. package.json
  const packageJson = {
    name: 'migrated-react-project',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview'
    },
    dependencies: {
      'react': '^18.3.1',
      'react-dom': '^18.3.1'
    },
    devDependencies: {
      '@types/react': '^18.3.0',
      '@types/react-dom': '^18.3.0',
      '@vitejs/plugin-react': '^4.3.0',
      'typescript': '~5.6.0',
      'vite': '^6.0.0'
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  // 2. tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true
    },
    include: ['src']
  };
  fs.writeFileSync(path.join(destPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

  // 3. vite.config.ts
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true
  }
});
`;
  fs.writeFileSync(path.join(destPath, 'vite.config.ts'), viteConfig);

  // 4. index.html
  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Migrated React Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(destPath, 'index.html'), indexHtml);

  // 5. src/main.tsx - with correct React import path
  ensureDirectoryExists(path.join(destPath, 'src'));
  const mainTsx = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
`;
  fs.writeFileSync(path.join(destPath, 'src', 'main.tsx'), mainTsx);

  // 6. src/index.css - basic global styles
  const indexCss = `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;

  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
}

#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}
`;
  fs.writeFileSync(path.join(destPath, 'src', 'index.css'), indexCss);

  // 7. src/vite-env.d.ts
  const viteEnvDts = `/// <reference types="vite/client" />
`;
  fs.writeFileSync(path.join(destPath, 'src', 'vite-env.d.ts'), viteEnvDts);

  // 8. .gitignore
  const gitignore = `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

# Node
node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`;
  fs.writeFileSync(path.join(destPath, '.gitignore'), gitignore);

  // 9. public/vite.svg placeholder
  ensureDirectoryExists(path.join(destPath, 'public'));
  const viteSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true" role="img" class="iconify iconify--logos" width="31.88" height="32" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 257"><defs><linearGradient id="IconifyId1813088fe1fbc01fb466" x1="-.828%" x2="57.636%" y1="7.652%" y2="78.411%"><stop offset="0%" stop-color="#41D1FF"></stop><stop offset="100%" stop-color="#BD34FE"></stop></linearGradient><linearGradient id="IconifyId1813088fe1fbc01fb467" x1="43.376%" x2="50.316%" y1="2.242%" y2="89.03%"><stop offset="0%" stop-color="#FFBD4F"></stop><stop offset="100%" stop-color="#FF9640"></stop></linearGradient></defs><path fill="url(#IconifyId1813088fe1fbc01fb466)" d="M255.153 37.938L134.897 252.976c-2.483 4.44-8.862 4.466-11.382.048L.875 37.958c-2.746-4.814 1.371-10.646 6.827-9.67l120.385 21.517a6.537 6.537 0 0 0 2.322-.004l117.867-21.483c5.438-.991 9.574 4.796 6.877 9.62Z"></path><path fill="url(#IconifyId1813088fe1fbc01fb467)" d="M185.432.063L96.44 17.501a3.268 3.268 0 0 0-2.634 3.014l-5.474 92.456a3.268 3.268 0 0 0 3.997 3.378l24.777-5.718c2.318-.535 4.413 1.507 3.936 3.838l-7.361 36.047c-.495 2.426 1.782 4.5 4.151 3.78l15.304-4.649c2.372-.72 4.652 1.36 4.15 3.788l-11.698 56.621c-.732 3.542 3.979 5.473 5.943 2.437l1.313-2.028l72.516-144.72c1.215-2.423-.88-5.186-3.54-4.672l-25.505 4.922c-2.396.462-4.435-1.77-3.759-4.114l16.646-57.705c.677-2.35-1.37-4.583-3.769-4.113Z"></path></svg>`;
  fs.writeFileSync(path.join(destPath, 'public', 'vite.svg'), viteSvg);
}

function ensureReactRuntimeFiles(destPath) {
  const srcDir = path.join(destPath, 'src');
  ensureDirectoryExists(srcDir);

  const appCandidates = [
    path.join(srcDir, 'App.tsx'),
    path.join(srcDir, 'App.jsx'),
    path.join(srcDir, 'App.js'),
    path.join(srcDir, 'app', 'app.tsx'),
    path.join(srcDir, 'app', 'app.jsx'),
    path.join(srcDir, 'app', 'app.js')
  ];

  let appFilePath = appCandidates.find((candidate) => fs.existsSync(candidate));
  const rootAppPath = path.join(srcDir, 'App.tsx');

  if (!appFilePath) {
    const fallbackApp = `export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', textAlign: 'center' }}>
      <h1>Migration Complete</h1>
      <p>This is a generated React workspace. Replace this with migrated UI components.</p>
    </main>
  );
}
`;
    fs.writeFileSync(rootAppPath, fallbackApp, 'utf-8');
    appFilePath = rootAppPath;
  } else if (appFilePath !== rootAppPath) {
    fs.copyFileSync(appFilePath, rootAppPath);
    appFilePath = rootAppPath;
  }

  const mainTsxPath = path.join(srcDir, 'main.tsx');
  const normalizedMain = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
  fs.writeFileSync(mainTsxPath, normalizedMain, 'utf-8');

  const indexCssPath = path.join(srcDir, 'index.css');
  if (!fs.existsSync(indexCssPath)) {
    fs.writeFileSync(indexCssPath, 'body { margin: 0; font-family: system-ui, sans-serif; }\n', 'utf-8');
  }
}

function ensureAngularRuntimeFiles(destPath) {
  const srcAppDir = path.join(destPath, 'src', 'app');
  ensureDirectoryExists(srcAppDir);

  const componentTsPath = path.join(srcAppDir, 'app.component.ts');
  if (!fs.existsSync(componentTsPath)) {
    const componentTs = `import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {}
`;
    fs.writeFileSync(componentTsPath, componentTs, 'utf-8');
  }

  const componentHtmlPath = path.join(srcAppDir, 'app.component.html');
  if (!fs.existsSync(componentHtmlPath)) {
    fs.writeFileSync(
      componentHtmlPath,
      `<main class="app-shell">\n  <h1>Migration Complete</h1>\n  <p>This is a generated Angular workspace. Replace this with migrated templates.</p>\n</main>\n`,
      'utf-8'
    );
  }

  const componentCssPath = path.join(srcAppDir, 'app.component.css');
  if (!fs.existsSync(componentCssPath)) {
    fs.writeFileSync(componentCssPath, `.app-shell { padding: 2rem; font-family: Arial, sans-serif; }\n`, 'utf-8');
  }
}

/**
 * Strip markdown fences and accidental multi-file dumps from LLM output.
 */
function stripCodeFences(content) {
  if (!content) return '';
  let cleaned = String(content).trim();
  // Full-document fence
  if (/^```/.test(cleaned)) {
    cleaned = cleaned.replace(/^```(?:[\w+-]+)?\s*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
  }
  // Residual fences
  cleaned = cleaned.replace(/^```(?:[\w+-]+)?\s*\n?/m, '');
  cleaned = cleaned.replace(/\n?```\s*$/m, '');
  return cleaned.trim();
}

/**
 * Find the end index of the first exported class body in a TypeScript file.
 * Returns -1 if not found.
 */
function findExportedClassEndIndex(source) {
  const classMatch = source.match(/export\s+class\s+\w+[^{]*\{/);
  if (!classMatch || classMatch.index === undefined) return -1;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = classMatch.index; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') inTemplate = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Find end of first top-level exported function / const component in TSX.
 */
function findReactComponentEndIndex(source) {
  const patterns = [
    /export\s+default\s+function\s+\w+[^{]*\{/,
    /export\s+function\s+\w+[^{]*\{/,
    /export\s+default\s+function\s*\(/,
    /(?:export\s+default\s+)?(?:const|function)\s+App\b[^=\n]*=?\s*(?:\([^)]*\)\s*)?(?:=>)?\s*\{/
  ];

  let start = -1;
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match.index !== undefined) {
      start = match.index;
      break;
    }
  }
  if (start === -1) return -1;

  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) return -1;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') inTemplate = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Keeps only valid TypeScript for an Angular component file.
 * AI often concatenates .ts + .html + .css into one response.
 */
function sanitizeAngularComponentTs(rawContent, baseName) {
  let content = stripCodeFences(rawContent);

  const pathMarkers = [
    /(?:^|\n)\s*\/\/\s*(?:src\/)?(?:app\/)?[\w./-]+\.html\b/i,
    /(?:^|\n)\s*\/\/\s*(?:src\/)?(?:app\/)?[\w./-]+\.css\b/i,
    /(?:^|\n)\s*\/\*\s*(?:src\/)?(?:app\/)?[\w./-]+\.html\b/i,
    /(?:^|\n)\s*\/\*\s*(?:src\/)?(?:app\/)?[\w./-]+\.css\b/i
  ];

  let cutAt = content.length;
  for (const pattern of pathMarkers) {
    const match = content.match(pattern);
    if (match && match.index !== undefined) {
      cutAt = Math.min(cutAt, match.index);
    }
  }

  const classEnd = findExportedClassEndIndex(content);
  if (classEnd !== -1) {
    cutAt = Math.min(cutAt, classEnd + 1);
  }

  let tsContent = content.slice(0, cutAt).trim();
  tsContent = tsContent.replace(/^\/\/\s*(?:src\/)?(?:app\/)?[\w./-]+\.ts\s*\n+/i, '');

  tsContent = tsContent
    .replace(/template\s*:\s*`[\s\S]*?`\s*,?\s*/g, '')
    .replace(/template\s*:\s*'[^']*'\s*,?\s*/g, '')
    .replace(/template\s*:\s*"[^"]*"\s*,?\s*/g, '')
    .replace(/styles\s*:\s*\[[\s\S]*?\]\s*,?\s*/g, '');

  if (!/@Component\s*\(/.test(tsContent)) {
    tsContent = `import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './${baseName}.html',
  styleUrl: './${baseName}.css'
})
export class AppComponent {}
`;
  } else {
    if (!tsContent.includes('templateUrl')) {
      tsContent = tsContent.replace(
        /(@Component\(\{)/,
        `$1\n  templateUrl: './${baseName}.html',`
      );
    }
    if (!tsContent.includes('styleUrl') && !tsContent.includes('styleUrls')) {
      tsContent = tsContent.replace(
        /(@Component\(\{)/,
        `$1\n  styleUrl: './${baseName}.css',`
      );
    }
  }

  tsContent = tsContent.replace(/,\s*(\n\s*\}\))/g, '$1');
  return `${tsContent.trim()}\n`;
}

/**
 * Keep only HTML — drop TS/CSS dumps and path comments.
 */
function sanitizeHtmlContent(rawContent) {
  let content = stripCodeFences(rawContent);
  content = content.replace(/^\/\/\s*(?:src\/)?(?:app\/)?[\w./-]+\.html?\s*\n+/i, '');

  // If TypeScript leaked in first, start at first tag
  const firstTag = content.search(/<[a-zA-Z!/]/);
  if (firstTag > 0 && /(?:import\s+|@Component|export\s+)/.test(content.slice(0, firstTag))) {
    content = content.slice(firstTag);
  }

  // Cut trailing CSS / TS after last closing tag block
  const cssMarker = content.search(/\n\s*(?:\/\/\s*.*\.css\b|\*?\s*\{|\.[a-zA-Z][\w-]*\s*\{)/);
  if (cssMarker !== -1 && content.lastIndexOf('</') < cssMarker) {
    // only cut if we already have substantial HTML
    if (/<\/[a-zA-Z]/.test(content.slice(0, cssMarker))) {
      content = content.slice(0, cssMarker);
    }
  }

  const tsMarker = content.search(/\n\s*(?:import\s+|export\s+|@Component)/);
  if (tsMarker !== -1 && /<\/[a-zA-Z]/.test(content.slice(0, tsMarker))) {
    content = content.slice(0, tsMarker);
  }

  return `${content.trim()}\n`;
}

/**
 * Keep only CSS — drop HTML/TS dumps and path comments.
 */
function sanitizeCssContent(rawContent) {
  let content = stripCodeFences(rawContent);
  content = content.replace(/^\/\/\s*(?:src\/)?(?:app\/)?[\w./-]+\.css\s*\n+/i, '');

  // Drop leading HTML
  const styleStart = content.search(/(?:^|\n)\s*(?:\/\*|[.#*@:[a-zA-Z]|:root|html|body|\*)/);
  if (styleStart > 0 && /<[a-zA-Z]/.test(content.slice(0, styleStart))) {
    content = content.slice(styleStart);
  }

  // Cut trailing HTML/TS
  const htmlMarker = content.search(/\n\s*<\/?[a-zA-Z]/);
  if (htmlMarker !== -1) {
    content = content.slice(0, htmlMarker);
  }
  const tsMarker = content.search(/\n\s*(?:import\s+|export\s+|@Component)/);
  if (tsMarker !== -1) {
    content = content.slice(0, tsMarker);
  }

  return `${content.trim()}\n`;
}

/**
 * Keep React component TSX free of sibling-file dumps.
 */
function sanitizeReactComponentContent(rawContent) {
  let content = stripCodeFences(rawContent);
  content = content.replace(/^\/\/\s*(?:src\/)?[\w./-]+\.tsx?\s*\n+/i, '');

  const markerPatterns = [
    /(?:^|\n)\s*\/\/\s*(?:src\/)?[\w./-]+\.(?:css|html|ts|tsx|jsx)\b/i,
    /(?:^|\n)\s*\/\*\s*(?:src\/)?[\w./-]+\.(?:css|html|ts|tsx|jsx)\b/i
  ];

  let cutAt = content.length;
  for (const pattern of markerPatterns) {
    const match = content.match(pattern);
    if (match && match.index !== undefined) {
      cutAt = Math.min(cutAt, match.index);
    }
  }

  const componentEnd = findReactComponentEndIndex(content);
  if (componentEnd !== -1) {
    cutAt = Math.min(cutAt, componentEnd + 1);
  }

  let result = content.slice(0, cutAt).trim();
  if (!/export\s+default/.test(result) && /function\s+App\b|const\s+App\b/.test(result)) {
    result += '\n\nexport default App;\n';
  }

  return `${result.trim()}\n`;
}

/**
 * Sanitize generated content based on destination file type.
 */
function sanitizeGeneratedContent(relativePath, content) {
  const normalized = relativePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);

  if (base.endsWith('.component.ts') || (normalized.includes('/app/') && base === 'app.ts')) {
    const baseName = base.replace(/\.ts$/, '');
    return sanitizeAngularComponentTs(content, baseName === 'app' ? 'app.component' : baseName);
  }
  if (normalized.endsWith('.html')) {
    return sanitizeHtmlContent(content);
  }
  if (normalized.endsWith('.css') || normalized.endsWith('.scss')) {
    return sanitizeCssContent(content);
  }
  if (
    base === 'App.tsx' ||
    base === 'App.jsx' ||
    (normalized.startsWith('src/') && (base.endsWith('.tsx') || base.endsWith('.jsx')))
  ) {
    // Don't over-truncate utility modules — only aggressive-sanitize App entry & components with JSX
    if (base === 'App.tsx' || base === 'App.jsx' || /export\s+default\s+function/.test(content)) {
      return sanitizeReactComponentContent(content);
    }
  }

  return `${stripCodeFences(content)}\n`;
}

/**
 * Ensures Angular components use external template/style files and that
 * .ts files do not contain leaked HTML/CSS from multi-file AI responses.
 */
function normalizeAngularComponentFiles(destPath) {
  const appDir = path.join(destPath, 'src', 'app');
  if (!fs.existsSync(appDir)) return;

  // Normalize alternate Angular naming (app.ts / app.html) → app.component.*
  const altTs = path.join(appDir, 'app.ts');
  const altHtml = path.join(appDir, 'app.html');
  const altCss = path.join(appDir, 'app.css');
  const componentTs = path.join(appDir, 'app.component.ts');
  const componentHtml = path.join(appDir, 'app.component.html');
  const componentCss = path.join(appDir, 'app.component.css');

  if (!fs.existsSync(componentTs) && fs.existsSync(altTs)) {
    let altContent = fs.readFileSync(altTs, 'utf-8');
    altContent = altContent
      .replace(/templateUrl:\s*['"]\.\/app\.html['"]/g, "templateUrl: './app.component.html'")
      .replace(/styleUrl:\s*['"]\.\/app\.css['"]/g, "styleUrl: './app.component.css'")
      .replace(/styleUrls:\s*\[\s*['"]\.\/app\.css['"]\s*\]/g, "styleUrls: ['./app.component.css']")
      .replace(/export\s+class\s+App\b/g, 'export class AppComponent');
    fs.writeFileSync(componentTs, sanitizeAngularComponentTs(altContent, 'app.component'), 'utf-8');
  }
  if (!fs.existsSync(componentHtml) && fs.existsSync(altHtml)) {
    fs.copyFileSync(altHtml, componentHtml);
  }
  if (!fs.existsSync(componentCss) && fs.existsSync(altCss)) {
    fs.copyFileSync(altCss, componentCss);
  }

  const entries = fs.readdirSync(appDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.component.ts')) continue;

    const baseName = entry.name.replace(/\.ts$/, '');
    const tsPath = path.join(appDir, entry.name);
    const htmlPath = path.join(appDir, `${baseName}.html`);
    const cssPath = path.join(appDir, `${baseName}.css`);

    const original = fs.readFileSync(tsPath, 'utf-8');
    const sanitized = sanitizeAngularComponentTs(original, baseName);

    if (sanitized !== original) {
      fs.writeFileSync(tsPath, sanitized, 'utf-8');
      console.log(`Sanitized contaminated TypeScript in ${entry.name}`);
    }

    if (fs.existsSync(htmlPath)) {
      const htmlOriginal = fs.readFileSync(htmlPath, 'utf-8');
      const htmlSanitized = sanitizeHtmlContent(htmlOriginal);
      if (htmlSanitized !== htmlOriginal) {
        fs.writeFileSync(htmlPath, htmlSanitized, 'utf-8');
      }
    } else {
      fs.writeFileSync(
        htmlPath,
        `<main class="app-shell">\n  <h1>Migration Complete</h1>\n</main>\n`,
        'utf-8'
      );
    }

    if (fs.existsSync(cssPath)) {
      const cssOriginal = fs.readFileSync(cssPath, 'utf-8');
      const cssSanitized = sanitizeCssContent(cssOriginal);
      if (cssSanitized !== cssOriginal) {
        fs.writeFileSync(cssPath, cssSanitized, 'utf-8');
      }
    } else {
      fs.writeFileSync(cssPath, `.app-shell { padding: 2rem; }\n`, 'utf-8');
    }
  }
}

// ---------------------------------------------------------------------------
// Main migration orchestrator
// ---------------------------------------------------------------------------

export {
  sanitizeAngularComponentTs,
  sanitizeHtmlContent,
  sanitizeCssContent,
  resolveSafeWritePath,
  stripCodeFences
};

/**
 * Runs the full AI-powered migration pipeline using an OpenAI-compatible API.
 *
 * @param {string} sourceZipPath     - Filesystem path to the uploaded ZIP
 * @param {string} userPrompt        - User's migration instructions
 * @param {string} sessionId         - Unique session identifier
 * @param {object} [options]
 * @param {string} [options.fromTech] - Source framework (Angular / React / etc.)
 * @param {string} [options.toTech]   - Target framework
 * @returns {Promise<string>}         - Path to the final output ZIP
 */
export async function runMigrationPipeline(sourceZipPath, userPrompt, sessionId, options = {}) {
  const { fromTech = 'Unknown', toTech = 'Unknown' } = options;

  // Use absolute paths based on the already-defined EXTRACT_DIR
  const extractPath = path.join(EXTRACT_DIR, sessionId);
  const migrationWorkspacePath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
  const outputZipPath = path.join(EXTRACT_DIR, `${sessionId}-final.zip`);

  // Ensure folders exist
  ensureDirectoryExists(extractPath);
  ensureDirectoryExists(migrationWorkspacePath);

  // -----------------------------------------------------------------------
  // 1. Unpack original framework archive
  // -----------------------------------------------------------------------
  console.log(`[${sessionId}] Extracting archive...`);
  const zip = new AdmZip(sourceZipPath);
  zip.extractAllTo(extractPath, true);

  // -----------------------------------------------------------------------
  // 2. Determine best base path and read source files
  // -----------------------------------------------------------------------
  const baseSearchPath = findBaseSearchPath(extractPath);
  const filesMap = readDirectoryRecursively(baseSearchPath);

  if (Object.keys(filesMap).length === 0) {
    throw new Error('No readable source files found inside the uploaded ZIP.');
  }

  const fileTree = Object.keys(filesMap).map((f) => `- ${f}`).join('\n');
  const filesContextSummary = buildFilesContext(filesMap);

  console.log(`[${sessionId}] Read ${Object.keys(filesMap).length} source files.`);

  // -----------------------------------------------------------------------
  // 2b. Inject workspace templates for known target frameworks
  // -----------------------------------------------------------------------
  const targetLower = (toTech || '').toLowerCase();
  if (targetLower.includes('angular')) {
    console.log(`[${sessionId}] Injecting Angular workspace templates...`);
    injectAngularWorkspaceTemplates(migrationWorkspacePath);
  } else if (targetLower.includes('react')) {
    console.log(`[${sessionId}] Injecting React workspace templates...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath);
  }

  // -----------------------------------------------------------------------
  // 3. AGENT STEP 1: Generate migration blueprint
  // -----------------------------------------------------------------------
  console.log(`[${sessionId}] Stage 1: Building migration blueprint...`);

  const blueprintSystemInstruction = `
You are a Principal Software Architect. Your task is to analyze an incoming source codebase and plan out a structural framework migration based on the user's demands.
Analyze the file directory structure. Provide an array mapping of target framework files that must be created from scratch to fully rebuild the app in the new architecture.
- If targeting Angular: convert React components into Angular Standalone Components. Create/update src/app/app.component.ts, src/app/app.component.html, src/app/app.component.css, etc.
- If targeting React: convert Angular components into React functional components with hooks. DO NOT create tsconfig.app.json, angular.json, or any Angular-specific config files.
Your output must strictly be raw valid JSON. No markdown wrappers. The JSON must have a single top-level key "migrationPlan" whose value is an array of objects. Each object must have these keys: "newPath" (string), "explanationOfSource" (string), "approximateSourceFilesToRead" (array of strings).

IMPORTANT RULES FOR FILE GENERATION:
- For React projects: Only generate src/ files (components, styles, etc.). Do NOT generate config files like package.json, tsconfig.json, vite.config.ts - these are already provided.
- For Angular projects: Only generate src/ files (components, templates, etc.). Do NOT generate config files like package.json, tsconfig.json, angular.json - these are already provided.
- Focus ONLY on converting the actual application code (components, services, utilities).
- USER MIGRATION MANDATE IS HIGHEST PRIORITY: when the user specifies titles, colors, themes, branding, or copy changes, every planned UI file must reflect those exact values instead of copying the source project defaults.
- For Angular: app.component.ts must use templateUrl/styleUrl — put all markup in app.component.html and styles in app.component.css. Never plan inline templates in the .ts file when an .html sibling exists.
`;

  const blueprintPrompt = `
[CURRENT CODEBASE FILE TREE MAP]
${fileTree}

[CURRENT APPLICATION FILES SOURCE CODE]
${filesContextSummary}

[MIGRATION CORE MANDATE]
${userPrompt}

[FROM TECH] ${fromTech}
[TO TECH] ${toTech}
`;

  let blueprintText;
  try {
    blueprintText = await callLLM(blueprintSystemInstruction, blueprintPrompt, true);
  } catch (err) {
    console.error(`[${sessionId}] Blueprint LLM call failed:`, err.message);
    throw new Error(`AI blueprint generation failed: ${err.message}. Please check your API key and try again.`);
  }

  let parsedPlan;
  try {
    // Strip markdown code fences if present
    const cleaned = blueprintText.replace(/^```(?:json)?\n?/gm, '').replace(/\n?```$/gm, '').trim();
    parsedPlan = JSON.parse(cleaned);
  } catch (err) {
    console.error(`[${sessionId}] Failed to parse blueprint JSON:`, err.message);
    console.error(`[${sessionId}] Raw blueprint response (first 500 chars):`, blueprintText.substring(0, 500));
    throw new Error('AI returned invalid migration plan JSON. Please try again with a more specific prompt.');
  }

  const targetFileList = parsedPlan.migrationPlan;

  if (!targetFileList || !Array.isArray(targetFileList) || targetFileList.length === 0) {
    throw new Error('The AI returned an empty migration plan. Please try again with a more specific prompt.');
  }

  // Drop unsafe / protected / framework-mismatched planned files before writing
  const filteredPlan = targetFileList.filter((item) => {
    if (!item || typeof item.newPath !== 'string') return false;
    const safe = resolveSafeWritePath(migrationWorkspacePath, item.newPath);
    if (!safe) {
      console.log(`[${sessionId}] Skipping protected/unsafe planned file: ${item.newPath}`);
      return false;
    }
    const p = safe.relative.toLowerCase();
    if (targetLower.includes('react') && (p.includes('angular') || p.endsWith('app.component.ts'))) {
      console.log(`[${sessionId}] Skipping Angular-shaped path in React migration: ${item.newPath}`);
      return false;
    }
    if (targetLower.includes('angular') && (p.endsWith('.tsx') || p.endsWith('.jsx') || p.includes('vite'))) {
      console.log(`[${sessionId}] Skipping React-shaped path in Angular migration: ${item.newPath}`);
      return false;
    }
    item.newPath = safe.relative;
    return true;
  });

  if (filteredPlan.length === 0) {
    throw new Error('Migration plan contained no writable source files. Please try again with a clearer prompt.');
  }

  console.log(`[${sessionId}] Blueprint built. Total files to convert: ${filteredPlan.length}`);

  // -----------------------------------------------------------------------
  // 4. AGENT STEP 2: Write each file one-by-one
  // -----------------------------------------------------------------------
  const fileWriterSystemInstruction = `
You are an elite Senior Frontend Engineer executing a framework translation.
You are writing the code for ONE file only in the new framework structure.
- If writing an Angular Standalone Component TypeScript file: write ONLY TypeScript. Use templateUrl/styleUrl. Do NOT include HTML markup or CSS rules in the .ts file.
- If writing an Angular .html file: write ONLY HTML markup. No TypeScript, no CSS, no file path comments.
- If writing an Angular .css file: write ONLY CSS. No HTML, no TypeScript, no file path comments.
- If writing a React Component: use functional components with hooks and TypeScript.
- Write COMPLETE code. No placeholders, no truncation, no "..." shortcuts.
Respond ONLY with raw code for the single requested file. Do not output markdown code blocks (\`\`\`).
Do NOT concatenate multiple files. Do NOT add comments like "// src/app/app.component.html" or dump sibling file contents.

CRITICAL RULES:
1. You are ONLY generating source code files (components, styles, utilities). Configuration files like package.json, tsconfig.json, vite.config.ts, angular.json are ALREADY provided and should NOT be generated.
2. For React: The main App component MUST be at src/App.tsx (NOT src/app/app.tsx). Import it as 'import App from "./App"' (NOT './app/app').
3. For React: Use consistent file extensions - ALL files should be .tsx for TypeScript React projects.
4. DO NOT create Angular-style directory structures (src/app/ subdirectory) for React projects.
5. MANDATORY USER REQUIREMENTS override source defaults: if the user specifies titles, colors, theme values, or branding, apply those exact values in this file. Do NOT keep old source titles/colors when the user asked to change them.
6. For Angular components: use templateUrl and styleUrl in the .ts file. Put ALL HTML markup in the .html file and ALL styles in the .css file. NEVER use an inline template property when an external .html file exists or will exist for the same component.
7. When sibling files for the same component were already generated, stay consistent with them (same title text, colors, and layout).
8. Output MUST contain only the contents of the single target file path you were asked to create.
`;

  const generatedFiles = {};

  for (let i = 0; i < filteredPlan.length; i++) {
    const fileTarget = filteredPlan[i];
    console.log(`[${sessionId}] Writing file [${i + 1}/${filteredPlan.length}] -> ${fileTarget.newPath}`);

    // Build context from only the files relevant to this target
    let targetSpecificContext = '';
    if (
      fileTarget.approximateSourceFilesToRead &&
      Array.isArray(fileTarget.approximateSourceFilesToRead)
    ) {
      for (const relPath of fileTarget.approximateSourceFilesToRead) {
        if (filesMap[relPath]) {
          targetSpecificContext += `\n--- SOURCE FILE: ${relPath} ---\n${filesMap[relPath]}\n`;
        }
      }
    }

    const componentDir = path.posix.dirname(fileTarget.newPath.replace(/\\/g, '/'));
    let siblingContext = '';
    for (const [generatedPath, generatedContent] of Object.entries(generatedFiles)) {
      const generatedDir = path.posix.dirname(generatedPath.replace(/\\/g, '/'));
      if (generatedDir === componentDir && generatedPath !== fileTarget.newPath) {
        siblingContext += `\n--- ALREADY GENERATED SIBLING FILE: ${generatedPath} ---\n${generatedContent}\n`;
      }
    }

    const individualFileWriterPrompt = `
[GLOBAL TARGET LAYOUT BLUEPRINT MAP]
${fileTree}

[RELEVANT SOURCE CODE CONTEXT FOR THIS TASK]
${targetSpecificContext || 'Setup/Configuration asset generation task.'}

[MANDATORY USER MIGRATION REQUIREMENTS — highest priority, override source defaults]
${userPrompt}

[ALREADY GENERATED FILES IN THIS COMPONENT FOLDER]
${siblingContext || 'None yet — you are the first file for this component.'}

[ASSIGNMENT DIRECTIONS]
Create the complete code file content for: "${fileTarget.newPath}"
Purpose/Details: ${fileTarget.explanationOfSource}
Migration target framework: ${toTech}
Write ONLY this one file. No sibling file contents. No markdown fences.
`;

    let fileContent;
    try {
      fileContent = await callLLM(fileWriterSystemInstruction, individualFileWriterPrompt, false);
    } catch (err) {
      console.error(`[${sessionId}] LLM call failed for ${fileTarget.newPath}:`, err.message);
      // Retry once
      await pause(10000);
      fileContent = await callLLM(fileWriterSystemInstruction, individualFileWriterPrompt, false);
    }

    const safePath = resolveSafeWritePath(migrationWorkspacePath, fileTarget.newPath);
    if (!safePath) {
      console.log(`[${sessionId}] Refusing unsafe write path: ${fileTarget.newPath}`);
      continue;
    }

    ensureDirectoryExists(path.dirname(safePath.full));
    const trimmedContent = sanitizeGeneratedContent(safePath.relative, fileContent);
    fs.writeFileSync(safePath.full, trimmedContent, 'utf-8');
    generatedFiles[safePath.relative] = trimmedContent;

    // Rate-limit pause between files (not after the last one)
    if (i < filteredPlan.length - 1) {
      console.log(`[Rate Limiter] Cooling down for ${RATE_LIMIT_PAUSE_MS / 1000}s...`);
      await pause(RATE_LIMIT_PAUSE_MS);
    }
  }

  // -----------------------------------------------------------------------
  // 4b. Clean up framework-specific files and fix import paths
  // -----------------------------------------------------------------------
  // Note: This is a safety net. The improved prompts should prevent this.
  const filesToRemoveForReact = [
    'tsconfig.app.json',
    'tsconfig.spec.json',
    '.browserslistrc'
  ];
  const filesToRemoveForAngular = [
    'vite.config.ts'
  ];
  
  // For React/Angular, re-inject templates AFTER AI generation to ensure correct config files
  // The AI may have overwritten our templates, so we restore them here
  if (targetLower.includes('react')) {
    console.log(`[${sessionId}] Re-injecting React templates to ensure correct config files...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath);
    ensureReactRuntimeFiles(migrationWorkspacePath);
  } else if (targetLower.includes('angular')) {
    console.log(`[${sessionId}] Re-injecting Angular templates to ensure correct config files...`);
    injectAngularWorkspaceTemplates(migrationWorkspacePath);
    ensureAngularRuntimeFiles(migrationWorkspacePath);
    normalizeAngularComponentFiles(migrationWorkspacePath);
  }

  const filesToRemove = targetLower.includes('react')
    ? filesToRemoveForReact
    : targetLower.includes('angular')
      ? filesToRemoveForAngular
      : [];

  for (const file of filesToRemove) {
    const filePath = path.join(migrationWorkspacePath, file);
    if (fs.existsSync(filePath)) {
      console.log(`[${sessionId}] Removing framework-specific file: ${file}`);
      fs.unlinkSync(filePath);
    }
    // Also check in src/ directory
    const srcFilePath = path.join(migrationWorkspacePath, 'src', file);
    if (fs.existsSync(srcFilePath)) {
      console.log(`[${sessionId}] Removing framework-specific file from src/: ${file}`);
      fs.unlinkSync(srcFilePath);
    }
  }

  // Fix React import paths - ensure main.tsx imports from ./App not ./app/app
  if (targetLower.includes('react')) {
    const mainTsxPath = path.join(migrationWorkspacePath, 'src', 'main.tsx');
    if (fs.existsSync(mainTsxPath)) {
      let mainTsxContent = fs.readFileSync(mainTsxPath, 'utf-8');
      // Fix Angular-style imports to React-style imports
      mainTsxContent = mainTsxContent.replace(/from\s+['"]\.\/app\/app['"]/g, 'from "./App"');
      mainTsxContent = mainTsxContent.replace(/from\s+['"]\.\/App\.component['"]/g, 'from "./App"');
      mainTsxContent = mainTsxContent.replace(/import\s+App\s+from\s+['"]\.\/app\/app['"]/g, 'import App from "./App"');
      fs.writeFileSync(mainTsxPath, mainTsxContent, 'utf-8');
      console.log(`[${sessionId}] Fixed React import paths in main.tsx`);
    }

    // Remove any src/app directory if it was created (Angular-style structure)
    const srcAppDir = path.join(migrationWorkspacePath, 'src', 'app');
    if (fs.existsSync(srcAppDir)) {
      console.log(`[${sessionId}] Removing Angular-style src/app directory from React project`);
      fs.rmSync(srcAppDir, { recursive: true, force: true });
    }
  }

  console.log(`[${sessionId}] All target files built. Packaging archive...`);

  // -----------------------------------------------------------------------
  // 5. Package the result into a ZIP
  // -----------------------------------------------------------------------
  const finalZip = new AdmZip();
  finalZip.addLocalFolder(migrationWorkspacePath);
  finalZip.writeZip(outputZipPath);

  console.log(`[${sessionId}] Final ZIP written to ${outputZipPath}`);

  return outputZipPath;
}

/**
 * Cleans up temporary files created during a migration session.
 * Removes uploaded ZIP, extract dir, converted dir, and final ZIP.
 */
export function cleanupSession(sourceZipPath, extractPath, outputZipPath, convertedPath) {
  try {
    const targets = [sourceZipPath, extractPath, convertedPath, outputZipPath].filter(Boolean);

    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`Removed directory: ${target}`);
      } else {
        fs.unlinkSync(target);
        console.log(`Removed file: ${target}`);
      }
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
}
