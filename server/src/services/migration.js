import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { GoogleGenAI, Type } from '@google/genai';
import {
  IGNORED_FOLDERS,
  TEXT_EXTENSIONS,
  GEMINI_MODEL,
  RATE_LIMIT_PAUSE_MS
} from '../config/index.js';
import { ensureDirectoryExists } from '../utils/file.js';

// ---------------------------------------------------------------------------
// Initialise the Gemini client
// ---------------------------------------------------------------------------
const ai = new GoogleGenAI({});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple promise-based delay.
 */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // 1. package.json
  const packageJson = {
    name: 'migrated-angular-project',
    version: '0.0.0',
    scripts: {
      ng: 'ng',
      start: 'ng serve',
      build: 'ng build',
      watch: 'ng build --watch --configuration development'
    },
    dependencies: {
      '@angular/animations': '^18.0.0',
      '@angular/common': '^18.0.0',
      '@angular/compiler': '^18.0.0',
      '@angular/core': '^18.0.0',
      '@angular/forms': '^18.0.0',
      '@angular/platform-browser': '^18.0.0',
      '@angular/platform-browser-dynamic': '^18.0.0',
      '@angular/router': '^18.0.0',
      rxjs: '~7.8.0',
      tslib: '^2.3.0',
      'zone.js': '~0.14.3'
    },
    devDependencies: {
      '@angular-devkit/build-angular': '^18.0.0',
      '@angular/cli': '^18.0.0',
      '@angular/compiler-cli': '^18.0.0',
      typescript: '~5.4.2'
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  // 2. angular.json
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
            builder: '@angular-devkit/build-angular:application',
            options: {
              outputPath: 'dist/migrated-angular-project',
              index: 'src/index.html',
              browser: 'src/main.ts',
              polyfills: ['zone.js'],
              tsConfig: 'tsconfig.app.json',
              assets: [],
              styles: ['src/styles.css'],
              scripts: []
            }
          },
          serve: {
            builder: '@angular-devkit/build-angular:dev-server',
            options: {
              buildTarget: 'migrated-angular-project:build'
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

  // 4. tsconfig.app.json
  const tsConfigApp = {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: './out-tsc/app',
      types: []
    },
    files: ['src/main.ts'],
    include: ['src/**/*.d.ts']
  };
  fs.writeFileSync(
    path.join(destPath, 'tsconfig.app.json'),
    JSON.stringify(tsConfigApp, null, 2)
  );

  // 5. index.html scaffold
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>MigratedAngularProject</title>
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

  // 6. main.ts scaffold
  const mainTs = `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRouter([])
  ]
}).catch((err) => console.error(err));
`;
  fs.writeFileSync(path.join(destPath, 'src', 'main.ts'), mainTs);

  // 7. styles.css scaffold
  fs.writeFileSync(path.join(destPath, 'src', 'styles.css'), '/* Global styles */\n');

  // 8. Ensure app directory exists
  ensureDirectoryExists(path.join(destPath, 'src', 'app'));
}

// ---------------------------------------------------------------------------
// React workspace template injection
// ---------------------------------------------------------------------------

function injectReactWorkspaceTemplates(destPath) {
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
      react: '^18.3.1',
      'react-dom': '^18.3.1'
    },
    devDependencies: {
      '@types/react': '^18.3.0',
      '@types/react-dom': '^18.3.0',
      '@vitejs/plugin-react': '^4.3.0',
      typescript: '~5.4.2',
      vite: '^5.4.0'
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

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

  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()]
});
`;
  fs.writeFileSync(path.join(destPath, 'vite.config.ts'), viteConfig);

  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Migrated React Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  ensureDirectoryExists(path.join(destPath, 'src'));
  fs.writeFileSync(path.join(destPath, 'index.html'), indexHtml);

  const mainTsx = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
  fs.writeFileSync(path.join(destPath, 'src', 'main.tsx'), mainTsx);
}

// ---------------------------------------------------------------------------
// Main migration orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the full AI-powered migration pipeline.
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

  const extractPath = path.join('extracted', sessionId);
  const migrationWorkspacePath = path.join('extracted', `${sessionId}-converted`);
  const outputZipPath = path.join('extracted', `${sessionId}-final.zip`);

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
  // 3. AGENT STEP 1: Generate migration blueprint from Gemini
  // -----------------------------------------------------------------------
  console.log(`[${sessionId}] Stage 1: Building migration blueprint...`);

  const blueprintSystemInstruction = `
