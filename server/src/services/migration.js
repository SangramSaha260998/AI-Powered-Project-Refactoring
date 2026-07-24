import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import OpenAI from 'openai';
import {
  IGNORED_FOLDERS,
  TEXT_EXTENSIONS,
  EXTRACT_DIR,
  PROVIDERS,
  getProviderConfigs,
  getProviderFallbackChain,
  isProviderConfigured,
  isOllamaCloudMode,
  RATE_LIMIT_PAUSE_MS
} from '../config/index.js';
import { getDefaultPrompt } from '../config/defaultPrompt.js';
import { resolveTargetVersions, formatVersionMandate } from '../config/targetVersions.js';
import { ensureDirectoryExists } from '../utils/file.js';
import { repairAngularWorkspace, repairReactWorkspace } from './postprocess.js';

// ---------------------------------------------------------------------------
// Multi-key / multi-provider OpenAI clients — rotate keys, then providers
// ---------------------------------------------------------------------------
const RETRYABLE_STATUS_CODES = new Set([401, 402, 429, 403]);

/** Thrown when every configured provider/key failed with rate-limit / quota errors. */
export class AllProvidersRateLimitedError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AllProvidersRateLimitedError';
    this.status = 429;
    this.cause = cause;
  }
}

/**
 * Errors that should rotate keys and/or move to the next provider.
 * Includes quota/auth codes, server errors, and network failures.
 */
function isFallbackWorthyError(err) {
  const statusCode =
    err?.status ||
    (err?.response && (err.response.status || err.response.statusCode)) ||
    0;

  if (RETRYABLE_STATUS_CODES.has(statusCode)) {
    const reason = statusCode === 429 ? 'rate-limit' : 'quota/auth';
    return { worthy: true, statusCode, reason };
  }
  if (statusCode >= 500 && statusCode < 600) return { worthy: true, statusCode, reason: 'server' };

  // Connection / DNS / timeout style failures (no HTTP status)
  const code = err?.code || err?.cause?.code || '';
  const networkCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  if (networkCodes.has(code)) {
    return { worthy: true, statusCode: statusCode || code, reason: 'network' };
  }

  const msg = String(err?.message || '').toLowerCase();
  if (
    !statusCode &&
    (msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('socket') ||
      msg.includes('timeout') ||
      msg.includes('econnrefused'))
  ) {
    return { worthy: true, statusCode: statusCode || 'network', reason: 'network' };
  }

  return { worthy: false, statusCode, reason: 'fatal' };
}

function getRetryAfterMs(err, fallbackMs) {
  const headers = err?.headers || err?.response?.headers;
  const raw =
    (headers && (headers['retry-after'] || headers['Retry-After'])) ||
    err?.error?.retry_after ||
    null;
  if (raw == null) return fallbackMs;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) {
    // OpenAI-style: seconds
    return Math.min(Math.max(asNum * 1000, fallbackMs), 60000);
  }
  return fallbackMs;
}

/**
 * Returns an array of { client, config } pairs for a provider, or null if
 * that provider has no usable credentials.
 *
 * @param {string} aiProvider
 * @param {string} [aiModel]
 * @returns {Array<{client: OpenAI, config: object}> | null}
 */
