import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import AdmZip from 'adm-zip';
import OpenAI from 'openai';
import {
  IGNORED_FOLDERS,
  TEXT_EXTENSIONS,
  EXTRACT_DIR,
  PROVIDERS,
  getProviderConfigs,
  getProviderFallbackChain,
  getProviderFallbackModels,
  isProviderConfigured,
  isOllamaCloudMode,
  RATE_LIMIT_PAUSE_MS,
  MAX_BUILD_FIX_ATTEMPTS
} from '../config/index.js';
import { getDefaultPrompt, INCREMENTAL_BLUEPRINT_PROMPT } from '../config/defaultPrompt.js';
import { resolveTargetVersions, formatVersionMandate, LATEST_ANGULAR } from '../config/targetVersions.js';
import {
  webAngularNpmDeps,
  isWebAngularProtectedPath
} from '../config/webAngular.js';import { ensureDirectoryExists } from '../utils/file.js';
import { repairAngularWorkspace, repairReactWorkspace, ensureCnUtil } from './postprocess.js';

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
 * Fallback order (always on, innermost first):
 * 1. Model fallback — when a (key, model) pair crosses its limit, try the next
 *    free model on the SAME API key (e.g. Gemini 2.0 Flash → Flash-Lite).
 * 2. Key rotation — after all models on a key are exhausted, move to the next
 *    API key for the same provider (models restart from #1).
 * 3. Provider fallback — after all keys × models of a provider are exhausted,
 *    try the next configured provider in the chain using its own keys/models.
 *
 * Auth/quota errors (401/402) are key-level and skip model rotation entirely.
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

    // Only the user-selected provider uses the UI model; fallbacks use their own lists.
    const modelOverride = isPrimary && PROVIDERS[aiProvider] ? aiModel : undefined;
    // Model order: UI-selected model first, then free fallback models on the same key.
    const models = getProviderFallbackModels(providerId, modelOverride);

    const entries = createClients(providerId);

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
        `(${providerId}) — models: [${models.join(', ')}]`
      );
    }

    const totalKeys = entries.length;
    const totalModels = models.length;

    // No models configured (e.g. bad env override) — don't waste a "tried" count.
    if (totalModels === 0) {
      console.warn(
        `[Provider Fallback] Skipping "${providerId}" — no models configured.`
      );
      continue;
    }

    for (let keyIndex = 0; keyIndex < totalKeys; keyIndex++) {
      const { client, config } = entries[keyIndex];
      const maskedKey = config.apiKey.length > 8
        ? config.apiKey.slice(0, 4) + '...' + config.apiKey.slice(-4)
        : '****';

      for (let modelIndex = 0; modelIndex < totalModels; modelIndex++) {
        const model = models[modelIndex];

        const requestOptions = {
          model,
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
          if (providerIndex > 0 || keyIndex > 0 || modelIndex > 0) {
            console.log(
              `[Fallback] Succeeded with ${providerId} / ${model} ` +
              `(key ${keyIndex + 1}/${totalKeys}, model ${modelIndex + 1}/${totalModels})`
            );
          }
          return content;
        } catch (err) {
          lastError = err;
          const { statusCode, reason } = isFallbackWorthyError(err);

          // Key-level failures (bad/missing auth, exhausted billing quota) —
          // no model change can fix these, so skip straight to the next key.
          if (statusCode === 401 || statusCode === 402) {
            console.warn(
              `[Key Rotate] ${providerId} key ${keyIndex + 1}/${totalKeys} (${maskedKey}) ` +
              `failed (${reason}: ${statusCode}). Moving to next key...`
            );
            await pause(2000);
            break; // next key (model rotation restarts from #1)
          }

          if (statusCode === 429) providerHitRateLimit = true;

          // Limit crossed for THIS (key, model) pair → try the next free model
          // on the same API key before touching other keys/providers.
          if (modelIndex < totalModels - 1) {
            const waitMs = statusCode === 429 ? getRetryAfterMs(err, 5000) : 1000;
            console.warn(
              `[Model Rotate] ${providerId} key ${keyIndex + 1}/${totalKeys} (${maskedKey}) ` +
              `model ${modelIndex + 1}/${totalModels} "${model}" failed (${reason}: ${statusCode}). ` +
              `Trying next free model in ${Math.round(waitMs / 1000)}s...`
            );
            await pause(waitMs);
            continue; // next model, same key
          }

          // All models on this key are exhausted → try the next API key.
          if (keyIndex < totalKeys - 1) {
            console.warn(
              `[Key Rotate] ${providerId} key ${keyIndex + 1}/${totalKeys} (${maskedKey}) — ` +
              `all ${totalModels} model(s) exhausted (${reason}: ${statusCode}). Trying next key...`
            );
            await pause(statusCode === 429 ? getRetryAfterMs(err, 3000) : 1000);
            break; // next key
          }

          // Every key × model for this provider is exhausted → next provider.
          console.warn(
            `[Provider Fallback] All ${totalKeys} key(s) × ${totalModels} model(s) for ` +
            `"${providerId}" exhausted (${reason}: ${statusCode}).`
          );
          await pause(statusCode === 429 ? getRetryAfterMs(err, 3000) : 1000);
          break; // next provider
        }
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
 * Extract source paths mentioned in Angular/Vite build error output.
 */
function extractPathsFromBuildErrors(buildErrors) {
  const text = String(buildErrors || '');
  const matches = text.match(/src\/[\w./-]+\.(?:ts|tsx|html|scss|css|jsx)/g) || [];
  return [...new Set(matches.map((p) => p.replace(/\\/g, '/')))];
}

/**
 * Map AI-suggested fix paths onto real workspace files.
 * Common failure: AI writes src/admin/... while the real file is src/app/admin/...
 *
 * When `allowBasenameFallback` is false (rework edits), the resolver only maps
 * prefix-normalized exact paths — it never silently redirects to a different
 * existing file that merely shares the same basename.
 */
function resolveFixWritePath(workspaceRoot, requestedPath, buildErrors = '', allowBasenameFallback = true) {
  if (!requestedPath || typeof requestedPath !== 'string') return null;

  let normalized = requestedPath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.?\//, '')
    .replace(/^(migrated-(?:angular|react)-project\/)+/i, '');

  const remapPrefixes = [
    [/^src\/admin\//i, 'src/app/admin/'],
    [/^src\/pages\//i, 'src/app/pages/'],
    [/^src\/core\//i, 'src/app/core/'],
    [/^src\/shared\//i, 'src/app/shared/'],
    [/^src\/store\//i, 'src/app/store/'],
    [/^src\/config\//i, 'src/app/config/'],
    [/^admin\//i, 'src/app/admin/'],
    [/^pages\//i, 'src/app/pages/'],
    [/^app\//i, 'src/app/']
  ];
  for (const [re, replacement] of remapPrefixes) {
    if (re.test(normalized)) {
      normalized = normalized.replace(re, replacement);
      break;
    }
  }

  const errorPaths = extractPathsFromBuildErrors(buildErrors);
  const base = path.posix.basename(normalized);
  const errorMatch = errorPaths.find((p) => path.posix.basename(p) === base);
  if (errorMatch) {
    normalized = errorMatch;
  } else if (allowBasenameFallback && !fs.existsSync(path.join(workspaceRoot, normalized))) {
    // Fall back to any existing file with the same basename under src/
    const srcRoot = path.join(workspaceRoot, 'src');
    if (fs.existsSync(srcRoot)) {
      const found = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name === base) found.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
        }
      };
      try { walk(srcRoot); } catch { /* ignore */ }
      if (found.length === 1) normalized = found[0];
      else if (found.length > 1) {
        const preferApp = found.find((p) => p.includes('/app/')) || found[0];
        normalized = preferApp;
      }
    }
  }

  return resolveSafeWritePath(workspaceRoot, normalized);
}

/**
 * True when build output looks like truncated / invalid TypeScript syntax
 * (not a missing import or type mismatch).
 */
function isSyntaxHeavyBuildFailure(buildErrors) {
  const text = String(buildErrors || '');
  return /TS1005|TS1109|TS1128|TS1131|TS1003|TS2695|Unexpected EOF|Expression expected/i.test(text);
}

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

  // web_angular template kit — AI must not overwrite injected shared/core assets
  if (isWebAngularProtectedPath(normalized)) {
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
 * Core framework packages track stack.core exactly; Material/CDK use major-aligned ranges
 * (their patch lines often differ from @angular/core and pinning ^21.2.18 causes ETARGET).
 */
/**
 * Final lock so package.json cannot drift to a different Angular major after
 * AI/postprocess. Rewrites @angular/* core packages to stack.core, the
 * web_angular kit deps to major-scaled ranges, and dev tooling to the stack.
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
  const major = parseInt(String(stack.core).split('.')[0], 10) || 22;

  // Core framework packages — pinned EXACT to stack.core so npm never picks
  // mismatched pairs (compiler-cli peers @angular/compiler with the exact same
  // version, e.g. compiler-cli@22.1.1 requires compiler@22.1.1).
  const corePkgs = [
    '@angular/animations',
    '@angular/common',
    '@angular/compiler',
    '@angular/core',
    '@angular/forms',
    '@angular/platform-browser',
    '@angular/platform-browser-dynamic',
    '@angular/router'
  ];
  for (const name of corePkgs) {
    if (pkg.dependencies[name] || name === '@angular/core') {
      pkg.dependencies[name] = stack.core;
    }
  }

  // web_angular kit deps (major-scaled)
  const kit = webAngularNpmDeps(stack.core);
  for (const [name, version] of Object.entries(kit.dependencies)) {
    pkg.dependencies[name] = version;
  }

  // Runtime essentials from the template
  if (stack.zone) pkg.dependencies['zone.js'] = stack.zone;
  if (!pkg.dependencies.rxjs) pkg.dependencies.rxjs = '~7.8.0';
  if (!pkg.dependencies.tslib) pkg.dependencies.tslib = '^2.3.0';
  if (!pkg.dependencies['normalize.css']) pkg.dependencies['normalize.css'] = '^8.0.1';

  // Tooling
  if (stack.tooling) {
    pkg.devDependencies['@angular-devkit/build-angular'] = `^${stack.tooling}`;
    pkg.devDependencies['@angular/cli'] = `^${stack.tooling}`;
  }
  pkg.devDependencies['@angular/compiler-cli'] = stack.core;
  if (stack.typescript) pkg.devDependencies.typescript = stack.typescript;
  pkg.devDependencies['angular-eslint'] = `^${Math.max(major, 15)}.0.0`;

  // typescript-eslint peer-caps TypeScript; template pins 8.33.1 (<5.9.0).
  // Scale so the resolved TypeScript line is accepted by npm ci:
  //   Angular <=19 (TS ~5.7)  -> 8.33.1 (template default) is fine
  //   Angular 20/21 (TS ~5.9) -> >= 8.41.0 (peer <6.0.0)
  //   Angular 22+ (TS ~6.0)   -> >= 8.60.0 (peer <6.1.0)
  if (major >= 22) {
    pkg.devDependencies['typescript-eslint'] = '^8.60.0';
  } else if (major >= 20) {
    pkg.devDependencies['typescript-eslint'] = '^8.41.0';
  }

  // Ensure template runtime deps that may have been dropped by postprocess
  for (const name of ['moment', 'crypto-js', 'bowser', 'lru-cache']) {
    if (!pkg.dependencies[name] && kit.dependencies[name]) {
      pkg.dependencies[name] = kit.dependencies[name];
    }
  }

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  console.log(
    `[versions] Locked Angular package.json to ^${stack.core} (source=${stack.source}); web_angular kit major-aligned`
  );
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

// ---------------------------------------------------------------------------
// Angular workspace template injection (from server/web_angular)
// ---------------------------------------------------------------------------

const WEB_ANGULAR_TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'web_angular');

/** Folders never copied from the web_angular template. */
const TEMPLATE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.angular']);

/**
 * Files never copied from the web_angular template.
 * package-lock.json pins the template's own Angular 19 versions — it must be
 * regenerated from the scaled package.json (npm ci errors otherwise).
 */
const TEMPLATE_SKIP_FILES = new Set(['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml']);

/**
 * Recursively copy the web_angular template into destPath.
 */
function copyWebAngularTemplate(destPath) {
  const src = WEB_ANGULAR_TEMPLATE_DIR;
  if (!fs.existsSync(src)) {
    throw new Error(
      `web_angular template directory not found at ${src}. ` +
        'The server/web_angular folder is required to create new Angular projects.'
    );
  }
  ensureDirectoryExists(destPath);
  const walk = (from, to) => {
    ensureDirectoryExists(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (TEMPLATE_SKIP_DIRS.has(entry.name) || TEMPLATE_SKIP_FILES.has(entry.name) || entry.name.startsWith('.')) continue;
      const srcFull = path.join(from, entry.name);
      const destFull = path.join(to, entry.name);
      if (entry.isDirectory()) {
        walk(srcFull, destFull);
      } else {
        ensureDirectoryExists(path.dirname(destFull));
        fs.copyFileSync(srcFull, destFull);
      }
    }
  };
  walk(src, destPath);
  console.log(`[web_angular] Copied template → ${destPath}`);
}

function toSafeProjectName(name, fallback = 'migrated-angular-project') {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 50);
  return n || fallback;
}

function humanizeProjectName(name) {
  const n = toSafeProjectName(name, 'Migrated Angular Project');
  return n
    .replace(/[-_.]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function lightenHex(hex, amount = 0.55) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const to2 = (c) => c.toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

const NAMED_DESIGN_COLORS = {
  blue: '#0788C0', sky: '#0EA5E9', cyan: '#06B6D4', teal: '#14B8A6',
  emerald: '#10B981', green: '#22C55E', lime: '#84CC16', amber: '#F59E0B',
  orange: '#F97316', red: '#EF4444', rose: '#F43F5E', pink: '#EC4899',
  fuchsia: '#D946EF', purple: '#A855F7', violet: '#8B5CF6', indigo: '#6366F1',
  slate: '#64748B', gray: '#6B7280', navy: '#1D2A54', gold: '#C9A227'
};

/**
 * Extract base design colors from the user prompt. Returns
 * { primary, secondary, tertiary } hex values (template defaults when the
 * prompt does not name colors).
 */
function extractDesignColors(userPrompt) {
  const text = String(userPrompt || '');
  const hexRe = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  const hexes = [...new Set([...text.matchAll(hexRe)].map((m) => '#' + m[1].toLowerCase()))];
  const defaults = { primary: '#0788C0', secondary: '#1D2A54', tertiary: '#C1E1EF' };
  const roles = ['primary', 'secondary', 'tertiary'];
  const result = {};
  const usedHex = new Set();
  const usedName = new Set();

  const hexOf = (v) => (v && v.startsWith('#')) ? v : NAMED_DESIGN_COLORS[v] || null;

  // 1. Role-tagged mentions: "primary color blue", "secondary: #123456"
  for (const role of roles) {
    const re = new RegExp(
      `\\b${role}\\b[^\\n]{0,45}?(?:color|colour)?[^\\n]{0,10}?(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b|(${Object.keys(NAMED_DESIGN_COLORS).join('|')}))`,
      'i'
    );
    const m = text.match(re);
    if (m) {
      const value = m[1] ? m[1].toLowerCase() : m[2].toLowerCase();
      const hex = hexOf(value);
      if (hex) {
        result[role] = hex;
        usedHex.add(hex);
        if (!m[1]) usedName.add(m[2].toLowerCase());
      }
    }
  }

  // 2. Bare hex codes fill remaining roles in order
  for (const role of roles) {
    if (result[role]) continue;
    const next = hexes.find((h) => !usedHex.has(h));
    if (next) {
      result[role] = next;
      usedHex.add(next);
    }
  }

  // 3. Bare color-name words fill remaining roles
  for (const role of roles) {
    if (result[role]) continue;
    const named = Object.keys(NAMED_DESIGN_COLORS).find(
      (name) => !usedName.has(name) && new RegExp(`\\b${name}\\b`, 'i').test(text)
    );
    if (named) {
      result[role] = NAMED_DESIGN_COLORS[named];
      usedName.add(named);
    }
  }

  for (const role of roles) result[role] = result[role] || defaults[role];
  return result;
}

/**
 * Extract a project name from the user prompt; falls back to the source
 * package.json name, then a safe default.
 */
function extractProjectName(userPrompt, sourcePackageJson) {
  const text = String(userPrompt || '');
  const nameRe =
    /(?:project|app)\s+(?:name|called|named|titled|is)\s*[:\-]?\s*['"]?([A-Za-z0-9][A-Za-z0-9 _\-.]{1,40})/i;
  const nameItRe =
    /(?:name|call)\s+(?:it|this|the\s+project|the\s+app)\s+['"]?([A-Za-z0-9][A-Za-z0-9 _\-.]{1,40})/i;
  let name = null;
  for (const re of [nameRe, nameItRe]) {
    const m = text.match(re);
    if (m) {
      name = m[1].trim();
      break;
    }
  }
  if (name) return toSafeProjectName(name);
  const srcName =
    sourcePackageJson && typeof sourcePackageJson.name === 'string'
      ? sourcePackageJson.name.trim()
      : '';
  if (srcName && !/^(angular|react|my-app|demo|test|app|project|frontend|web)$/i.test(srcName)) {
    return toSafeProjectName(srcName);
  }
  return 'migrated-angular-project';
}

/**
 * Customize the copied template: project name, base design colors, titles.
 * Versions are locked separately by enforceAngularPackageVersions().
 */
function applyAngularTemplateCustomizations(destPath, options) {
  const { projectName = 'migrated-angular-project', designColors = {} } = options;
  const humanName = humanizeProjectName(projectName);

  // package.json: name (+ drop husky "prepare" so `npm ci` never needs a git repo)
  const pkgPath = path.join(destPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      pkg.name = projectName;
      if (pkg.scripts && typeof pkg.scripts.prepare === 'string') {
        delete pkg.scripts.prepare;
      }
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  // angular.json: project key + outputPath + buildTargets
  const angularJsonPath = path.join(destPath, 'angular.json');
  if (fs.existsSync(angularJsonPath)) {
    try {
      const raw = fs.readFileSync(angularJsonPath, 'utf-8');
      const normalized = raw.replace(/migrated-angular-project/g, projectName);
      fs.writeFileSync(angularJsonPath, `${normalized}\n`, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  // index.html title + favicon references
  const indexHtmlPath = path.join(destPath, 'src', 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    let html = fs.readFileSync(indexHtmlPath, 'utf-8');
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${humanName}</title>`);
    html = html.replace(/demo-admin-favicon/g, `${projectName}-favicon`);
    fs.writeFileSync(indexHtmlPath, html, 'utf-8');
  }

  // favicon copy
  const faviconSrc = path.join(WEB_ANGULAR_TEMPLATE_DIR, 'public', 'favicon', 'demo-admin-favicon.svg');
  const faviconDestDir = path.join(destPath, 'public', 'favicon');
  if (fs.existsSync(faviconSrc)) {
    ensureDirectoryExists(faviconDestDir);
    fs.copyFileSync(faviconSrc, path.join(faviconDestDir, `${projectName}-favicon.svg`));
    try {
      fs.unlinkSync(path.join(faviconDestDir, 'demo-admin-favicon.svg'));
    } catch {
      /* ignore */
    }
  }

  // app.component.ts title
  const appTsPath = path.join(destPath, 'src', 'app', 'app.component.ts');
  if (fs.existsSync(appTsPath)) {
    let ts = fs.readFileSync(appTsPath, 'utf-8');
    ts = ts.replace(
      /public\s+title\s*=\s*['"][^'"]*['"]/,
      `public title = '${humanName.replace(/'/g, "\\'")}';`
    );
    fs.writeFileSync(appTsPath, ts, 'utf-8');
  }

  // app.component.html loading-bar color → primary.
  // Template uses a quoted TS string literal: [color]="'#0788C0'". Keep both
  // the outer attribute quotes and the inner literal quotes when replacing.
  const appHtmlPath = path.join(destPath, 'src', 'app', 'app.component.html');
  if (fs.existsSync(appHtmlPath) && designColors.primary) {
    let html = fs.readFileSync(appHtmlPath, 'utf-8');
    html = html.replace(
      /(\[color\]=\s*['"])(['"]?)(#?[0-9a-fA-F]{3,8})(['"]?)(['"])/,
      (m, open, inner1, hex, inner2, close) =>
        `${open}${inner1}${designColors.primary}${inner2}${close}`
    );
    fs.writeFileSync(appHtmlPath, html, 'utf-8');
  }

  // config/app-settings.config.ts appTitle
  const settingsPath = path.join(destPath, 'src', 'app', 'config', 'app-settings.config.ts');
  if (fs.existsSync(settingsPath)) {
    let ts = fs.readFileSync(settingsPath, 'utf-8');
    ts = ts.replace(
      /appTitle\s*:\s*['"][^'"]*['"]/,
      `appTitle: '${humanName.replace(/'/g, "\\'")}'`
    );
    fs.writeFileSync(settingsPath, ts, 'utf-8');
  }

  // tailwind.config.js base colors
  const twPath = path.join(destPath, 'tailwind.config.js');
  if (fs.existsSync(twPath) && (designColors.primary || designColors.secondary || designColors.tertiary)) {
    let tw = fs.readFileSync(twPath, 'utf-8');
    if (designColors.primary) {
      tw = tw.replace(
        /primary:\s*\{[^}]*\}/,
        `primary: {\n        DEFAULT: '${designColors.primary}',\n        100: '${lightenHex(designColors.primary)}',\n      }`
      );
    }
    if (designColors.secondary) {
      tw = tw.replace(
        /secondary:\s*\{[^}]*\}/,
        `secondary: {\n        DEFAULT: '${designColors.secondary}',\n        100: '${lightenHex(designColors.secondary)}',\n      }`
      );
    }
    if (designColors.tertiary) {
      tw = tw.replace(
        /tertiary:\s*\{[^}]*\}/,
        `tertiary: {\n        DEFAULT: '${designColors.tertiary}',\n      }`
      );
    }
    fs.writeFileSync(twPath, tw, 'utf-8');
  }
}

/**
 * Copy the whole web_angular template into the migration workspace and apply
 * the only allowed customizations: target version, project name, base colors.
 * Every other template file (shared kit, core services, store, layouts, scss
 * design system, environments, configs) is kept as-is.
 */
function injectAngularWorkspaceTemplates(destPath, versionStack = null, options = {}) {
  const stack = versionStack || LATEST_ANGULAR;
  const { projectName = 'migrated-angular-project', designColors = {} } = options;

  copyWebAngularTemplate(destPath);
  applyAngularTemplateCustomizations(destPath, { projectName, designColors });
  enforceAngularPackageVersions(destPath, stack);

  // Ensure the Angular app structure folders exist (template already provides them)
  ensureDirectoryExists(path.join(destPath, 'src', 'app'));
  ensureDirectoryExists(path.join(destPath, 'public'));
  ensureDirectoryExists(path.join(destPath, 'public', 'scss'));
}

/**
 * Restore pristine template root/config files after AI generation (pipeline
 * step 4b) so the delivered project always ships with the exact web_angular
 * tooling. Re-applies project name / colors / version customizations.
 * src/app/pages + src/app/core + src/app/shared + src/app/store are NEVER
 * touched here — the AI owns the feature pages, the template owns the kit.
 */
function restoreAngularRootConfigs(destPath, stack, options = {}) {
  const { projectName = 'migrated-angular-project', designColors = {} } = options;
  const rootFiles = [
    'package.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json',
    'tsconfig.spec.json', 'tailwind.config.js', 'eslint.config.js', '.prettierrc',
    '.gitignore', '.editorconfig', '.husky/pre-commit'
  ];
  for (const rel of rootFiles) {
    const src = path.join(WEB_ANGULAR_TEMPLATE_DIR, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destPath, rel);
    ensureDirectoryExists(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  for (const rel of ['src/index.html', 'src/main.ts', 'src/styles.scss', 'src/app/app.config.ts']) {
    const src = path.join(WEB_ANGULAR_TEMPLATE_DIR, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destPath, rel);
    ensureDirectoryExists(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  applyAngularTemplateCustomizations(destPath, { projectName, designColors });
  enforceAngularPackageVersions(destPath, stack);
  console.log('[web_angular] Restored pristine root config files + customizations');
}

// ---------------------------------------------------------------------------
// Token-efficient source reading (only essential files for a web_angular app)
// ---------------------------------------------------------------------------

const ESSENTIAL_STOPLIST = new Set([
  'list', 'form', 'edit', 'add', 'detail', 'view', 'index', 'route', 'routes',
  'service', 'component', 'app', 'page', 'pages', 'home', 'login', 'dashboard',
  'common', 'config', 'data', 'model', 'type', 'types', 'utils', 'util',
  'helper', 'const', 'constants', 'styles', 'style', 'test', 'spec', 'main',
  'shared', 'core', 'store', 'layout', 'auth'
]);

/**
 * Keep only the source files that are essential to functionalize a
 * web_angular-style app (auth + dashboard + shell + shared plumbing). Feature
 * pages that are NOT auth/dashboard related are dropped to save tokens.
 */
function filterEssentialSourceFiles(filesMap, userPrompt = '') {
  const promptLower = String(userPrompt || '').toLowerCase();
  const result = {};
  for (const [rel, content] of Object.entries(filesMap)) {
    const n = rel.replace(/\\/g, '/');
    if (isEssentialSourcePath(n, promptLower)) {
      result[rel] = content;
    }
  }
  // Never strip everything — fall back to the full map if the filter was too aggressive
  if (Object.keys(result).length === 0) return filesMap;
  return result;
}

function isEssentialSourcePath(n, promptLower) {
  // Root-level config / tooling files (small, always useful)
  if (!n.startsWith('src/')) return true;

  // Assets are never source code
  if (/^src\/assets\//.test(n)) return false;

  // Entry points + global styles
  if (/^src\/(main|app|index|styles|polyfills|test|environments)\b/.test(n)) return true;
  if (n.includes('/environments/')) return true;

  // Shared plumbing / framework folders (services, stores, guards, libs, …)
  if (
    /\/(core|shared|common|store|state|models?|types|interfaces|interceptors?|guards?|http|api|services?|lib|hooks?|utils?|helpers?|constants?|configs?|context|validators?|pipes?|directives?|animations?|data|assets|theme)\//.test(n)
  ) {
    return true;
  }

  // Auth + dashboard related features
  if (
    /\/(auth|login|register|signin|signup|sign-in|sign-up|forgot|reset|otp|password|credential|token|account|profile|logout)\//.test(n)
  ) {
    return true;
  }
  if (
    /\/(dashboard|home|overview|analytics|shell|layout|sidebar|header|navbar|topbar|footer|sidenav)\//.test(n)
  ) {
    return true;
  }

  // Loose src-root files
  if (!n.includes('/')) return true;

  // Feature files whose basename is explicitly mentioned in the user prompt
  const base = (n.split('/').pop() || '')
    .replace(/\.(ts|tsx|js|jsx|html|scss|css|json)$/i, '')
    .replace(/\.component$|\.service$|\.page$|\.view$/i, '')
    .toLowerCase();
  if (base.length > 3 && !ESSENTIAL_STOPLIST.has(base) && promptLower.includes(base)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Final npm ci sanity check
// ---------------------------------------------------------------------------

/**
 * Verify the delivered project installs and builds from a clean `npm ci`
 * (the exact command a user will run on the downloaded ZIP). Regenerates the
 * lock file first when missing or out of sync, then runs `npm ci` + build.
 * Returns { ok: boolean, errors: string }.
 */
async function verifyNpmCiBuild(workspacePath, targetTech, sessionId) {
  const isAngular = String(targetTech).toLowerCase().includes('angular');
  const buildCmd = isAngular ? 'npx' : 'npm';
  const buildArgs = isAngular ? ['ng', 'build'] : ['run', 'build'];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const lockPath = path.join(workspacePath, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      console.log(`[${sessionId}] npm ci check: no package-lock.json — generating via npm install...`);
      // NOTE: no --prefer-offline — stale cached packuments cause ETARGET for
      // recently published versions (e.g. Angular 22 patch lines).
      const gen = await runCommand('npm', ['install'], workspacePath, 300000);
      if (gen.exitCode !== 0) {
        return {
          ok: false,
          errors: `npm install (lock generation) failed:\n${(gen.stderr || gen.stdout || '').slice(-2000)}`
        };
      }
    }

    console.log(`[${sessionId}] npm ci check (attempt ${attempt}/2): npm ci ...`);
    const ci = await runCommand('npm', ['ci'], workspacePath, 300000);
    if (ci.exitCode !== 0) {
      const errOut = (ci.stderr || ci.stdout || '').slice(-1500);
      console.error(`[${sessionId}] npm ci failed (attempt ${attempt}):\n${errOut}`);
      if (attempt === 1) {
        // Out-of-sync lock (postprocess may have touched package.json) — regen + retry
        const regen = await runCommand('npm', ['install'], workspacePath, 300000);
        if (regen.exitCode !== 0) {
          return {
            ok: false,
            errors: `npm ci failed, lock regeneration also failed:\n${errOut}\n${(regen.stderr || regen.stdout || '').slice(-1500)}`
          };
        }
        continue;
      }
      return { ok: false, errors: `npm ci failed:\n${errOut}` };
    }

    console.log(`[${sessionId}] npm ci succeeded. Running ${buildCmd} ${buildArgs.join(' ')}...`);
    const build = await runCommand(buildCmd, buildArgs, workspacePath, 300000);
    if (build.exitCode === 0) {
      console.log(`[${sessionId}] npm ci + build ✅ PASSED`);
      return { ok: true, errors: '' };
    }
    const buildErr = (build.stderr || build.stdout || '').slice(-2500);
    console.error(`[${sessionId}] npm ci build failed:\n${buildErr}`);
    return { ok: false, errors: `npm ci build failed:\n${buildErr}` };
  }

  return { ok: false, errors: 'npm ci verification exhausted retries.' };
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

// ---------------------------------------------------------------------------
// Angular helpers (web_angular template kit)
// ---------------------------------------------------------------------------

/**
 * Write a file only when missing so AI-generated auth/services can replace stubs.
 */
function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  ensureDirectoryExists(path.dirname(filePath));
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  return true;
}

/**
 * Ensure app.config.ts wires the web_angular interceptors + NGXS store.
 * The template ships a complete app.config.ts, so this only creates a file
 * when it is missing (never overwrites a working config).
 */
function ensureAngularAppConfigUsesWebAngular(destPath) {
  const appConfigPath = path.join(destPath, 'src', 'app', 'app.config.ts');
  if (fs.existsSync(appConfigPath)) {
    const existing = fs.readFileSync(appConfigPath, 'utf-8');
    if (/provideStore\s*\(/.test(existing) && /withInterceptors\s*\(/.test(existing)) {
      return;
    }
  }

  const kitConfig = `import {
  httpErrorInterceptorFn,
  httpAuthHeaderInterceptorFn,
  httpSuccessHandlerInterceptorFn,
} from './core/interceptors';
import { routes } from './app.routes';
import { provideStore } from '@ngxs/store';
import { provideToastr } from 'ngx-toastr';
import { PreloadAllModules, provideRouter, withPreloading } from '@angular/router';
import { environment } from '../environments/environment';
import { withNgxsLoggerPlugin } from '@ngxs/logger-plugin';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { ApplicationConfig, importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { AppState } from './store';

const STATES = [AppState];

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    provideAnimationsAsync(),
    importProvidersFrom(),
    provideHttpClient(
      withInterceptors([
        httpErrorInterceptorFn,
        httpAuthHeaderInterceptorFn,
        httpSuccessHandlerInterceptorFn,
      ]),
    ),
    provideToastr({
      timeOut: 3000,
      closeButton: true,
      positionClass: 'toast-top-right',
    }),
    provideStore([...STATES], withNgxsLoggerPlugin({ disabled: environment.production })),
  ],
};
`;
  ensureDirectoryExists(path.dirname(appConfigPath));
  fs.writeFileSync(appConfigPath, kitConfig, 'utf-8');
  console.log(`[web_angular] Wrote app.config.ts with interceptors + NGXS store + toastr`);
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

  const routesPath = path.join(srcAppDir, 'app.routes.ts');
  if (!fs.existsSync(routesPath)) {
    fs.writeFileSync(
      routesPath,
      `import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: '**', redirectTo: 'login' }
];
`,
      'utf-8'
    );
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
  stripCodeFences,
  // web_angular template helpers (exported for tests / tooling)
  injectAngularWorkspaceTemplates,
  restoreAngularRootConfigs,
  enforceAngularPackageVersions,
  extractProjectName,
  extractDesignColors,
  filterEssentialSourceFiles,
  verifyNpmCiBuild
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

// -----------------------------------------------------------------------
// Build verification — ensures the migrated project compiles before delivery
// -----------------------------------------------------------------------
// MAX_BUILD_FIX_ATTEMPTS is imported from config — used for incremental build retries

/**
 * Run a shell command and return { stdout, stderr, exitCode }.
 * Resolves even on non-zero exit so callers can inspect the error output.
 */
function runCommand(cmd, args, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, shell: true, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? error.code || 1 : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error
      });
    });
  });
}

/**
 * Verify that the migrated project compiles by running npm install + build.
 * Returns { success: boolean, errors: string, installOk: boolean }.
 */
async function verifyBuild(workspacePath, targetTech, sessionId, skipInstall = false) {
  const isAngular = targetTech.toLowerCase().includes('angular');
  const isReact = targetTech.toLowerCase().includes('react');
  const buildCmd = isAngular ? 'npx' : 'npm';
  const buildArgs = isAngular ? ['ng', 'build'] : ['run', 'build'];

  const nodeModulesPath = path.join(workspacePath, 'node_modules');
  const hasUsableTooling = isAngular
    ? fs.existsSync(path.join(nodeModulesPath, '.bin', 'ng'))
      || fs.existsSync(path.join(nodeModulesPath, '@angular', 'cli'))
    : fs.existsSync(path.join(nodeModulesPath, '.bin', 'vite'))
      || fs.existsSync(path.join(nodeModulesPath, 'vite'));

  // Re-install when tooling is missing even if a partial node_modules folder exists
  const shouldInstall = !skipInstall || !hasUsableTooling;

  if (shouldInstall) {
    console.log(`[${sessionId}] Build verification: running npm install...`);
    const installResult = await runCommand('npm', ['install'], workspacePath, 300000);
    if (installResult.exitCode !== 0) {
      const errOutput = (installResult.stderr || installResult.stdout || '').slice(-3000);
      console.error(`[${sessionId}] npm install failed:\n`, errOutput);
      // Remove partial node_modules so the next attempt does not skip install
      try {
        if (fs.existsSync(nodeModulesPath)) {
          fs.rmSync(nodeModulesPath, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
      return { success: false, errors: `npm install failed:\n${errOutput}`, installOk: false };
    }
    console.log(`[${sessionId}] npm install succeeded. Running build...`);
  } else {
    console.log(`[${sessionId}] Build verification: skipping npm install (tooling present). Running build...`);
  }

  const buildResult = await runCommand(buildCmd, buildArgs, workspacePath, 300000);
  if (buildResult.exitCode === 0) {
    console.log(`[${sessionId}] ✅ Build succeeded!`);
    return { success: true, errors: '', installOk: true };
  }

  const errOutput = (buildResult.stderr || buildResult.stdout || '').slice(-4000);
  console.error(`[${sessionId}] Build failed:\n`, errOutput);
  return { success: false, errors: errOutput, installOk: true };
}

/**
 * Deterministic fix: when build errors say environment is missing props
 * (theme, appTitle, …), inject those keys into all environment*.ts files.
 * Returns number of files patched.
 */
function patchEnvironmentMissingProps(workspacePath, buildErrors) {
  const text = String(buildErrors || '');
  if (!/environment/i.test(text)) return 0;

  const missing = new Set();
  const patterns = [
    /Property '([A-Za-z_][\w]*)' does not exist on type '\{[^']*production:\s*boolean[^']*\}'/g,
    /expression of type '"([A-Za-z_][\w]*)"' can't be used to index type '\{[^']*production:\s*boolean/g,
    /Property '([A-Za-z_][\w]*)' does not exist[\s\S]{0,160}?environment/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) missing.add(m[1]);
  }
  for (const key of ['theme', 'appTitle']) {
    if (new RegExp(`['"]${key}['"]|\\.${key}\\b`).test(text)) missing.add(key);
  }

  const reserved = new Set(['production', 'encryption', 'length', 'name', 'prototype', 'constructor', 'string', 'boolean', 'unknown']);
  for (const k of [...missing]) {
    if (reserved.has(k) || k.length > 40) missing.delete(k);
  }
  if (missing.size === 0) return 0;

  const defaults = {
    theme: "'light'",
    appTitle: "'Migrated Application'",
    apiUrl: "'http://localhost:3000/api'",
    host: "'http://localhost:3000'"
  };

  const envDir = path.join(workspacePath, 'src', 'environments');
  if (!fs.existsSync(envDir)) return 0;

  let patchedFiles = 0;
  for (const file of fs.readdirSync(envDir)) {
    if (!/^environment.*\.ts$/i.test(file)) continue;
    const full = path.join(envDir, file);
    let src = fs.readFileSync(full, 'utf-8');
    let changed = false;

    for (const key of missing) {
      if (new RegExp(`\\b${key}\\s*:`).test(src)) continue;
      const value = defaults[key] ?? "''";
      const next = src.replace(/\n(\s*)\}\s*;\s*$/m, (match, indent) => {
        changed = true;
        return `\n${indent}  ${key}: ${value},\n${indent}};\n`;
      });
      if (next !== src) src = next;
    }

    if (changed) {
      fs.writeFileSync(full, src.endsWith('\n') ? src : `${src}\n`, 'utf-8');
      patchedFiles += 1;
      console.log(`[env-patch] Updated ${path.relative(workspacePath, full)} (+ ${[...missing].join(', ')})`);
    }
  }
  return patchedFiles;
}

/**
 * Ask the AI to fix build errors. Returns an array of { relativePath, content }.
 */
async function askAIToFixBuildErrors(sessionId, buildErrors, workspacePath, aiProvider, aiModel, targetTech) {
  const currentFiles = readDirectoryRecursively(workspacePath, workspacePath);
  const filesContext = buildFilesContext(currentFiles);

  const errorPaths = extractPathsFromBuildErrors(buildErrors);
  const fixPrompt = `The migrated ${targetTech} project has BUILD ERRORS. Fix ONLY the files causing errors.

BUILD ERROR OUTPUT:
\n${buildErrors}\n\nFILES MENTIONED IN ERRORS (use these EXACT paths — do not drop "app/" from Angular paths):
${errorPaths.length ? errorPaths.map((p) => `- ${p}`).join('\n') : '- (parse from error output)'}

CURRENT PROJECT FILES:
${filesContext}

IMPORTANT RULES:
- Output a JSON object with key "files" containing an array of objects:
  [{"path": "src/path/file.ts", "content": "full file content"}]
- path MUST be an exact workspace-relative path from the error list (e.g. src/app/admin/... NOT src/admin/...).
- For Angular, application code lives under src/app/ — never write src/admin or src/pages at the top of src/.
- Only include files that need to be changed to fix the build errors.
- Each file must be COMPLETE valid TypeScript/HTML/SCSS (not a diff, not truncated, no dangling commas/object literals).
- Do NOT include package.json, angular.json, tsconfig.json, or any root config files.
- You MAY update src/environments/environment*.ts when errors are about missing environment properties (theme, appTitle, etc.).
- Prefer extending environment with the missing keys rather than casting.
- Make the minimum changes needed to fix compilation errors.
- Output ONLY valid JSON, no markdown fences.`;

  const systemInstruction = `You are an expert ${targetTech} developer. Your job is to fix build/compilation errors in a migrated project. Output ONLY a valid JSON object with a "files" array.`;

  try {
    const response = await callLLM(systemInstruction, fixPrompt, true, aiProvider, aiModel);
    let parsed;
    try {
      let cleaned = response.trim();
      if (/^```/.test(cleaned)) {
        cleaned = cleaned.replace(/^```[\w+-]*\s*\n?/, '');
        cleaned = cleaned.replace(/\n?```\s*$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn(`[${sessionId}] AI fix response was not valid JSON, skipping auto-fix.`);
      return [];
    }

    const files = parsed.files || parsed;
    if (!Array.isArray(files)) return [];

    return files.filter(f => f.path && f.content).map(f => ({
      relativePath: f.path.replace(/^(?:migrated-(?:angular|react)-project\/)+/i, '').replace(/^\.?\//, ''),
      content: f.content
    }));
  } catch (err) {
    console.error(`[${sessionId}] AI fix call failed:`, err.message);
    return [];
  }
}

/**
 * Run build verification with retry loop.
 * On failure: asks AI to fix errors, retries up to MAX_BUILD_RETRIES times.
 * Returns { verified: boolean }.
 */
async function verifyAndFixBuild(sessionId, workspacePath, targetTech, aiProvider, aiModel) {
  for (let attempt = 1; attempt <= MAX_BUILD_FIX_ATTEMPTS; attempt++) {
    console.log(`[${sessionId}] Final build verification attempt ${attempt}/${MAX_BUILD_FIX_ATTEMPTS}...`);
    // Skip npm install - node_modules should already exist from incremental builds
    const result = await verifyBuild(workspacePath, targetTech, sessionId, true);
    if (result.success) {
      return { verified: true };
    }

    if (attempt < MAX_BUILD_FIX_ATTEMPTS) {
      console.log(`[${sessionId}] Asking AI to fix build errors (attempt ${attempt})...`);
      if (String(targetTech).toLowerCase().includes('angular')) {
        const envPatched = patchEnvironmentMissingProps(workspacePath, result.errors);
        if (envPatched > 0) {
          console.log(`[${sessionId}] Patched ${envPatched} environment file(s). Retrying build...`);
          continue;
        }
      }
      const fixes = await askAIToFixBuildErrors(sessionId, result.errors, workspacePath, aiProvider, aiModel, targetTech);
      if (fixes.length === 0) {
        console.warn(`[${sessionId}] AI returned no fixes. Skipping remaining retries.`);
        break;
      }
      for (const fix of fixes) {
        const safePath = resolveFixWritePath(workspacePath, fix.relativePath, result.errors);
        if (!safePath) {
          console.warn(`[${sessionId}] Skipping unsafe/unresolved fix path: ${fix.relativePath}`);
          continue;
        }
        if (safePath.relative !== fix.relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')) {
          console.log(`[${sessionId}] Remapped fix path ${fix.relativePath} → ${safePath.relative}`);
        }
        ensureDirectoryExists(path.dirname(safePath.full));
        fs.writeFileSync(safePath.full, sanitizeGeneratedContent(safePath.relative, fix.content), 'utf-8');
        console.log(`[${sessionId}] Fixed: ${safePath.relative}`);
      }
      // Re-run post-process repairs after AI fixes
      if (targetTech.toLowerCase().includes('angular')) {
        repairAngularWorkspace(workspacePath, {});
      } else if (targetTech.toLowerCase().includes('react')) {
        repairReactWorkspace(workspacePath, {});
      }
    }
  }

  return { verified: false };
}

/**
 * Remove node_modules from workspace to keep ZIP small.
 */
function removeNodeModules(workspacePath) {
  const nmPath = path.join(workspacePath, 'node_modules');
  if (fs.existsSync(nmPath)) {
    try {
      fs.rmSync(nmPath, { recursive: true, force: true });
      console.log(`Removed node_modules from workspace.`);
    } catch (e) {
      console.warn(`Failed to remove node_modules:`, e.message);
    }
  }
}

const COMPLEXITY_RANK = { low: 0, medium: 1, high: 2 };

/**
 * Stable unit id for grouping sibling files (Angular triad / React + scss).
 */
function migrationUnitId(item) {
  if (item?.unit && typeof item.unit === 'string') {
    return item.unit.replace(/\\/g, '/').replace(/\.(ts|html|scss|css|tsx|jsx)$/i, '');
  }
  const p = (item?.newPath || '').replace(/\\/g, '/');
  if (/\.component\.(ts|html|scss|css)$/i.test(p)) {
    return p.replace(/\.component\.(ts|html|scss|css)$/i, '.component');
  }
  if (/\.(tsx|jsx)$/i.test(p)) {
    return p.replace(/\.(tsx|jsx)$/i, '');
  }
  if (/\.scss$/i.test(p)) {
    const withoutScss = p.replace(/\.scss$/i, '');
    return withoutScss;
  }
  return p;
}

/**
 * Topological sort by `dependencies` (newPath or unit id). Falls back to
 * complexity then original order when deps are missing or cyclic.
 */
function sortPlanByDependencies(planItems) {
  if (!Array.isArray(planItems) || planItems.length === 0) return [];

  const items = planItems.map((item, index) => ({ ...item, __index: index }));
  const byPath = new Map();
  for (const item of items) {
    if (item.newPath) byPath.set(item.newPath.replace(/\\/g, '/'), item);
  }

  const hasAnyDeps = items.some(
    (item) => Array.isArray(item.dependencies) && item.dependencies.length > 0
  );
  if (!hasAnyDeps) {
    return [...items].sort((a, b) => {
      const ca = COMPLEXITY_RANK[a.complexity] ?? 1;
      const cb = COMPLEXITY_RANK[b.complexity] ?? 1;
      if (ca !== cb) return ca - cb;
      return a.__index - b.__index;
    });
  }

  const indegree = new Map(items.map((item) => [item.__index, 0]));
  const edges = new Map(items.map((item) => [item.__index, []]));

  for (const item of items) {
    const deps = Array.isArray(item.dependencies) ? item.dependencies : [];
    for (const dep of deps) {
      const depNorm = String(dep).replace(/\\/g, '/');
      const depItem =
        byPath.get(depNorm) ||
        items.find((c) => migrationUnitId(c) === depNorm.replace(/\.(ts|html|scss|css|tsx|jsx)$/i, ''));
      if (!depItem || depItem.__index === item.__index) continue;
      // dep → item
      edges.get(depItem.__index).push(item.__index);
      indegree.set(item.__index, (indegree.get(item.__index) || 0) + 1);
    }
  }

  const queue = items
    .filter((item) => (indegree.get(item.__index) || 0) === 0)
    .sort((a, b) => {
      const ca = COMPLEXITY_RANK[a.complexity] ?? 1;
      const cb = COMPLEXITY_RANK[b.complexity] ?? 1;
      if (ca !== cb) return ca - cb;
      return a.__index - b.__index;
    })
    .map((item) => item.__index);

  const sortedIndexes = [];
  const itemByIndex = new Map(items.map((item) => [item.__index, item]));

  while (queue.length > 0) {
    const idx = queue.shift();
    sortedIndexes.push(idx);
    for (const next of edges.get(idx) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort((ia, ib) => {
          const a = itemByIndex.get(ia);
          const b = itemByIndex.get(ib);
          const ca = COMPLEXITY_RANK[a.complexity] ?? 1;
          const cb = COMPLEXITY_RANK[b.complexity] ?? 1;
          if (ca !== cb) return ca - cb;
          return a.__index - b.__index;
        });
      }
    }
  }

  if (sortedIndexes.length !== items.length) {
    console.warn('[migration] Dependency cycle or unresolved deps — preserving partial order + remainder.');
    const seen = new Set(sortedIndexes);
    for (const item of items) {
      if (!seen.has(item.__index)) sortedIndexes.push(item.__index);
    }
  }

  return sortedIndexes.map((idx) => {
    const { __index, ...rest } = itemByIndex.get(idx);
    return rest;
  });
}

/**
 * Preferred write order inside an Angular component unit.
 */
function triadSiblingOrder(newPath) {
  const p = newPath.replace(/\\/g, '/').toLowerCase();
  if (p.endsWith('.component.ts')) return 0;
  if (p.endsWith('.component.html')) return 1;
  if (p.endsWith('.component.scss') || p.endsWith('.component.css')) return 2;
  if (p.endsWith('.tsx') || p.endsWith('.jsx')) return 0;
  if (p.endsWith('.scss') || p.endsWith('.css')) return 1;
  return 0;
}

/**
 * Group sorted plan files into migration units (component triads stay together).
 * Build verification runs once per unit after all files in the unit are written.
 */
function groupPlanIntoMigrationUnits(planItems) {
  const sorted = sortPlanByDependencies(planItems);
  const units = [];
  const consumed = new Set();

  const takePath = (relPath) => {
    const norm = relPath.replace(/\\/g, '/');
    const found = sorted.find((item) => item.newPath.replace(/\\/g, '/') === norm);
    if (found) {
      consumed.add(norm);
      return found;
    }
    return null;
  };

  for (const item of sorted) {
    const pathKey = item.newPath.replace(/\\/g, '/');
    if (consumed.has(pathKey)) continue;

    // Angular component triad → one unit
    if (/\.component\.(ts|html|scss|css)$/i.test(pathKey)) {
      const base = pathKey.replace(/\.component\.(ts|html|scss|css)$/i, '.component');
      const files = [];
      for (const ext of ['.ts', '.html', '.scss']) {
        const siblingPath = `${base}${ext}`;
        let existing = takePath(siblingPath);
        if (!existing && ext === '.scss') {
          existing = takePath(`${base}.css`);
        }
        if (existing) {
          files.push({ ...existing, newPath: siblingPath });
        } else {
          files.push({
            newPath: siblingPath,
            explanationOfSource: item.explanationOfSource || `Companion for ${base}`,
            approximateSourceFilesToRead: item.approximateSourceFilesToRead || [],
            dependencies: item.dependencies || [],
            complexity: item.complexity || 'medium',
            unit: base
          });
          consumed.add(siblingPath);
        }
      }
      consumed.add(`${base}.css`);
      units.push({ id: base, label: base, files });
      continue;
    }

    // React component + optional scss
    if (/\.(tsx|jsx)$/i.test(pathKey)) {
      const base = pathKey.replace(/\.(tsx|jsx)$/i, '');
      const files = [item];
      consumed.add(pathKey);
      const companion = takePath(`${base}.scss`) || takePath(`${base}.css`);
      if (companion) {
        files.push({ ...companion, newPath: `${base}.scss` });
      }
      units.push({ id: base, label: pathKey, files });
      continue;
    }

    // Shared unit id from blueprint
    if (item.unit) {
      const unitKey = migrationUnitId(item);
      const files = sorted.filter((candidate) => {
        const cp = candidate.newPath.replace(/\\/g, '/');
        return !consumed.has(cp) && migrationUnitId(candidate) === unitKey;
      });
      for (const f of files) consumed.add(f.newPath.replace(/\\/g, '/'));
      files.sort((a, b) => triadSiblingOrder(a.newPath) - triadSiblingOrder(b.newPath));
      units.push({ id: unitKey, label: unitKey, files: files.length ? files : [item] });
      continue;
    }

    consumed.add(pathKey);
    units.push({ id: pathKey, label: pathKey, files: [item] });
  }

  return units;
}

export async function runMigrationPipeline(sourceZipPath, userPrompt, sessionId, options = {}) {
  const { fromTech = 'Unknown', toTech = 'Unknown', aiProvider = 'openrouter', aiModel, targetVersion, onProgress } = options;
  const isSameFramework = (fromTech || '').toLowerCase() === (toTech || '').toLowerCase();
  const report = (phase, message, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, message, ...extra });
    } catch {
      /* ignore progress listener errors */
    }
  };

  // --- Resolve target versions ---
  // If an explicit targetVersion was provided via UI, inject it into the prompt
  // so that resolveTargetVersions picks it up. UI selection takes priority.
  let effectivePrompt = userPrompt;
  if (targetVersion) {
    const fwKeyword = toTech.toLowerCase().includes('angular') ? 'angular' : toTech.toLowerCase().includes('react') ? 'react' : '';
    if (fwKeyword) {
      effectivePrompt = `${userPrompt}\n[VERSION INSTRUCTION] Use ${fwKeyword} version ${targetVersion}. Set ${fwKeyword}/core to ^${targetVersion}.`;
    }
  }
  const targetVersions = resolveTargetVersions(effectivePrompt, toTech);
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
  report('extract', 'Extracting uploaded archive...');
  console.log(`[${sessionId}] Extracting archive...`);
  let zip;
  try {
    zip = new AdmZip(sourceZipPath);
  } catch (zipError) {
    if (zipError.message && zipError.message.includes('Invalid filename')) {
      throw new Error(
        'The uploaded ZIP contains entries with invalid filenames. '
        + 'Please re-create your ZIP file avoiding special characters in file/folder names '
        + '(e.g., colons, backslashes, or absolute paths).'
      );
    }
    throw new Error(`Could not read the uploaded ZIP file: ${zipError.message}`);
  }
  try {
    zip.extractAllTo(extractPath, true);
  } catch (extractError) {
    throw new Error(`Could not extract ZIP archive: ${extractError.message}. The file may contain invalid entries or be corrupted.`);
  }

  // -----------------------------------------------------------------------
  // 2. Determine best base path and read source files
  // -----------------------------------------------------------------------
  const baseSearchPath = findBaseSearchPath(extractPath);
  const filesMap = readDirectoryRecursively(baseSearchPath);

  if (Object.keys(filesMap).length === 0) {
    throw new Error('No readable source files found inside the uploaded ZIP.');
  }

  // Token efficiency: keep only source files essential to build a
  // web_angular-style app (auth + dashboard + shell + shared plumbing).
  // Feature pages outside that scope are dropped so the AI context stays small.
  const essentialFilesMap = filterEssentialSourceFiles(filesMap, userPrompt);
  const droppedCount = Object.keys(filesMap).length - Object.keys(essentialFilesMap).length;

  const fileTree = Object.keys(essentialFilesMap).map((f) => `- ${f}`).join('\n');
  const filesContextSummary = buildFilesContext(essentialFilesMap);

  console.log(
    `[${sessionId}] Read ${Object.keys(filesMap).length} source files; ` +
      `kept ${Object.keys(essentialFilesMap).length} essential file(s) for the web_angular app (dropped ${droppedCount}).`
  );

  // Read the source package.json once (project name + dependency carry-over)
  const sourcePackageJson = (() => {
    const candidates = [
      path.join(baseSearchPath, 'package.json'),
      ...Object.keys(essentialFilesMap)
        .filter((f) => f.replace(/\\/g, '/').endsWith('package.json'))
        .map((f) => ({ rel: f, content: essentialFilesMap[f] }))
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
  let projectName = 'migrated-angular-project';
  let designColors = {};
  if (targetLower.includes('angular')) {
    projectName = extractProjectName(userPrompt, sourcePackageJson);
    designColors = extractDesignColors(userPrompt);
    console.log(
      `[${sessionId}] Injecting web_angular workspace template ` +
        `(project=${projectName}, colors=${JSON.stringify(designColors)})...`
    );
    injectAngularWorkspaceTemplates(migrationWorkspacePath, targetVersions.angular, {
      projectName,
      designColors
    });
    ensureAngularRuntimeFiles(migrationWorkspacePath);
    ensureCnUtil(migrationWorkspacePath);
    enforceAngularPackageVersions(migrationWorkspacePath, targetVersions.angular);
  } else if (targetLower.includes('react')) {
    console.log(`[${sessionId}] Injecting React workspace templates...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath, targetVersions.react);
  }

  // -----------------------------------------------------------------------
  // 3. AGENT STEP 1: Generate migration blueprint
  // -----------------------------------------------------------------------
  report('blueprint', 'Building migration blueprint...');
  console.log(`[${sessionId}] Stage 1: Building migration blueprint...`);

  const sameFrameworkInstruction = `
You are a code architect stripping down an app to ONLY auth + dashboard (same framework).

RULES:
- KEEP ONLY: login, register, forgot-password, dashboard, auth service/guards/interceptors, core app shell.
- DELETE everything else: profile pages, CRUD tables, blog, about, settings, admin panels, demos.
- Route login as default, dashboard after login, protect with auth guard / protected route.
- Plan ONLY src/ files (components, services, styles). Do NOT plan config files (package.json, angular.json, tsconfig*.json, index.html, vite.config).
- For Angular components, use templateUrl + styleUrl (NOT inline templates); plan full .ts + .html + .scss triads.
- The workspace is pre-injected from the complete web_angular template (src/app/config, src/app/core, src/app/shared, src/app/store, src/app/pages/common, src/app/pages/deeplink, src/app/app.config.ts). KEEP all template files untouched. FUNCTIONALIZE the template's auth pages (login, forgot-password, enter-otp, reset-password, create-new-password) and the dashboard from the source project's auth + dashboard code — plan the template's exact paths under src/app/pages/.
- The app must compile and run after stripping.
- Output ONLY raw JSON (no markdown, no backticks, no explanation).

${INCREMENTAL_BLUEPRINT_PROMPT}
`;

  const crossFrameworkInstruction = `
You are a Principal Software Architect. Your task is to analyze an incoming source codebase and plan out a structural framework migration based on the user's demands.

${INCREMENTAL_BLUEPRINT_PROMPT}

- If targeting Angular: convert React components into Angular Standalone Components under src/app/ (e.g. src/app/pages/..., src/app/admin/...). NEVER plan paths like src/admin or src/pages outside src/app/.
- If targeting React: convert Angular components into React functional components with hooks. DO NOT create tsconfig.app.json, angular.json, or any Angular-specific config files.

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
- WEB_ANGULAR TEMPLATE (the complete reference project is ALREADY injected — do NOT re-plan or regenerate these paths):
  src/app/config/, src/app/core/{authentication,guards,http,interceptors,layouts,resolvers,services},
  src/app/shared/{animations,components,models,directives,pipes,utilities,validators},
  src/app/store/, src/app/pages/common/, src/app/pages/deeplink/, src/app/app.config.ts.
  Reuse breadcrumbs / confirmation-dialog / global-search / pipes / directives / validators / guards / http.service / store from the template.
  Path aliases: @app/*, @core/*, @pages/*, @store/*, @env/*, @shared/*, @configs/* (and @/ → src/).
  KEEP the template folder layout: src/app/pages/{auth,admin,common,deeplink}, core, shared, store, config.
  FUNCTIONALIZE (plan + rewrite) ONLY the template's feature pages from the source project:
    - Auth: src/app/pages/auth/auth/pages/{login,forgot-password,enter-otp,reset-password,create-new-password}/* (full .ts+.html+.scss triads)
    - Dashboard: src/app/pages/admin/dashboard/pages/dashboard/dashboard.component.{ts,html,scss}
    - Routes: src/app/pages/auth/auth.routes.ts, src/app/pages/admin/admin.routes.ts, src/app/app.routes.ts — extend, do not remove template guards/layouts.
  Any NEW feature pages go under src/app/pages/admin/... following the same triad + folder pattern.
- ENVIRONMENTS: src/environments/environment*.ts already include production, host, clientId, clientSecret, encryption. Extend with apiUrl/appTitle/theme in the SAME unit as the config that needs them.
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
        // Support both legacy migrationPlan and new incrementalPlan formats
        targetFileList = parsedPlan.incrementalPlan || parsedPlan.migrationPlan;
        if (targetFileList && Array.isArray(targetFileList) && targetFileList.length > 0) {
          // If incrementalPlan, log the dependency ordering info
          if (parsedPlan.incrementalPlan) {
            const low = targetFileList.filter(f => f.complexity === 'low').length;
            const med = targetFileList.filter(f => f.complexity === 'medium').length;
            const high = targetFileList.filter(f => f.complexity === 'high').length;
            console.log(`[${sessionId}] Incremental plan detected: ${targetFileList.length} steps (low: ${low}, medium: ${med}, high: ${high})`);
          }
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

    // Normalize Angular plan paths that omit src/app/
    let planned = item.newPath.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (targetLower.includes('angular')) {
      const planRemaps = [
        [/^src\/admin\//i, 'src/app/admin/'],
        [/^src\/pages\//i, 'src/app/pages/'],
        [/^src\/core\//i, 'src/app/core/'],
        [/^src\/shared\//i, 'src/app/shared/'],
        [/^src\/store\//i, 'src/app/store/'],
        [/^src\/config\//i, 'src/app/config/'],
        [/^admin\//i, 'src/app/admin/'],
        [/^pages\//i, 'src/app/pages/']
      ];
      for (const [re, to] of planRemaps) {
        if (re.test(planned)) {
          console.log(`[${sessionId}] Remapped plan path ${planned} → ${planned.replace(re, to)}`);
          planned = planned.replace(re, to);
          break;
        }
      }
      item.newPath = planned;
      if (item.unit && typeof item.unit === 'string') {
        let u = item.unit.replace(/\\/g, '/');
        for (const [re, to] of planRemaps) {
          if (re.test(u)) { u = u.replace(re, to); break; }
        }
        item.unit = u;
      }
    }

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
  report('blueprint', `Blueprint ready — ${filteredPlan.length} file(s) planned.`);

  // Group into logical units (Angular triad / React+scss) and dependency order
  const migrationUnits = groupPlanIntoMigrationUnits(filteredPlan);
  console.log(
    `[${sessionId}] Incremental units: ${migrationUnits.length} ` +
    `(from ${filteredPlan.length} planned files). Build runs once per unit.`
  );

  // -----------------------------------------------------------------------
  // 4. AGENT STEP 2: Write each UNIT (small → large), build, fix, then next
  // -----------------------------------------------------------------------
  const fileWriterSystemInstruction = `
You are an elite Senior Frontend Engineer executing a framework translation.
You are writing the code for ONE file only in the new framework structure.
- If writing an Angular Standalone Component TypeScript file: write ONLY TypeScript. Use templateUrl/styleUrl. Do NOT include HTML markup or CSS rules in the .ts file.
- If writing an Angular .html file: write ONLY HTML markup with Tailwind utility classes on elements. No TypeScript, no CSS/SCSS, no file path comments.
- If writing an Angular .scss (or legacy .css) file: write ONLY SCSS/CSS (complete rules with braces). Prefer empty/minimal SCSS — styling belongs in Tailwind classes in the HTML. No HTML, no TypeScript, no file path comments. Empty files must be a comment like /* component */.
- For Angular: keep the app layout under src/app with core, shared, and pages/{common,auth,admin}; do not create top-level src/core or src/shared folders.
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
16. Path aliases: @app/* → src/app/*, @core/* → src/app/core/*, @pages/* → src/app/pages/*, @store/* → src/app/store/*, @env/* → src/environments/*, @shared/* → src/app/shared/*, @configs/* → src/app/config/*, @/ → src/. Also emit the actual src/lib/*.ts files in the plan when a cn() helper is needed.
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
35. INCREMENTAL MIGRATION: Prefer code that compiles with only units written so far. Avoid importing files that are not yet generated; use temporary stubs or omit unfinished route entries until those units land.
36. WEB_ANGULAR TEMPLATE: The complete template kit under src/app/config, src/app/core, src/app/shared, src/app/store, src/app/pages/common, src/app/pages/deeplink and src/app/app.config.ts is ALREADY present and complete — never recreate or overwrite it. Import via @app/*, @core/*, @pages/*, @store/*, @env/*, @shared/*, @configs/*. Only src/app/pages/auth/* and src/app/pages/admin/* feature pages are yours to functionalize/create.
37. ENVIRONMENTS: src/environments/environment*.ts already include production, host, clientId, clientSecret, encryption. Extend with apiUrl/appTitle/theme in the SAME unit as the config that needs them (do not cast missing keys).
`;

  const generatedFiles = {};
  let npmInstallDone = false;

  for (let unitIndex = 0; unitIndex < migrationUnits.length; unitIndex++) {
    const unit = migrationUnits[unitIndex];
    report(
      'unit',
      `Converting unit ${unitIndex + 1}/${migrationUnits.length}: ${unit.label}`,
      { unitIndex: unitIndex + 1, unitTotal: migrationUnits.length }
    );
    console.log(
      `[${sessionId}] Unit [${unitIndex + 1}/${migrationUnits.length}] -> ${unit.label} ` +
      `(${unit.files.length} file${unit.files.length > 1 ? 's' : ''})`
    );

    for (let fileIndex = 0; fileIndex < unit.files.length; fileIndex++) {
      const fileTarget = unit.files[fileIndex];
      console.log(`[${sessionId}]   Writing ${fileTarget.newPath}`);

      let targetSpecificContext = '';
      if (
        fileTarget.approximateSourceFilesToRead &&
        Array.isArray(fileTarget.approximateSourceFilesToRead)
      ) {
        for (const relPath of fileTarget.approximateSourceFilesToRead) {
          if (essentialFilesMap[relPath]) {
            targetSpecificContext += `\n--- SOURCE FILE: ${relPath} ---\n${essentialFilesMap[relPath]}\n`;
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

[INCREMENTAL UNIT]
Unit ${unitIndex + 1}/${migrationUnits.length}: ${unit.label}
Files in this unit: ${unit.files.map((f) => f.newPath).join(', ')}
Completed units so far: ${unitIndex} — prefer compile-safe stubs for unfinished later units.

[ASSIGNMENT DIRECTIONS]
Create the complete code file content for: "${fileTarget.newPath}"
Purpose/Details: ${fileTarget.explanationOfSource}
${isSameFramework ? 'Keep the same framework. Strip down to essential auth + dashboard code.' : `Migration target framework: ${toTech}`}
Write ONLY this one file. No sibling file contents. No markdown fences.
`;

      let fileContent;
      try {
        fileContent = await callLLM(fileWriterSystemInstruction, individualFileWriterPrompt, false, aiProvider, aiModel);
      } catch (err) {
        console.error(`[${sessionId}] LLM call failed for ${fileTarget.newPath}:`, err.message);
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

      // Cool down between file LLM calls inside a multi-file unit
      if (fileIndex < unit.files.length - 1) {
        console.log(`[Rate Limiter] Cooling down for ${RATE_LIMIT_PAUSE_MS / 1000}s...`);
        await pause(RATE_LIMIT_PAUSE_MS);
      }
    }

    // -----------------------------------------------------------------------
    // INCREMENTAL BUILD: after the whole unit is written — must pass to proceed
    // -----------------------------------------------------------------------
    if (targetLower.includes('angular') || targetLower.includes('react')) {
      console.log(
        `[${sessionId}] Unit ${unitIndex + 1}/${migrationUnits.length}: Verifying build after ${unit.label}...`
      );

      let stepBuildVerified = false;
      for (let buildAttempt = 1; buildAttempt <= MAX_BUILD_FIX_ATTEMPTS; buildAttempt++) {
        const buildResult = await verifyBuild(migrationWorkspacePath, toTech, sessionId, npmInstallDone);
        if (buildResult.success) {
          npmInstallDone = true;
          stepBuildVerified = true;
          console.log(`[${sessionId}] Unit ${unitIndex + 1} build ✅ PASSED (attempt ${buildAttempt})`);
          report(
            'unit',
            `Unit ${unitIndex + 1}/${migrationUnits.length} compiled successfully`,
            { unitIndex: unitIndex + 1, unitTotal: migrationUnits.length }
          );
          break;
        }
        // Only skip install on later attempts when install actually succeeded
        if (buildResult.installOk) {
          npmInstallDone = true;
        } else if (targetLower.includes('angular') && targetVersions?.angular) {
          // Install failure is often a bad package pin — re-lock Material/CDK majors and retry
          enforceAngularPackageVersions(migrationWorkspacePath, targetVersions.angular);
        }

        if (buildAttempt < MAX_BUILD_FIX_ATTEMPTS) {
          const isInstallFailure = /npm install failed/i.test(buildResult.errors || '');
          console.log(
            `[${sessionId}] Unit ${unitIndex + 1} build ❌ FAILED ` +
            `(attempt ${buildAttempt}/${MAX_BUILD_FIX_ATTEMPTS}). ` +
            (isInstallFailure ? 'Re-checking package.json then retrying install...' : 'Asking AI to fix...')
          );
          report(
            'fix',
            isInstallFailure
              ? `Unit ${unitIndex + 1}/${migrationUnits.length}: fixing install...`
              : `Unit ${unitIndex + 1}/${migrationUnits.length}: fixing build errors (attempt ${buildAttempt})...`,
            { unitIndex: unitIndex + 1, unitTotal: migrationUnits.length }
          );

          if (isInstallFailure) {
            // AI cannot rewrite package.json (protected) — skip LLM fix for install errors
            continue;
          }

          // Deterministic env patch first (theme/appTitle mismatches) — cheaper than LLM
          if (targetLower.includes('angular')) {
            const envPatched = patchEnvironmentMissingProps(migrationWorkspacePath, buildResult.errors);
            if (envPatched > 0) {
              console.log(
                `[${sessionId}] Patched ${envPatched} environment file(s) for missing keys. Retrying build before AI fix...`
              );
              continue;
            }
          }

          const fixes = await askAIToFixBuildErrors(
            sessionId,
            buildResult.errors,
            migrationWorkspacePath,
            aiProvider,
            aiModel,
            toTech
          );
          if (fixes.length === 0) {
            console.warn(`[${sessionId}] AI returned no fixes for unit ${unitIndex + 1}.`);
            // On syntax failures, force a full rewrite of this unit's primary .ts/.tsx file
            if (isSyntaxHeavyBuildFailure(buildResult.errors)) {
              const primary = unit.files.find((f) => /\.(ts|tsx)$/i.test(f.newPath) && !/\.d\.ts$/i.test(f.newPath));
              if (primary) {
                console.log(`[${sessionId}] Syntax-heavy failure — forcing rewrite of ${primary.newPath}`);
                const rewritePrompt = `
[MANDATORY USER MIGRATION REQUIREMENTS]
${enhancedPrompt}

[BUILD ERRORS]
${buildResult.errors}

[ASSIGNMENT]
Rewrite COMPLETE valid contents for: "${primary.newPath}"
Purpose: ${primary.explanationOfSource}
Fix all syntax errors. Output ONLY the raw file contents — no markdown fences.
`;
                try {
                  let rewritten = await callLLM(fileWriterSystemInstruction, rewritePrompt, false, aiProvider, aiModel);
                  const safePath = resolveSafeWritePath(migrationWorkspacePath, primary.newPath);
                  if (safePath) {
                    const sanitized = sanitizeGeneratedContent(safePath.relative, rewritten);
                    fs.writeFileSync(safePath.full, sanitized, 'utf-8');
                    generatedFiles[safePath.relative] = sanitized;
                    console.log(`[${sessionId}] Rewrote: ${safePath.relative}`);
                  }
                } catch (err) {
                  console.warn(`[${sessionId}] Forced rewrite failed: ${err.message}`);
                }
              }
            }
            continue;
          }
          for (const fix of fixes) {
            const fixPath = resolveFixWritePath(migrationWorkspacePath, fix.relativePath, buildResult.errors);
            if (!fixPath) {
              console.warn(`[${sessionId}] Skipping unsafe/unresolved fix path: ${fix.relativePath}`);
              continue;
            }
            if (fixPath.relative.replace(/\\/g, '/') !== String(fix.relativePath).replace(/\\/g, '/').replace(/^\.?\//, '')) {
              console.log(`[${sessionId}] Remapped fix path ${fix.relativePath} → ${fixPath.relative}`);
              // Remove mistaken orphan path if AI created src/admin/... duplicate
              const orphan = path.join(migrationWorkspacePath, String(fix.relativePath).replace(/^\.?\//, ''));
              if (
                fs.existsSync(orphan) &&
                String(fix.relativePath).replace(/\\/g, '/').startsWith('src/admin/') &&
                fixPath.relative.startsWith('src/app/admin/')
              ) {
                try { fs.unlinkSync(orphan); } catch { /* ignore */ }
              }
            }
            ensureDirectoryExists(path.dirname(fixPath.full));
            const sanitized = sanitizeGeneratedContent(fixPath.relative, fix.content);
            fs.writeFileSync(fixPath.full, sanitized, 'utf-8');
            console.log(`[${sessionId}] Fixed: ${fixPath.relative}`);
            generatedFiles[fixPath.relative] = sanitized;
          }
          if (targetLower.includes('angular')) {
            const pkgBefore = fs.existsSync(path.join(migrationWorkspacePath, 'package.json'))
              ? fs.readFileSync(path.join(migrationWorkspacePath, 'package.json'), 'utf-8')
              : '';
            repairAngularWorkspace(migrationWorkspacePath, {});
            const pkgAfter = fs.existsSync(path.join(migrationWorkspacePath, 'package.json'))
              ? fs.readFileSync(path.join(migrationWorkspacePath, 'package.json'), 'utf-8')
              : '';
            if (pkgBefore !== pkgAfter) npmInstallDone = false;
          } else if (targetLower.includes('react')) {
            const pkgBefore = fs.existsSync(path.join(migrationWorkspacePath, 'package.json'))
              ? fs.readFileSync(path.join(migrationWorkspacePath, 'package.json'), 'utf-8')
              : '';
            repairReactWorkspace(migrationWorkspacePath, {});
            const pkgAfter = fs.existsSync(path.join(migrationWorkspacePath, 'package.json'))
              ? fs.readFileSync(path.join(migrationWorkspacePath, 'package.json'), 'utf-8')
              : '';
            if (pkgBefore !== pkgAfter) npmInstallDone = false;
          }
        } else {
          const errTail = (buildResult.errors || '').slice(-2000);
          const priorNote = unitIndex > 0
            ? 'Earlier units compiled; '
            : '';
          throw new Error(
            `Incremental migration stopped at unit ${unitIndex + 1}/${migrationUnits.length} ` +
            `(${unit.label}): build still failing after ${MAX_BUILD_FIX_ATTEMPTS} fix attempts. ` +
            `${priorNote}fix this unit before continuing.\n\nLast build errors:\n${errTail}`
          );
        }
      }

      if (!stepBuildVerified) {
        throw new Error(
          `Incremental migration stopped at unit ${unitIndex + 1}/${migrationUnits.length} ` +
          `(${unit.label}): build did not pass. Refusing to proceed to the next unit.`
        );
      }
    }

    if (unitIndex < migrationUnits.length - 1) {
      console.log(`[Rate Limiter] Cooling down for ${RATE_LIMIT_PAUSE_MS / 1000}s before next unit...`);
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
  
  // For React/Angular, restore template config files AFTER AI generation to
  // ensure correct tooling. The AI owns src/app feature pages only — the
  // web_angular kit/config files are restored from the pristine template.
  if (targetLower.includes('react')) {
    console.log(`[${sessionId}] Re-injecting React templates to ensure correct config files...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath, targetVersions.react);
    ensureReactRuntimeFiles(migrationWorkspacePath);
    console.log(`[${sessionId}] Running React post-generation repairs...`);
    repairReactWorkspace(migrationWorkspacePath, { sourcePackageJson });
    enforceReactPackageVersions(migrationWorkspacePath, targetVersions.react);
  } else if (targetLower.includes('angular')) {
    console.log(
      `[${sessionId}] Restoring web_angular template config files (AI kept ownership of src/app feature pages)...`
    );
    restoreAngularRootConfigs(migrationWorkspacePath, targetVersions.angular, {
      projectName,
      designColors
    });
    ensureAngularRuntimeFiles(migrationWorkspacePath);
    ensureAngularAppConfigUsesWebAngular(migrationWorkspacePath);
    normalizeAngularComponentFiles(migrationWorkspacePath);
    console.log(`[${sessionId}] Running Angular post-generation repairs...`);
    repairAngularWorkspace(migrationWorkspacePath, {
      sourceFilesMap: essentialFilesMap,
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

  // -----------------------------------------------------------------------
  // 5b. Verify the build compiles before packaging
  // -----------------------------------------------------------------------
  const buildCheck = await verifyAndFixBuild(
    sessionId,
    migrationWorkspacePath,
    toTech,
    aiProvider,
    aiModel || undefined
  );
  if (!buildCheck.verified) {
    console.warn(`[${sessionId}] Final build verification failed after ${MAX_BUILD_FIX_ATTEMPTS} attempts. Delivering anyway.`);
  }

  // npm ci sanity check — the delivered project must install + build after only `npm ci`
  const npmCiCheck = await verifyNpmCiBuild(migrationWorkspacePath, toTech, sessionId);
  if (!npmCiCheck.ok) {
    console.warn(`[${sessionId}] npm ci sanity check failed:\n${npmCiCheck.errors.slice(-1500)}`);
  }

  // Remove node_modules to keep ZIP small (user will run npm ci locally)
  removeNodeModules(migrationWorkspacePath);

  report('package', 'Packaging migrated project ZIP...');
  console.log(`[${sessionId}] All target files built. Packaging archive...`);

  // -----------------------------------------------------------------------
  // 6. Package the result into a ZIP
  // -----------------------------------------------------------------------
  const finalZip = new AdmZip();
  finalZip.addLocalFolder(migrationWorkspacePath);
  finalZip.writeZip(outputZipPath);

  console.log(`[${sessionId}] Final ZIP written to ${outputZipPath}`);

  return outputZipPath;
}

// ---------------------------------------------------------------------------
// Rework: apply user changes / error fixes to an existing converted project
// ---------------------------------------------------------------------------

/**
 * Ask the AI to produce a change plan (JSON) for applying user-submitted
 * changes / error fixes to an existing converted project.
 * Returns an array of { relativePath, content, delete? } edits.
 */
async function askAIForChangePlan(sessionId, workspacePath, reworkPrompt, aiProvider, aiModel, targetTech) {
  const currentFiles = readDirectoryRecursively(workspacePath, workspacePath);
  const filesContext = buildFilesContext(currentFiles);

  const changePrompt = `You are updating an EXISTING migrated ${targetTech} project to implement the user's requested changes and/or fix the reported errors.

The changes/errors reported by the user:
${reworkPrompt}

CURRENT PROJECT FILES:
${filesContext}

IMPORTANT RULES:
- Output a JSON object with key "files" containing an array of objects:
  [{"path": "src/path/file.ts", "content": "full file content"}]
- path MUST be an exact workspace-relative path that already exists in the project (e.g. src/app/pages/... NOT src/pages).
- If a file must be deleted, output {"path": "src/...", "delete": true}.
- Only include files that need to be changed to satisfy the user's request or fix the errors.
- Each file must be COMPLETE valid TypeScript/HTML/SCSS/JSX/TSX (not a diff, not truncated, no dangling commas).
- Do NOT include package.json, angular.json, tsconfig.json, or any root config files.
- Preserve the existing framework structure, imports, and conventions.
- Make the MINIMUM changes needed. Do not rewrite unrelated files.
- For Angular: application code lives under src/app/; use templateUrl/styleUrl, standalone components, Tailwind classes.
- Output ONLY valid JSON, no markdown fences.`;

  const systemInstruction = `You are an expert ${targetTech} developer. Apply the user's requested changes to an existing migrated project. Output ONLY a valid JSON object with a "files" array.`;

  try {
    const response = await callLLM(systemInstruction, changePrompt, true, aiProvider, aiModel);
    let parsed;
    try {
      let cleaned = response.trim();
      if (/^```/.test(cleaned)) {
        cleaned = cleaned.replace(/^```[\w+-]*\s*\n?/, '');
        cleaned = cleaned.replace(/\n?```\s*$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn(`[${sessionId}] AI change-plan response was not valid JSON, skipping auto-apply.`);
      return [];
    }

    const files = parsed.files || parsed;
    if (!Array.isArray(files)) return [];

    return files
      .filter((f) => f && typeof f.path === 'string' && (typeof f.content === 'string' || f.delete === true))
      .map((f) => ({
        relativePath: String(f.path).replace(/^(?:migrated-(?:angular|react)-project\/)+/i, '').replace(/^\.?\//, ''),
        content: typeof f.content === 'string' ? f.content : '',
        delete: f.delete === true,
      }));
  } catch (err) {
    console.error(`[${sessionId}] AI change-plan call failed:`, err.message);
    return [];
  }
}

/**
 * Apply user-submitted changes / error fixes to an EXISTING converted project
 * (workspace on disk) and produce a new ZIP.
 *
 * @param {string} workspacePath - Existing converted project directory
 * @param {string} reworkPrompt  - User's requested changes / reported errors
 * @param {string} sessionId     - Session id (kept stable across reworks)
 * @param {object} options       - { toTech, aiProvider, aiModel, onProgress }
 * @returns {Promise<string>}    - Path to the new final ZIP
 */
export async function runReworkPipeline(workspacePath, reworkPrompt, sessionId, options = {}) {
  const { toTech = 'Unknown', aiProvider = 'openrouter', aiModel, onProgress } = options;
  const report = (phase, message, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, message, ...extra });
    } catch {
      /* ignore progress listener errors */
    }
  };

  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Existing project workspace not found: ${workspacePath}`);
  }

  report('rework', 'Reading existing project files...');
  console.log(`[${sessionId}] Rework: reading existing project at ${workspacePath}...`);

  const currentFiles = readDirectoryRecursively(workspacePath, workspacePath);
  if (Object.keys(currentFiles).length === 0) {
    throw new Error('No readable source files found in the existing project.');
  }

  // 1. Ask the AI for the change plan
  report('rework', 'Asking AI to apply your changes / fix errors...');
  const edits = await askAIForChangePlan(sessionId, workspacePath, reworkPrompt, aiProvider, aiModel, toTech);

  if (edits.length === 0) {
    throw new Error('The AI did not return any file changes. Please rephrase your changes/errors and try again.');
  }

  // 2. Apply edits (create/overwrite/delete) safely inside the workspace
  let applied = 0;
  for (const edit of edits) {
    if (edit.delete) {
      const safePath = resolveSafeWritePath(workspacePath, edit.relativePath);
      if (!safePath) {
        console.warn(`[${sessionId}] Skipping unsafe delete path: ${edit.relativePath}`);
        continue;
      }
      if (fs.existsSync(safePath.full)) {
        fs.unlinkSync(safePath.full);
        console.log(`[${sessionId}] Deleted: ${safePath.relative}`);
        applied++;
      }
      continue;
    }

    // Exact-path resolution only: never silently redirect an edit to a
    // different existing file that merely shares the same basename.
    const fixPath = resolveFixWritePath(workspacePath, edit.relativePath, '', false);
    if (!fixPath) {
      console.warn(`[${sessionId}] Skipping unsafe/unresolved edit path: ${edit.relativePath}`);
      continue;
    }
    if (fixPath.relative.replace(/\\/g, '/') !== edit.relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')) {
      console.log(`[${sessionId}] Remapped edit path ${edit.relativePath} → ${fixPath.relative}`);
    }
    ensureDirectoryExists(path.dirname(fixPath.full));
    fs.writeFileSync(fixPath.full, sanitizeGeneratedContent(fixPath.relative, edit.content), 'utf-8');
    console.log(`[${sessionId}] Updated: ${fixPath.relative}`);
    applied++;
  }

  if (applied === 0) {
    throw new Error('No file changes could be applied. Please rephrase your changes/errors and try again.');
  }

  // 3. Post-process repairs after AI edits
  report('rework', 'Running post-process repairs...');
  if (String(toTech).toLowerCase().includes('angular')) {
    repairAngularWorkspace(workspacePath, {});
  } else if (String(toTech).toLowerCase().includes('react')) {
    repairReactWorkspace(workspacePath, {});
  }

  // 4. Verify build + fix loop
  report('rework', 'Verifying the updated project still builds...');
  const buildCheck = await verifyAndFixBuild(sessionId, workspacePath, toTech, aiProvider, aiModel);
  if (!buildCheck.verified) {
    console.warn(`[${sessionId}] Rework: final build verification failed after ${MAX_BUILD_FIX_ATTEMPTS} attempts. Delivering anyway.`);
  }

  // 5. npm ci sanity check
  const npmCiCheck = await verifyNpmCiBuild(workspacePath, toTech, sessionId);
  if (!npmCiCheck.ok) {
    console.warn(`[${sessionId}] Rework: npm ci sanity check failed:\n${npmCiCheck.errors.slice(-1500)}`);
  }

  // 6. Remove node_modules to keep ZIP small
  removeNodeModules(workspacePath);

  // 7. Package the updated project into a new ZIP
  report('package', 'Packaging updated project ZIP...');
  console.log(`[${sessionId}] Rework: packaging updated project...`);
  const outputZipPath = path.join(EXTRACT_DIR, `${sessionId}-rework-final.zip`);
  const finalZip = new AdmZip();
  finalZip.addLocalFolder(workspacePath);
  finalZip.writeZip(outputZipPath);

  console.log(`[${sessionId}] Rework final ZIP written to ${outputZipPath}`);
  return outputZipPath;
}