You are a Principal Software Architect. Your task is to analyze an incoming source codebase and plan out a structural framework migration based on the user's demands.
Analyze the file directory structure. Provide an array mapping of target framework files that must be created from scratch to fully rebuild the app in the new architecture.
- If targeting Angular: convert React components into Angular Standalone Components. Create/update src/app/app.component.ts, src/app/app.component.html, etc.
- If targeting React: convert Angular components into React functional components with hooks.
Your output must strictly be raw valid JSON matching the exact schema configuration provided. No markdown wrappers.
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

  const blueprintResponse = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: blueprintPrompt,
    config: {
      systemInstruction: blueprintSystemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          migrationPlan: {
            type: Type.ARRAY,
            description: 'List of files that must be written/modified to complete the migration',
            items: {
              type: Type.OBJECT,
              properties: {
                newPath: {
                  type: Type.STRING,
                  description:
                    'The relative folder path and file name for the target architecture (e.g. src/app/components/demo-form/demo-form.component.ts)'
                },
                explanationOfSource: {
                  type: Type.STRING,
                  description: 'Brief note specifying exactly which original files are related to this file\'s logic'
                },
                approximateSourceFilesToRead: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Array of original file paths needed to generate this file.'
                }
              },
              required: ['newPath', 'explanationOfSource', 'approximateSourceFilesToRead']
            }
          }
        },
        required: ['migrationPlan']
      }
    }
  });

  const parsedPlan = JSON.parse(blueprintResponse.text);
  const targetFileList = parsedPlan.migrationPlan;

  if (!targetFileList || !Array.isArray(targetFileList) || targetFileList.length === 0) {
    throw new Error('Gemini returned an empty migration plan. Please try again with a more specific prompt.');
  }

  console.log(`[${sessionId}] Blueprint built. Total files to convert: ${targetFileList.length}`);

  // -----------------------------------------------------------------------
  // 4. AGENT STEP 2: Write each file one-by-one using Gemini
  // -----------------------------------------------------------------------
  const fileWriterSystemInstruction = `
You are an elite Senior Frontend Engineer executing a framework translation.
You are writing the code for one file in the new framework structure.
- If writing an Angular Standalone Component: ensure you use modern imports (e.g. CommonModule, FormsModule) and write clean TypeScript decorators.
- If writing a React Component: use functional components with hooks and TypeScript.
- Write COMPLETE code. No placeholders, no truncation, no "..." shortcuts.
Respond ONLY with raw code. Do not output markdown code blocks (\`\`\`).
`;

  for (let i = 0; i < targetFileList.length; i++) {
    const fileTarget = targetFileList[i];
    console.log(`[${sessionId}] Writing file [${i + 1}/${targetFileList.length}] -> ${fileTarget.newPath}`);

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

    const individualFileWriterPrompt = `
[GLOBAL TARGET LAYOUT BLUEPRINT MAP]
${fileTree}

[RELEVANT SOURCE CODE CONTEXT FOR THIS TASK]
${targetSpecificContext || 'Setup/Configuration asset generation task.'}

[ASSIGNMENT DIRECTIONS]
Create the complete code file content for: "${fileTarget.newPath}"
Purpose/Details: ${fileTarget.explanationOfSource}
Migration target framework: ${toTech}
`;

    let fileContentResult;
    try {
      fileContentResult = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: individualFileWriterPrompt,
        config: {
          systemInstruction: fileWriterSystemInstruction
        }
      });
    } catch (err) {
      console.error(`[${sessionId}] Gemini call failed for ${fileTarget.newPath}:`, err.message);
      // Retry once
      await pause(10000);
      fileContentResult = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: individualFileWriterPrompt,
        config: {
          systemInstruction: fileWriterSystemInstruction
        }
      });
    }

    const fullWritePath = path.join(migrationWorkspacePath, fileTarget.newPath);
    ensureDirectoryExists(path.dirname(fullWritePath));
    fs.writeFileSync(fullWritePath, fileContentResult.text.trim(), 'utf-8');

    // Rate-limit pause between files (not after the last one)
    if (i < targetFileList.length - 1) {
      console.log(`[Rate Limiter] Cooling down for ${RATE_LIMIT_PAUSE_MS / 1000}s...`);
      await pause(RATE_LIMIT_PAUSE_MS);
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
 */
export function cleanupSession(sourceZipPath, extractPath, outputZipPath) {
  try {
    if (sourceZipPath && fs.existsSync(sourceZipPath)) fs.unlinkSync(sourceZipPath);
    if (extractPath && fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
    if (outputZipPath && fs.existsSync(outputZipPath)) fs.unlinkSync(outputZipPath);
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
}