function createClients(aiProvider = 'openrouter', aiModel) {
  const configs = getProviderConfigs(aiProvider, aiModel);
  const provConfig = PROVIDERS[aiProvider];

  if (!configs[0].apiKey) {
    // Ollama Cloud requires a real API key.
    if (aiProvider === 'ollama' && isOllamaCloudMode()) {
      return null;
    }
    if (provConfig && provConfig.requiresApiKey === false) {
      console.warn(
        `${aiProvider.toUpperCase()}_API_KEY is not set. ` +
        `This is expected for "${provConfig.name}" (local). ` +
        `Using a placeholder key for client initialization.`
      );
      return configs.map(cfg => ({
        client: new OpenAI({
          baseURL: cfg.baseURL,
          apiKey: 'placeholder',
          ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
        }),
        config: cfg
      }));
    }
    return null;
  }

  return configs.map(cfg => ({
    client: new OpenAI({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
    }),
    config: cfg
  }));
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
 *
 * Fallback order (always on):
 * 1. Rotate API keys within the selected provider on quota/auth/rate-limit/5xx/network errors
 * 2. If that provider is exhausted, try the next configured provider in the chain
 *    using that provider's own keys and default model (not the UI model id)
 *
 * @param {string} systemInstruction - System prompt
 * @param {string} userContent       - User prompt
 * @param {boolean} [jsonMode=false] - Whether to request JSON output
 * @param {string} [aiProvider='openrouter'] - AI provider key
 * @param {string} [aiModel]         - Optional model override (primary provider only)
 */
async function callLLM(systemInstruction, userContent, jsonMode = false, aiProvider = 'openrouter', aiModel) {
  const chain = getProviderFallbackChain(aiProvider);
  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userContent }
  ];

  let lastError = null;
  let attemptedAnyProvider = false;
  let rateLimitedProviders = 0;
  let providersTried = 0;

  for (let providerIndex = 0; providerIndex < chain.length; providerIndex++) {
    const providerId = chain[providerIndex];
    // Treat remapped/unknown primary as "primary" only when it matches a real chain entry.
    const isPrimary = providerId === aiProvider || (providerIndex === 0 && !PROVIDERS[aiProvider]);

    const isSelectedPrimary = providerId === aiProvider;
    // Always attempt the user-selected provider; only auto-fallback entries need to be "configured".
    if (!isSelectedPrimary && !isProviderConfigured(providerId)) {
      console.warn(
        `[Provider Fallback] Skipping "${providerId}" — not configured.`
      );
      continue;
    }

    // Only the user-selected provider uses the UI model; fallbacks use defaults.
    const modelOverride = isPrimary && PROVIDERS[aiProvider] ? aiModel : undefined;
    const entries = createClients(providerId, modelOverride);

    if (!entries || entries.length === 0) {
      console.warn(
        `[Provider Fallback] Skipping "${providerId}" — no usable clients.`
      );
      continue;
    }

    attemptedAnyProvider = true;
    providersTried += 1;
    let providerHitRateLimit = false;

    if (providerIndex > 0 || (isPrimary && providerId !== aiProvider)) {
      console.warn(
        `[Provider Fallback] Switching to ${PROVIDERS[providerId]?.name || providerId} ` +
        `(${providerId}) with model "${entries[0].config.model}"...`
      );
    }

    const totalKeys = entries.length;

    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const { client, config } = entries[attempt];

      const requestOptions = {
        model: config.model,
        messages
      };

      if (jsonMode) {
        requestOptions.response_format = { type: 'json_object' };
      }

      try {
        const response = await client.chat.completions.create(requestOptions);
        const content = response.choices?.[0]?.message?.content;
        if (content == null || String(content).trim() === '') {
          throw new Error('AI returned an empty response.');
        }
        if (providerIndex > 0) {
          console.log(
            `[Provider Fallback] Succeeded with ${providerId} / ${config.model}`
          );
        }
        return content;
      } catch (err) {
        lastError = err;
        const { worthy, statusCode, reason } = isFallbackWorthyError(err);

        if (worthy) {
          if (statusCode === 429) providerHitRateLimit = true;

          if (attempt < totalKeys - 1) {
            const maskedKey = config.apiKey.length > 8
              ? config.apiKey.slice(0, 4) + '...' + config.apiKey.slice(-4)
              : '****';
            const waitMs = statusCode === 429
              ? getRetryAfterMs(err, 5000)
              : 2000;
            console.warn(
              `[Key Rotate] ${providerId} key ${attempt + 1}/${totalKeys} (${maskedKey}) ` +
              `failed (${reason}: ${statusCode}). Falling back to next key in ${Math.round(waitMs / 1000)}s...`
            );
            await pause(waitMs);
            continue;
          }

          console.warn(
            `[Provider Fallback] All ${totalKeys} key(s) for "${providerId}" exhausted ` +
            `(${reason}: ${statusCode}).`
          );
          await pause(statusCode === 429 ? getRetryAfterMs(err, 3000) : 2000);
          break; // next provider
        }

        // Fatal error (e.g. bad request for this model) — still try next provider
        // so a bad OpenRouter free model does not kill the whole migration.
        if (providerIndex < chain.length - 1) {
          console.warn(
            `[Provider Fallback] "${providerId}" failed with fatal error ` +
            `(${err.message || statusCode}). Trying next provider...`
          );
          await pause(1000);
          break;
        }

        throw err;
      }
    }

    if (providerHitRateLimit) rateLimitedProviders += 1;
  }

  if (!attemptedAnyProvider) {
    throw new Error(
      'No AI providers are configured. Set OPENROUTER_API_KEY and/or GENAI_API_KEY in server/.env ' +
      '(or enable Ollama with OLLAMA_ENABLED=true).'
    );
  }

  if (providersTried > 0 && rateLimitedProviders === providersTried) {
    throw new AllProvidersRateLimitedError(
      'All AI providers are rate-limited (HTTP 429). Wait a few minutes, add more API keys, ' +
      'or enable a local Ollama fallback (OLLAMA_ENABLED=true).',
      lastError
    );
  }

  throw lastError || new Error(
    'All AI providers failed. Configure at least one provider API key in server/.env.'
  );
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

/**
 * Final lock so package.json cannot drift to a different Angular major after AI/postprocess.
 */
function enforceAngularPackageVersions(destPath, stack) {
  if (!stack?.core) return;
  const pkgPath = path.join(destPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.devDependencies = pkg.devDependencies || {};
  const corePkgs = [
    '@angular/animations',
    '@angular/common',
    '@angular/compiler',
    '@angular/core',
    '@angular/forms',
    '@angular/platform-browser',
    '@angular/router'
  ];
  for (const name of corePkgs) {
    if (pkg.dependencies[name] || name === '@angular/core') {
      pkg.dependencies[name] = `^${stack.core}`;
    }
  }
  pkg.devDependencies['@angular/compiler-cli'] = `^${stack.core}`;
  pkg.devDependencies['@angular/build'] = `^${stack.tooling}`;
  pkg.devDependencies['@angular/cli'] = `^${stack.tooling}`;
  if (stack.typescript) pkg.devDependencies.typescript = stack.typescript;
  if (stack.zone) pkg.dependencies['zone.js'] = stack.zone;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  console.log(`[versions] Locked Angular package.json to ^${stack.core} (source=${stack.source})`);
}

function enforceReactPackageVersions(destPath, stack) {
  if (!stack?.react) return;
  const pkgPath = path.join(destPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.devDependencies = pkg.devDependencies || {};
  pkg.dependencies.react = `^${stack.react}`;
  pkg.dependencies['react-dom'] = `^${stack.react}`;
  pkg.devDependencies['@types/react'] = `^${stack.typesReact}`;
  pkg.devDependencies['@types/react-dom'] = `^${stack.typesReactDom}`;
  if (stack.vite) pkg.devDependencies.vite = `^${stack.vite}`;
  if (stack.pluginReact) pkg.devDependencies['@vitejs/plugin-react'] = `^${stack.pluginReact}`;
  if (stack.typescript) pkg.devDependencies.typescript = stack.typescript;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  console.log(`[versions] Locked React package.json to ^${stack.react} (source=${stack.source})`);
}

function injectAngularWorkspaceTemplates(destPath, versionStack = null) {
  // Keep all @angular/* packages on the same major line to avoid npm ERESOLVE conflicts.
  // Default = latest stable; override when user prompt names a version.
  const stack = versionStack || {
    core: '22.0.8',
    tooling: '22.0.7',
    typescript: '~6.0.3',
    zone: '~0.16.0'
  };
  const angularVersion = stack.core;
  const angularToolingVersion = stack.tooling;

  // 1. package.json - standalone bootstrap via @angular/build
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
      'zone.js': stack.zone || '~0.16.0'
    },
    devDependencies: {
      '@angular/build': `^${angularToolingVersion}`,
      '@angular/cli': `^${angularToolingVersion}`,
      '@angular/compiler-cli': `^${angularVersion}`,
      'autoprefixer': '^10.4.20',
      'postcss': '^8.4.49',
      'sass': '^1.83.0',
      'tailwindcss': '^3.4.17',
      'typescript': stack.typescript || '~6.0.3'
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
        schematics: {
          '@schematics/angular:component': {
            style: 'scss',
            standalone: true
          }
        },
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
              inlineStyleLanguage: 'scss',
              assets: [
                {
                  glob: '**/*',
                  input: 'public',
                  output: '/'
                }
              ],
              styles: ['src/styles.scss'],
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
              assets: [
                {
                  glob: '**/*',
                  input: 'public',
                  output: '/'
                }
              ],
              styles: ['src/styles.scss'],
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
      lib: ['ES2022', 'dom'],
      baseUrl: './',
      paths: {
        '@/*': ['src/*']
      }
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
      types: [],
      baseUrl: './',
      paths: {
        '@/*': ['src/*']
      }
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

  // 9. styles.scss + Tailwind / PostCSS configs
  const stylesScss = `@tailwind base;
@tailwind components;
@tailwind utilities;

/* Global app styles — prefer Tailwind utilities in templates */
`;
  fs.writeFileSync(path.join(destPath, 'src', 'styles.scss'), stylesScss);

  const tailwindConfig = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{html,ts,scss}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
`;
  fs.writeFileSync(path.join(destPath, 'tailwind.config.js'), tailwindConfig);

  const postcssConfig = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;
  fs.writeFileSync(path.join(destPath, 'postcss.config.js'), postcssConfig);

  // Remove legacy styles.css if a previous run left it behind
  const legacyStylesCss = path.join(destPath, 'src', 'styles.css');
  if (fs.existsSync(legacyStylesCss)) {
    try { fs.unlinkSync(legacyStylesCss); } catch { /* ignore */ }
  }

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
  ensureDirectoryExists(path.join(destPath, 'public'));
}

// ---------------------------------------------------------------------------
// React workspace template injection
// ---------------------------------------------------------------------------

function injectReactWorkspaceTemplates(destPath, versionStack = null) {
  // Default = latest stable React; override when user prompt names a version.
  const stack = versionStack || {
    react: '19.2.8',
    typesReact: '19.2.17',
    typesReactDom: '19.2.3',
    vite: '8.1.5',
    pluginReact: '6.0.4',
    typescript: '~5.9.2'
  };
  const packageJson = {
    name: 'migrated-react-project',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      start: 'vite',
      build: 'tsc -b && vite build',
      preview: 'vite preview'
    },
    dependencies: {
      'react': `^${stack.react}`,
      'react-dom': `^${stack.react}`
    },
    devDependencies: {
      '@types/react': `^${stack.typesReact}`,
      '@types/react-dom': `^${stack.typesReactDom}`,
      '@vitejs/plugin-react': `^${stack.pluginReact}`,
      'autoprefixer': '^10.4.20',
      'postcss': '^8.4.49',
      'sass': '^1.83.0',
      'tailwindcss': '^3.4.17',
      'typescript': stack.typescript || '~5.9.2',
      'vite': `^${stack.vite}`
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
      noFallthroughCasesInSwitch: true,
      baseUrl: '.',
      paths: {
        '@/*': ['src/*']
      }
    },
    include: ['src']
  };
  fs.writeFileSync(path.join(destPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

  // 3. vite.config.ts
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
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
import './index.scss';

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

  // 6. src/index.scss — Tailwind entry
  const indexScss = `@tailwind base;
@tailwind components;
@tailwind utilities;

/* Global app styles — prefer Tailwind utilities in components */
`;
  fs.writeFileSync(path.join(destPath, 'src', 'index.scss'), indexScss);

  const reactTailwindConfig = `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx,scss}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
`;
  fs.writeFileSync(path.join(destPath, 'tailwind.config.js'), reactTailwindConfig);

  const reactPostcssConfig = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;
  fs.writeFileSync(path.join(destPath, 'postcss.config.js'), reactPostcssConfig);

  const legacyIndexCss = path.join(destPath, 'src', 'index.css');
  if (fs.existsSync(legacyIndexCss)) {
    try { fs.unlinkSync(legacyIndexCss); } catch { /* ignore */ }
  }

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
import './index.scss';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
  fs.writeFileSync(mainTsxPath, normalizedMain, 'utf-8');

  const indexScssPath = path.join(srcDir, 'index.scss');
  if (!fs.existsSync(indexScssPath)) {
    fs.writeFileSync(
      indexScssPath,
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
      'utf-8'
    );
  }
  const legacyCss = path.join(srcDir, 'index.css');
  if (fs.existsSync(legacyCss) && fs.existsSync(indexScssPath)) {
    try { fs.unlinkSync(legacyCss); } catch { /* ignore */ }
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
  styleUrl: './app.component.scss'
})
export class AppComponent {}
`;
    fs.writeFileSync(componentTsPath, componentTs, 'utf-8');
  }

  const componentHtmlPath = path.join(srcAppDir, 'app.component.html');
  if (!fs.existsSync(componentHtmlPath)) {
    fs.writeFileSync(
      componentHtmlPath,
      `<main class="p-8 font-sans">\n  <h1 class="text-2xl font-semibold">Migration Complete</h1>\n  <p class="mt-2 text-gray-600">This is a generated Angular workspace. Replace this with migrated templates.</p>\n</main>\n`,
      'utf-8'
    );
  }

  const componentScssPath = path.join(srcAppDir, 'app.component.scss');
  if (!fs.existsSync(componentScssPath)) {
    fs.writeFileSync(componentScssPath, `/* Prefer Tailwind utilities in the template */\n`, 'utf-8');
  }
  const legacyCss = path.join(srcAppDir, 'app.component.css');
  if (fs.existsSync(legacyCss) && fs.existsSync(componentScssPath)) {
    try { fs.unlinkSync(legacyCss); } catch { /* ignore */ }
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
 *
 * IMPORTANT: Do NOT truncate after the first `export class` — many UI kits
 * put multiple @Component classes (Carousel + CarouselItem, etc.) in one file.
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

  // Only truncate at first-class-end when the remainder is clearly leaked HTML/CSS,
  // NOT when more TypeScript classes/directives follow.
  const classEnd = findExportedClassEndIndex(content);
  if (classEnd !== -1 && classEnd + 1 < cutAt) {
    const remainder = content.slice(classEnd + 1).trim();
    const hasMoreTs =
      /(?:^|\n)\s*(?:export\s+)?(?:class|function|const|type|interface|enum|@Component|@Directive|@Pipe|@Injectable)\b/.test(
        remainder
      );
    const looksLikeCssOrHtml =
      remainder.length > 0 &&
      !hasMoreTs &&
      (/(?:^|\n)\s*(?:\.[a-zA-Z_-]|<[a-zA-Z!/]|background-color\s*:|border-radius\s*:)/.test(remainder) ||
        /^(?:\.[a-zA-Z_-]|<[a-zA-Z!/])/.test(remainder));
    if (looksLikeCssOrHtml) {
      cutAt = Math.min(cutAt, classEnd + 1);
    }
  }

  let tsContent = content.slice(0, cutAt).trim();
  tsContent = tsContent.replace(/^\/\/\s*(?:src\/)?(?:app\/)?[\w./-]+\.ts\s*\n+/i, '');

  // Strip only LARGE inline templates/styles (AI HTML/CSS dumps). Keep short legitimate inlines
  // used by secondary components in the same file (e.g. template: '<ng-content />').
  tsContent = tsContent
    .replace(/template\s*:\s*`([\s\S]*?)`\s*,?/g, (full, body) => (body.length > 400 ? '' : full))
    .replace(/template\s*:\s*'([^']*)'\s*,?/g, (full, body) => (body.length > 400 ? '' : full))
    .replace(/template\s*:\s*"([^"]*)"\s*,?/g, (full, body) => (body.length > 400 ? '' : full))
    .replace(/styles\s*:\s*`([\s\S]*?)`\s*,?/g, (full, body) => (body.length > 200 ? '' : full))
    .replace(/styles\s*:\s*\[([\s\S]*?)\]\s*,?/g, (full, body) => (body.length > 200 ? '' : full));

  // Drop leaked CSS only when it appears AFTER the last TypeScript construct
  if (/(?:background-color|border-radius|box-shadow)\s*:/.test(tsContent) && /export\s+class/.test(tsContent)) {
    const lastClassStart = Math.max(
      ...[...tsContent.matchAll(/export\s+class\s+\w+/g)].map((m) => m.index ?? -1)
    );
    if (lastClassStart >= 0) {
      const afterLast = findExportedClassEndIndex(tsContent.slice(lastClassStart));
      if (afterLast !== -1) {
        const absEnd = lastClassStart + afterLast;
        const rem = tsContent.slice(absEnd + 1);
        if (rem && !/(?:export\s+|@Component|@Directive|@Injectable|type\s+|interface\s+)/.test(rem)) {
          tsContent = tsContent.slice(0, absEnd + 1);
        }
      }
    }
  }

  const expectedClass =
    baseName === 'app.component' || baseName === 'app'
      ? 'AppComponent'
      : (() => {
          const stem = baseName.replace(/\.component$/i, '');
          const pascal = stem
            .split(/[-_.\s]+/)
            .filter(Boolean)
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join('');
          return pascal.endsWith('Component') ? pascal : `${pascal}Component`;
        })();

  if (!/@Component\s*\(/.test(tsContent)) {
    tsContent = `import { Component } from '@angular/core';

@Component({
  selector: '${baseName === 'app.component' || baseName === 'app' ? 'app-root' : 'app-' + baseName.replace(/\.component$/i, '')}',
  standalone: true,
  templateUrl: './${baseName}.html',
  styleUrl: './${baseName}.scss'
})
export class ${expectedClass} {}
`;
  } else {
    // Only inject templateUrl/styleUrl on the FIRST @Component if entirely missing from file
    if (!tsContent.includes('templateUrl')) {
      tsContent = tsContent.replace(
        /(@Component\(\{)/,
        `$1\n  templateUrl: './${baseName}.html',`
      );
    }
    if (!tsContent.includes('styleUrl') && !tsContent.includes('styleUrls')) {
      tsContent = tsContent.replace(
        /(@Component\(\{)/,
        `$1\n  styleUrl: './${baseName}.scss',`
      );
    }
    if (!/\bstandalone\s*:/.test(tsContent)) {
      tsContent = tsContent.replace(/(@Component\(\{)/, `$1\n  standalone: true,`);
    }
    // Rename only the FIRST exported class (primary) when it's the generic AppComponent mistake
    const firstClassMatch = tsContent.match(/export\s+class\s+(\w+)/);
    if (firstClassMatch && (firstClassMatch[1] === 'AppComponent' || firstClassMatch[1] === 'App') && expectedClass !== 'AppComponent') {
      tsContent = tsContent.replace(/export\s+class\s+\w+/, `export class ${expectedClass}`);
    } else if (firstClassMatch && firstClassMatch[1] !== expectedClass) {
      // If the primary class name is clearly wrong vs filename (e.g. Component vs AvatarComponent)
      const primary = firstClassMatch[1];
      if (primary === 'Component' || primary === 'App' || primary === 'AppComponent') {
        tsContent = tsContent.replace(/export\s+class\s+\w+/, `export class ${expectedClass}`);
      }
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
 * Do not truncate after the first component when more exports follow.
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
  if (componentEnd !== -1 && componentEnd + 1 < cutAt) {
    const remainder = content.slice(componentEnd + 1).trim();
    const hasMoreTs =
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:function|const|class|type|interface)\b/.test(remainder);
    const looksLikeCssOrHtml =
      remainder.length > 0 &&
      !hasMoreTs &&
      (/(?:^|\n)\s*(?:\.[a-zA-Z_-]|<[a-zA-Z!/]|background-color\s*:)/.test(remainder) ||
        /^(?:\.[a-zA-Z_-]|<[a-zA-Z!/])/.test(remainder));
    if (looksLikeCssOrHtml) {
      cutAt = Math.min(cutAt, componentEnd + 1);
    }
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
  const altScss = path.join(appDir, 'app.scss');
  const componentTs = path.join(appDir, 'app.component.ts');
  const componentHtml = path.join(appDir, 'app.component.html');
  const componentScss = path.join(appDir, 'app.component.scss');

  if (!fs.existsSync(componentTs) && fs.existsSync(altTs)) {
    let altContent = fs.readFileSync(altTs, 'utf-8');
    altContent = altContent
      .replace(/templateUrl:\s*['"]\.\/app\.html['"]/g, "templateUrl: './app.component.html'")
      .replace(/styleUrl:\s*['"]\.\/app\.(css|scss)['"]/g, "styleUrl: './app.component.scss'")
      .replace(/styleUrls:\s*\[\s*['"]\.\/app\.(css|scss)['"]\s*\]/g, "styleUrls: ['./app.component.scss']")
      .replace(/export\s+class\s+App\b/g, 'export class AppComponent');
    fs.writeFileSync(componentTs, sanitizeAngularComponentTs(altContent, 'app.component'), 'utf-8');
  }
  if (!fs.existsSync(componentHtml) && fs.existsSync(altHtml)) {
    fs.copyFileSync(altHtml, componentHtml);
  }
  if (!fs.existsSync(componentScss)) {
    if (fs.existsSync(altScss)) fs.copyFileSync(altScss, componentScss);
    else if (fs.existsSync(altCss)) fs.copyFileSync(altCss, componentScss);
  }

  /** Recursively find every *.component.ts under src/ */
  function collectComponentTsFiles(dir, results = []) {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        collectComponentTsFiles(full, results);
      } else if (entry.name.endsWith('.component.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  const componentFiles = collectComponentTsFiles(path.join(destPath, 'src'));
  for (const tsPath of componentFiles) {
    const entryName = path.basename(tsPath);
    const baseName = entryName.replace(/\.ts$/, '');
    const dir = path.dirname(tsPath);
    const htmlPath = path.join(dir, `${baseName}.html`);
    const scssPath = path.join(dir, `${baseName}.scss`);
    const cssPath = path.join(dir, `${baseName}.css`);

    let tsContent = fs.readFileSync(tsPath, 'utf-8');
    // Force .scss styleUrl
    tsContent = tsContent
      .replace(/styleUrl\s*:\s*['"]([^'"]+)\.css['"]/g, "styleUrl: '$1.scss'")
      .replace(/styleUrls\s*:\s*\[\s*['"]([^'"]+)\.css['"]\s*\]/g, "styleUrls: ['$1.scss']");
    fs.writeFileSync(tsPath, sanitizeAngularComponentTs(tsContent, baseName), 'utf-8');

    if (!fs.existsSync(htmlPath)) {
      fs.writeFileSync(htmlPath, `<div class="${baseName}"></div>\n`, 'utf-8');
    }
    if (!fs.existsSync(scssPath)) {
      if (fs.existsSync(cssPath)) {
        fs.renameSync(cssPath, scssPath);
      } else {
        fs.writeFileSync(scssPath, `/* ${baseName} — prefer Tailwind utilities in the template */\n`, 'utf-8');
      }
    } else if (fs.existsSync(cssPath)) {
      try { fs.unlinkSync(cssPath); } catch { /* ignore */ }
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
 * @param {string} [options.aiProvider] - AI provider (e.g. 'openrouter', 'genai')
 * @param {string} [options.aiModel]    - AI model override
 * @returns {Promise<string>}         - Path to the final output ZIP
 */
export async function runMigrationPipeline(sourceZipPath, userPrompt, sessionId, options = {}) {
  const { fromTech = 'Unknown', toTech = 'Unknown', aiProvider = 'openrouter', aiModel } = options;
  const isSameFramework = (fromTech || '').toLowerCase() === (toTech || '').toLowerCase();

  // User-prompt version wins; otherwise latest stable (all conversion directions)
  const targetVersions = resolveTargetVersions(userPrompt, toTech);
  const versionMandate = formatVersionMandate(targetVersions);

  // Append the default strip-down / cross-framework prompt + version mandate
  const defaultSuffix = getDefaultPrompt(fromTech, toTech);
  const enhancedPrompt = `${userPrompt}\n\n${defaultSuffix}\n\n${versionMandate}`;

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
  const targetLower = (toTech || '').toLowerCase();
  if (targetLower.includes('angular')) {
    console.log(
      `[${sessionId}] Angular target version: ${targetVersions.angular.core} (${targetVersions.angular.source})`
    );
  } else if (targetLower.includes('react')) {
    console.log(
      `[${sessionId}] React target version: ${targetVersions.react.react} (${targetVersions.react.source})`
    );
  }

  // -----------------------------------------------------------------------
  // 2b. Inject workspace templates for known target frameworks
  // -----------------------------------------------------------------------
  if (targetLower.includes('angular')) {
    console.log(`[${sessionId}] Injecting Angular workspace templates...`);
    injectAngularWorkspaceTemplates(migrationWorkspacePath, targetVersions.angular);
  } else if (targetLower.includes('react')) {
    console.log(`[${sessionId}] Injecting React workspace templates...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath, targetVersions.react);
  }

  // -----------------------------------------------------------------------
  // 3. AGENT STEP 1: Generate migration blueprint
  // -----------------------------------------------------------------------
  console.log(`[${sessionId}] Stage 1: Building migration blueprint...`);

  const sameFrameworkInstruction = `
You are a code architect stripping down an Angular app to ONLY auth + dashboard.

RULES:
- KEEP ONLY: login, register, forgot-password, dashboard, auth service, guards, interceptors, core app shell.
- DELETE everything else: profile pages, CRUD tables, blog, about, settings, admin panels, demos.
- Route login as default, dashboard after login, protect with auth guard.
- Output ONLY raw JSON (no markdown, no backticks, no explanation).
- JSON format: { "migrationPlan": [{ "newPath": "src/app/...", "explanationOfSource": "...", "approximateSourceFilesToRead": ["..."] }] }
- Plan ONLY src/ files (components, services, styles). Do NOT plan config files (package.json, angular.json, tsconfig*.json, index.html).
- For Angular components, use templateUrl + styleUrl (NOT inline templates).
- The app must compile and run after stripping.
`;

  const crossFrameworkInstruction = `
You are a Principal Software Architect. Your task is to analyze an incoming source codebase and plan out a structural framework migration based on the user's demands.
Analyze the file directory structure. Provide an array mapping of target framework files that must be created from scratch to fully rebuild the app in the new architecture.
- If targeting Angular: convert React components into Angular Standalone Components. Create/update src/app/app.component.ts, src/app/app.component.html, src/app/app.component.scss, src/app/app.routes.ts, etc.
- If targeting React: convert Angular components into React functional components with hooks. DO NOT create tsconfig.app.json, angular.json, or any Angular-specific config files.
Your output must strictly be raw valid JSON. No markdown wrappers. The JSON must have a single top-level key "migrationPlan" whose value is an array of objects. Each object must have these keys: "newPath" (string), "explanationOfSource" (string), "approximateSourceFilesToRead" (array of strings).

IMPORTANT RULES FOR FILE GENERATION:
- For React projects: Only generate src/ files. Do NOT generate config files like package.json, tsconfig.json, vite.config.ts.
- For Angular projects: Only generate src/ files. Do NOT generate config files like package.json, tsconfig.json, angular.json.
- Focus ONLY on converting the actual application code (components, services, utilities).
- USER MIGRATION MANDATE IS HIGHEST PRIORITY: when the user specifies titles, colors, themes, branding, or copy changes, every planned UI file must reflect those exact values instead of copying the source project defaults.
- For Angular: app.component.ts must use templateUrl/styleUrl — put all markup in app.component.html and styles in app.component.scss. Never plan inline templates in the .ts file when an .html sibling exists.
- For Angular: EVERY component needs its own .ts + .html + .scss triad with matching names (e.g. avatar.component.ts / avatar.component.html / avatar.component.scss). Never share one template across components. Use Tailwind utility classes in HTML; keep SCSS minimal.
- Styling for ALL targets: Tailwind CSS in templates + SCSS files only (never .css).
- For Angular: plan src/lib/* utility ports (utils.ts, format.ts, mock-data.ts) when the React app uses @/lib/*.
- For React: plan src/lib/* when the Angular app has shared utilities.
- Prefer @if / @for / @switch control flow in Angular templates over *ngIf / *ngFor when practical.
- Do NOT invent non-existent packages (e.g. @radix-ng/*). Use Angular primitives, CDK patterns, or plain custom components instead.
- Map lucide-react icons to plain inline SVG markup in Angular (NO @lucide/angular / lucide-angular / lucide-react packages). Every icon must be a real <svg xmlns=...>...</svg> with Lucide paths. For React target keep lucide-react.
- For Angular: NEVER plan Lucide* imports, LucideIconModule, <lucide-*> tags, or <svg lucideXxx>. Plan inline SVG only.
- For Angular: every planned .html must have matching public/protected members on its .ts sibling; no React leftover cn()/className/return-in-template patterns unless the class exposes them.
- For Angular: routes import page components from their own files — never from app.component.ts.
`;

  const blueprintSystemInstruction = isSameFramework ? sameFrameworkInstruction : crossFrameworkInstruction;

  const blueprintPrompt = `
[CURRENT CODEBASE FILE TREE MAP]
${fileTree}

[CURRENT APPLICATION FILES SOURCE CODE]
${filesContextSummary}

[MIGRATION CORE MANDATE]
${enhancedPrompt}

[FROM TECH] ${fromTech}
[TO TECH] ${toTech}
${isSameFramework ? 'NOTE: Same framework — strip down, do NOT convert frameworks.' : ''}
`;

  let blueprintText;
  let parsedPlan;
  let targetFileList = null;

  // -----------------------------------------------------------------------
  // Try up to 3 approaches to generate the migration plan:
  //   Attempt 1: Full JSON mode (cloud models that support response_format)
  //   Attempt 2: Plain text asking for raw JSON (models that follow instructions)
  //   Attempt 3: Ultra-simple file list (small local models like 7B)
  // -----------------------------------------------------------------------
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 1) {
      console.log(`[${sessionId}] JSON mode failed. Retrying without JSON mode...`);
    } else if (attempt === 2) {
      console.log(`[${sessionId}] Structured JSON failed. Trying ultra-simple file list approach...`);
    }

    // For attempt 2 (small models), use a drastically simpler prompt
    const useJsonMode = attempt === 0;
    const useSimplePrompt = attempt === 2;

    const attemptInstruction = useSimplePrompt
      ? `You are analyzing an Angular project file tree.

From the FILE TREE below, list the files that should be KEPT for an app with ONLY:
- Auth (login, register, forgot-password)
- Dashboard
- Core app shell (App component, routing)
- Shared services (auth service, guards)

List each file on a new line, starting with "src/".
Example:
src/app/login/login.component.ts
src/app/dashboard/dashboard.component.ts
src/app/auth.service.ts

LIST ONLY THE FILE PATHS. No explanations. No JSON. No markdown.
Minimum 5 files. Include ALL related files for auth + dashboard.`
      : blueprintSystemInstruction;

    const attemptUserPrompt = useSimplePrompt
      ? `FILE TREE:
${fileTree}

USER REQUEST:
${enhancedPrompt}`
      : blueprintPrompt;

    try {
      blueprintText = await callLLM(attemptInstruction, attemptUserPrompt, useJsonMode, aiProvider, aiModel);
    } catch (err) {
      console.error(`[${sessionId}] Blueprint LLM call failed:`, err.message);
      // Don't burn rate-limited keys 3 more times with alternate prompt modes.
      if (err instanceof AllProvidersRateLimitedError || err?.status === 429) {
        throw new Error(
          `AI blueprint generation failed: all providers are rate-limited (429). ` +
          `Wait a few minutes and retry, add more keys, or set OLLAMA_ENABLED=true for local fallback.`
        );
      }
      if (attempt === 2) {
        throw new Error(`AI blueprint generation failed: ${err.message}.`);
      }
      continue;
    }

    console.log(`[${sessionId}] Raw blueprint response (first 2000 chars):`, blueprintText.substring(0, 2000));

    // Attempt to parse the response
    let success = false;

    // 1. Try parsing as structured JSON (attempts 0 and 1)
    if (!useSimplePrompt) {
      try {
        const cleaned = blueprintText.replace(/^```(?:json)?\n?/gm, '').replace(/\n?```$/gm, '').trim();
        parsedPlan = JSON.parse(cleaned);
        targetFileList = parsedPlan.migrationPlan;
        if (targetFileList && Array.isArray(targetFileList) && targetFileList.length > 0) {
          success = true;
        }
      } catch (_) {
        // Not valid JSON — fall through to next attempt
      }
    }

    // 2. Extract file paths from text using regex (works with simple list responses)
    if (!success) {
      const filePathRegex = /(?:src\/[\w./-]+\.(?:ts|html|css|scss|json))/g;
      const matches = blueprintText.match(filePathRegex);
      if (matches && matches.length > 0) {
        // Deduplicate
        const uniquePaths = [...new Set(matches)];
        // Auto-add sibling .html and .scss files for Angular component .ts files
        const withSiblings = new Set(uniquePaths);
        for (const p of uniquePaths) {
          if (p.endsWith('.component.ts')) {
            const base = p.slice(0, -3); // remove '.ts'
            withSiblings.add(base + '.html');
            withSiblings.add(base + '.scss');
          }
        }
        targetFileList = [...withSiblings].map(p => ({
          newPath: p,
          explanationOfSource: 'Kept file for auth+dashboard app',
          approximateSourceFilesToRead: []
        }));
        console.log(`[${sessionId}] Extracted ${targetFileList.length} file paths (${withSiblings.size} after adding component siblings) from AI response.`);
        success = true;
      }
    }

    if (success) break;
  }

  // If all attempts failed, throw a clear error
  if (!targetFileList || !Array.isArray(targetFileList) || targetFileList.length === 0) {
    console.error(`[${sessionId}] All blueprint generation attempts failed.`);
    console.error(`[${sessionId}] Last raw response:`, (blueprintText || '').substring(0, 1000));
    throw new Error(
      'The AI could not generate a migration plan. This usually happens with smaller local models. ' +
      'Try using a larger model (e.g. qwen2.5-coder:14b or gemini-2.0-flash) or provide a more specific prompt.'
    );
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
- If writing an Angular .html file: write ONLY HTML markup with Tailwind utility classes on elements. No TypeScript, no CSS/SCSS, no file path comments.
- If writing an Angular .scss (or legacy .css) file: write ONLY SCSS/CSS (complete rules with braces). Prefer empty/minimal SCSS — styling belongs in Tailwind classes in the HTML. No HTML, no TypeScript, no file path comments. Empty files must be a comment like /* component */.
- If writing a React Component: use functional components with hooks and TypeScript. Style with Tailwind className utilities; companion styles use .scss only.
- If writing a React .scss file: minimal SCSS only; prefer Tailwind in JSX.
- Write COMPLETE code. No placeholders, no truncation, no "..." shortcuts.
Respond ONLY with raw code for the single requested file. Do not output markdown code blocks (\`\`\`).
Do NOT concatenate multiple files. Do NOT add comments like "// src/app/app.component.html" or dump sibling file contents.

CRITICAL RULES:
0. USER PROMPT FIRST: obey the user's migration mandate exactly (titles, colors, themes, branding, scope). Do NOT hallucinate packages, exports, APIs, files, or features that are not real / not requested / not required by the source conversion.
1. You are ONLY generating source code files (components, styles, utilities). Configuration files like package.json, tsconfig.json, vite.config.ts, angular.json are ALREADY provided and should NOT be generated.
2. For React: The main App component MUST be at src/App.tsx (NOT src/app/app.tsx). Import it as 'import App from "./App"' (NOT './app/app').
3. For React: Use consistent file extensions - ALL files should be .tsx for TypeScript React projects.
4. DO NOT create Angular-style directory structures (src/app/ subdirectory) for React projects.
5. MANDATORY USER REQUIREMENTS override source defaults: if the user specifies titles, colors, theme values, or branding, apply those exact values in this file. Do NOT keep old source titles/colors when the user asked to change them.
6. For Angular components: use templateUrl and styleUrl in the .ts file. Put ALL HTML markup in the .html file (with Tailwind classes) and ALL leftover styles in the .scss file (styleUrl: './name.component.scss'). NEVER use .css, inline template, or styles property.
7. When sibling files for the same component were already generated, stay consistent with them (same title text, colors, and layout).
8. Output MUST contain only the contents of the single target file path you were asked to create.
9. Angular standalone components MUST set standalone: true. If the template uses *ngIf, *ngFor, ngClass, ngStyle, or async pipe, import CommonModule from '@angular/common' (NOT from '@angular/core') and list it in the @Component imports array. Prefer @if / @for built-in control flow when possible.
10. Class name MUST match the file: avatar.component.ts → export class AvatarComponent (never AppComponent unless the file is app.component.ts).
11. Import RxJS symbols (Subject, takeUntil, map, etc.) from 'rxjs' — never from '@angular/core'.
12. Import Input, Output, inject, Injectable, Component from '@angular/core'. Do not use import type for symbols passed to inject().
13. Use WritableSignal (from signal()) when calling .set(); plain Signal is read-only.
14. Getters are NOT callable in templates: use avatarClasses not avatarClasses(). Methods that need () must be real methods, not get accessors.
15. Do not reference private fields in templates — use protected or public.
16. Path alias @/ maps to src/ (e.g. import { cn } from '@/lib/utils'). Also emit the actual src/lib/*.ts files in the plan.
17. Convert lucide-react icons to plain inline <svg>…</svg> in Angular (NO @lucide/angular, lucide-angular, or lucide-react in Angular package.json). NEVER use <Home />, <lucide-home>, or <svg lucideHome>. Do NOT import @radix-ng/* or other invented packages.
18. app.component.ts must ONLY be the root shell component — never put ErrorHandler, provideHttpClient, or EnvironmentProviders inside a @Component.
19. app.config.ts / routing providers belong in src/app/app.config.ts and src/app/app.routes.ts only.
20. Self-closing custom elements are invalid in Angular templates: write proper open/close tags — never <Search /> for a component selector.
21. For React: do not leave Angular decorators, templateUrl, or @Component in output files.
22. Services use providedIn: 'root' (never 'server').
23. ALL LUCIDE ICONS → PLAIN INLINE SVG: FORBIDDEN in Angular: @lucide/angular, lucide-angular, lucide-react, LucideHome imports, <lucide-home>, <svg lucideHome>, [lucide]="...". REQUIRED: real <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ...><path .../></svg> with Lucide paths. NEVER put cn() in imports[].
24. Angular templates: no React leftovers, no arrow functions (=>), no TypeScript casts (as Foo) — use class methods and $any($event.target).value. No bare cn(...) unless the class has \`protected readonly cn = cn\`. No empty (click)="", no \`return\` / multi-statement JS in bindings — call one class method. No RenderFragment / IconDefinition / Input<T> property types. No Location.pathname (use Location.path()). No @import "tw-animate-css" in .scss. Child tags must match selector (app-*) and be in imports[].
25. Every template binding target (property/method) MUST be declared on the class as public or protected. Promote private members used by templates.
26. Do not declare a field and a getter with the same name (e.g. canScrollPrev).
27. Import HostListener from '@angular/core' when using @HostListener. Never import node:process in browser components.
28. embla-carousel: \`import EmblaCarousel, { EmblaOptionsType, EmblaCarouselType } from 'embla-carousel'\` — never named Embla / EmblaOptions / EmblaApi.
29. app.routes.ts must import AdminShellComponent (and other pages) from their real files, never from './app.component'. Always \`export const routes\`.
30. Form error checks: use errors?.['required'] / errors?.['minlength'] bracket access.
31. HTML must be balanced and complete — no truncated templates (Unexpected EOF).
32. TARGET VERSION: Obey the TARGET VERSION MANDATE block exactly. If the user prompt names Angular/React version → that version; else latest stable. Never write a different major into package.json. Follow best folder structure (Angular: app/core|shared|pages/{common,auth,admin}; React: components|features|hooks|lib|services) and high code quality.
33. Do NOT generate app.module.ts for modern Angular — standalone only. Child <app-*> components must be in the parent imports array.
34. STYLING MANDATE: All UI styling = Tailwind CSS utilities. All style files = .scss (never .css). Global: Angular src/styles.scss, React src/index.scss.
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
${enhancedPrompt}

[ALREADY GENERATED FILES IN THIS COMPONENT FOLDER]
${siblingContext || 'None yet — you are the first file for this component.'}

[ASSIGNMENT DIRECTIONS]
Create the complete code file content for: "${fileTarget.newPath}"
Purpose/Details: ${fileTarget.explanationOfSource}
${isSameFramework ? 'Keep the same framework (Angular). Strip down to essential auth + dashboard code.' : `Migration target framework: ${toTech}`}
Write ONLY this one file. No sibling file contents. No markdown fences.
`;

    let fileContent;
    try {
      fileContent = await callLLM(fileWriterSystemInstruction, individualFileWriterPrompt, false, aiProvider, aiModel);
    } catch (err) {
      console.error(`[${sessionId}] LLM call failed for ${fileTarget.newPath}:`, err.message);
      // Retry once
      await pause(10000);
      fileContent = await callLLM(fileWriterSystemInstruction, individualFileWriterPrompt, false, aiProvider, aiModel);
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
  const sourcePackageJson = (() => {
    const candidates = [
      path.join(baseSearchPath, 'package.json'),
      ...Object.keys(filesMap)
        .filter((f) => f.replace(/\\/g, '/').endsWith('package.json'))
        .map((f) => ({ rel: f, content: filesMap[f] }))
    ];
    if (fs.existsSync(candidates[0])) {
      try {
        return JSON.parse(fs.readFileSync(candidates[0], 'utf-8'));
      } catch {
        /* fall through */
      }
    }
    for (const item of candidates.slice(1)) {
      if (item && item.content) {
        try {
          return JSON.parse(item.content);
        } catch {
          /* continue */
        }
      }
    }
    return null;
  })();

  if (targetLower.includes('react')) {
    console.log(`[${sessionId}] Re-injecting React templates to ensure correct config files...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath, targetVersions.react);
    ensureReactRuntimeFiles(migrationWorkspacePath);
    console.log(`[${sessionId}] Running React post-generation repairs...`);
    repairReactWorkspace(migrationWorkspacePath, { sourcePackageJson });
    enforceReactPackageVersions(migrationWorkspacePath, targetVersions.react);
  } else if (targetLower.includes('angular')) {
    console.log(`[${sessionId}] Re-injecting Angular templates to ensure correct config files...`);
    injectAngularWorkspaceTemplates(migrationWorkspacePath, targetVersions.angular);
    ensureAngularRuntimeFiles(migrationWorkspacePath);
    normalizeAngularComponentFiles(migrationWorkspacePath);
    console.log(`[${sessionId}] Running Angular post-generation repairs...`);
    repairAngularWorkspace(migrationWorkspacePath, {
      sourceFilesMap: filesMap,
      sourcePackageJson
    });
    // Final lock: AI / postprocess must not drift away from resolved version
    enforceAngularPackageVersions(migrationWorkspacePath, targetVersions.angular);
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
