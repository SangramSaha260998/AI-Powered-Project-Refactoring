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
  LLM_REQUEST_TIMEOUT_MS,
  BUILD_EVERY_N_UNITS,
  MAX_BUILD_FIX_ATTEMPTS
} from '../config/index.js';
import { getDefaultPrompt, INCREMENTAL_BLUEPRINT_PROMPT } from '../config/defaultPrompt.js';
import { getPriorityRules, formatPriorityRulesPrompt } from '../config/priorityRules.js';
import { resolveTargetVersions, formatVersionMandate, LATEST_ANGULAR } from '../config/targetVersions.js';
import { analyzeSourceProject, analyzeReferenceProject, buildMigrationPlan } from './analyzer.js';
import { runVisualQa } from './visualQa.js';
import { ensureDirectoryExists } from '../utils/file.js';
import { repairAngularWorkspace, repairReactWorkspace, ensureCnUtil, collectConversionDefects, collectMissingSourcePages, isPlaceholderTemplate, fileContainsJsx, renameJsxTsFilesToTsx, detectSourceStack, isTruncatedSource, addPackagesFromBuildErrors, rewriteReactAngularLeftovers, fixReactTypeErrors, fixAngularCompileErrors, ensureAngularMaterialPackages } from './postprocess.js';
import {
  angularDestForReactSource,
  isReactBootstrapPath,
  isMisplacedAngularAppComponentPath,
  synthesizeAngularUnitFromReact
} from './reactToAngular.js';

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
 * Thrown when conversion pauses so the user can continue later (free-tier 429).
 * Partial files stay on disk; a checkpoint lists the next unit to write.
 */
export class ConversionPausedError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ConversionPausedError';
    this.status = 429;
    this.resumable = true;
    this.completedUnitIndex = extra.completedUnitIndex ?? -1;
    this.unitTotal = extra.unitTotal ?? 0;
  }
}

/**
 * Thrown when conversion must not ship a ZIP (skipped units, stubs, or build failure).
 */
export class ConversionIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionIncompleteError';
  }
}

function checkpointFilePath(sessionId) {
  return path.join(EXTRACT_DIR, `${sessionId}-checkpoint.json`);
}

export function readCheckpoint(sessionId) {
  try {
    const raw = fs.readFileSync(checkpointFilePath(sessionId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeCheckpoint(sessionId, data) {
  try {
    fs.writeFileSync(
      checkpointFilePath(sessionId),
      `${JSON.stringify({ ...data, sessionId, updatedAt: Date.now() }, null, 2)}\n`,
      'utf-8'
    );
  } catch (err) {
    console.warn(`[${sessionId}] Failed to write checkpoint:`, err.message);
  }
}

export function clearCheckpoint(sessionId) {
  try {
    const p = checkpointFilePath(sessionId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

const UNIT_SOURCE_CONTEXT_MAX_CHARS = 24000;

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
  if (statusCode === 404) return { worthy: true, statusCode, reason: 'model-missing' };
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
function openaiClientOptions(cfg) {
  return {
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey || 'placeholder',
    timeout: LLM_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
  };
}

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
        client: new OpenAI(openaiClientOptions({ ...cfg, apiKey: cfg.apiKey || 'placeholder' })),
        config: cfg
      }));
    }
    return null;
  }

  return configs.map(cfg => ({
    client: new OpenAI(openaiClientOptions(cfg)),
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
          const response = await client.chat.completions.create(requestOptions, {
            timeout: LLM_REQUEST_TIMEOUT_MS,
            maxRetries: 0
          });
          const content = response.choices?.[0]?.message?.content;
          if (content == null || String(content).trim() === '') {
            throw new Error('AI returned an empty response.');
          }
          const lowered = String(content).toLowerCase();
          if (
            lowered.includes('upstream error') ||
            lowered.includes('temporarily overloaded') ||
            lowered.includes('provider returned error')
          ) {
            const bogus = new Error('AI returned an upstream/provider error payload.');
            bogus.status = 503;
            throw bogus;
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
          if (statusCode === 401 || statusCode === 402 || statusCode === 403) {
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
            const waitMs = statusCode === 429 ? getRetryAfterMs(err, 5000) : 200;
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
  const matches = text.match(/src\/[\w./-]+\.(?:tsx|jsx|ts|html|scss|css)/g) || [];
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
  return /TS1005|TS1109|TS1128|TS1131|TS1003|TS1161|TS2695|Unexpected EOF|Expression expected|Unterminated regular expression/i.test(text);
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

  // Convert every source file — do not block writes to a starter-kit tree.

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
 * If React source contains JSX, the destination must be .tsx — never .ts.
 * Returns { relative, full, staleTsFull? }.
 */
function reactDestinationForContent(workspaceRoot, relativePath, content) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (
    !normalized.endsWith('.ts') ||
    normalized.endsWith('.d.ts') ||
    !fileContainsJsx(content)
  ) {
    return {
      relative: normalized,
      full: path.join(workspaceRoot, normalized)
    };
  }

  const tsxRel = normalized.replace(/\.ts$/, '.tsx');
  return {
    relative: tsxRel,
    full: path.join(workspaceRoot, tsxRel),
    staleTsFull: path.join(workspaceRoot, normalized)
  };
}

function unlinkIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * Remap Angular-shaped / `.ts` React-component plan paths onto `.tsx`.
 * Bootstrap/tooling files come from the React workspace template — never plan them.
 */
function isReactScaffoldPath(plannedPath) {
  const p = String(plannedPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return (
    /(^|\/)index\.html$/i.test(p) ||
    /^src\/index\.(tsx|ts|jsx|js|scss|css)$/i.test(p) ||
    /^src\/main\.(tsx|ts|jsx|js)$/i.test(p) ||
    /^src\/styles\.(scss|css)$/i.test(p) ||
    /^src\/vite-env\.d\.ts$/i.test(p) ||
    /^src\/app\.config\.(ts|tsx)$/i.test(p)
  );
}

function isAngularTemplateOwnedPath(plannedPath) {
  const p = String(plannedPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return (
    /^src\/app\/app\.component\.(ts|html|scss|css)$/i.test(p) ||
    /^src\/app\/app\.config\.ts$/i.test(p) ||
    /^src\/main\.ts$/i.test(p) ||
    /^src\/index\.html$/i.test(p) ||
    /^src\/styles\.(scss|css)$/i.test(p)
  );
}

function isIgnorableAngularUnit(unit) {
  const label = String(unit?.label || '').replace(/\\/g, '/');
  if (isMisplacedAngularAppComponentPath(label) || isAngularTemplateOwnedPath(label)) {
    return true;
  }
  const files = Array.isArray(unit?.files) ? unit.files : [];
  if (!files.length) return false;
  return files.every(
    (f) =>
      isMisplacedAngularAppComponentPath(f.newPath) ||
      isAngularTemplateOwnedPath(f.newPath)
  );
}

function toPascalCaseName(name) {
  return String(name || '')
    .replace(/\.component$/i, '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function normalizeReactPlanPath(plannedPath) {
  let planned = String(plannedPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!planned) return null;
  if (/\.html$/i.test(planned)) return null;
  if (isReactScaffoldPath(planned)) return null;

  planned = planned.replace(/^src\/app\//i, 'src/');

  // Blueprint unit ids often keep the Angular stem without an extension.
  if (/\.component$/i.test(planned) && !/\.(ts|tsx|js|jsx|scss|css|html)$/i.test(planned)) {
    const dir = path.posix.dirname(planned);
    const base = path.posix.basename(planned).replace(/\.component$/i, '');
    planned = `${dir}/${toPascalCaseName(base)}.tsx`;
  }

  if (/\.component\.(scss|css)$/i.test(planned)) {
    const dir = path.posix.dirname(planned);
    const base = path.posix.basename(planned).replace(/\.component\.(scss|css)$/i, '');
    planned = `${dir}/${toPascalCaseName(base)}.scss`;
  } else if (/\.component\.(ts|tsx)$/i.test(planned)) {
    const dir = path.posix.dirname(planned);
    const base = path.posix.basename(planned).replace(/\.component\.(ts|tsx)$/i, '');
    planned = `${dir}/${toPascalCaseName(base)}.tsx`;
  } else if (
    /\.ts$/i.test(planned) &&
    !/\.d\.ts$/i.test(planned) &&
    /\/(pages?|components?|features?|layouts?)\//i.test(planned) &&
    !/\.(actions|state|selectors|model|service|types|spec)\.ts$/i.test(planned)
  ) {
    planned = planned.replace(/\.ts$/i, '.tsx');
  }

  if (isReactScaffoldPath(planned)) return null;
  return planned;
}

function coerceReactMigrationUnit(unit) {
  const seen = new Set();
  const files = [];
  for (const f of unit?.files || []) {
    const np = normalizeReactPlanPath(f.newPath);
    if (!np || seen.has(np)) continue;
    seen.add(np);
    files.push({ ...f, newPath: np });
  }
  if (!files.length) return { ...unit, files: [] };
  const primary =
    files.find((f) => /\.(tsx|jsx)$/i.test(f.newPath))?.newPath || files[0].newPath;
  return {
    ...unit,
    files,
    label: primary.replace(/\.(tsx|jsx)$/i, ''),
    id: String(primary).replace(/\.(tsx|jsx|ts|js|scss|css)$/i, '')
  };
}

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

  // Runtime essentials only — no starter-kit packages (Material/NGXS/toastr/…)
  if (stack.zone) pkg.dependencies['zone.js'] = stack.zone;
  if (!pkg.dependencies.rxjs) pkg.dependencies.rxjs = '~7.8.0';
  if (!pkg.dependencies.tslib) pkg.dependencies.tslib = '^2.3.0';

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

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  console.log(
    `[versions] Locked Angular package.json to ${stack.core} (source=${stack.source})`
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
 * Write a MINIMAL Angular workspace (tooling only).
 * Does NOT copy server/web_angular or any starter-kit pages/services.
 * AI converts every uploaded source file into src/.
 */
function injectAngularWorkspaceTemplates(destPath, versionStack = null, options = {}) {
  const stack = versionStack || LATEST_ANGULAR;
  const { projectName = 'migrated-angular-project', designColors = {}, preserveSrc = false } = options;
  const safeName = toSafeProjectName(projectName);

  ensureDirectoryExists(destPath);
  ensureDirectoryExists(path.join(destPath, 'src', 'app'));
  ensureDirectoryExists(path.join(destPath, 'src', 'environments'));
  ensureDirectoryExists(path.join(destPath, 'public'));

  const packageJson = {
    name: safeName,
    version: '1.0.0',
    private: true,
    scripts: {
      ng: 'ng',
      start: 'ng serve',
      build: 'ng build',
      watch: 'ng build --watch --configuration development'
    },
    dependencies: {
      '@angular/animations': stack.core,
      '@angular/common': stack.core,
      '@angular/compiler': stack.core,
      '@angular/core': stack.core,
      '@angular/forms': stack.core,
      '@angular/platform-browser': stack.core,
      '@angular/platform-browser-dynamic': stack.core,
      '@angular/router': stack.core,
      rxjs: '~7.8.0',
      tslib: '^2.3.0',
      'zone.js': stack.zone || '~0.15.0'
    },
    devDependencies: {
      '@angular/build': `^${stack.tooling}`,
      '@angular/cli': `^${stack.tooling}`,
      '@angular/compiler-cli': stack.core,
      autoprefixer: '^10.4.20',
      postcss: '^8.4.49',
      sass: '^1.83.0',
      tailwindcss: '^3.4.17',
      typescript: stack.typescript || '~5.9.2'
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf-8'
  );

  const angularJson = {
    $schema: './node_modules/@angular/cli/lib/config/schema.json',
    version: 1,
    newProjectRoot: 'projects',
    projects: {
      [safeName]: {
        projectType: 'application',
        schematics: {
          '@schematics/angular:component': { style: 'scss', standalone: true }
        },
        root: '',
        sourceRoot: 'src',
        prefix: 'app',
        architect: {
          build: {
            builder: '@angular/build:application',
            options: {
              browser: 'src/main.ts',
              polyfills: ['zone.js'],
              tsConfig: 'tsconfig.app.json',
              inlineStyleLanguage: 'scss',
              assets: [{ glob: '**/*', input: 'public' }],
              styles: ['src/styles.scss']
            },
            configurations: {
              production: { budgets: [], outputHashing: 'all' },
              development: { optimization: false, extractLicenses: false, sourceMap: true }
            },
            defaultConfiguration: 'production'
          },
          serve: {
            builder: '@angular/build:dev-server',
            configurations: {
              production: { buildTarget: `${safeName}:build:production` },
              development: { buildTarget: `${safeName}:build:development` }
            },
            defaultConfiguration: 'development'
          }
        }
      }
    }
  };
  fs.writeFileSync(
    path.join(destPath, 'angular.json'),
    `${JSON.stringify(angularJson, null, 2)}\n`,
    'utf-8'
  );

  const tsconfig = {
    compileOnSave: false,
    compilerOptions: {
      strict: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      skipLibCheck: true,
      isolatedModules: true,
      experimentalDecorators: true,
      importHelpers: true,
      target: 'ES2022',
      module: 'preserve',
      baseUrl: './',
      paths: {
        '@/*': ['src/*'],
        '@app/*': ['src/app/*'],
        '@env/*': ['src/environments/*']
      }
    },
    angularCompilerOptions: {
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      typeCheckHostBindings: true,
      strictTemplates: true
    }
  };
  if ((Number(stack.major) || 0) >= 22) {
    tsconfig.compilerOptions.ignoreDeprecations = '6.0';
  }
  fs.writeFileSync(
    path.join(destPath, 'tsconfig.json'),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
    'utf-8'
  );

  const tsconfigApp = {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: './out-tsc/app',
      types: []
    },
    files: ['src/main.ts'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.spec.ts']
  };
  fs.writeFileSync(
    path.join(destPath, 'tsconfig.app.json'),
    `${JSON.stringify(tsconfigApp, null, 2)}\n`,
    'utf-8'
  );

  if (!preserveSrc) {
    const humanName = humanizeProjectName(projectName);
    fs.writeFileSync(
      path.join(destPath, 'src', 'index.html'),
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${humanName}</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(destPath, 'src', 'main.ts'),
      `import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(destPath, 'src', 'styles.scss'),
      `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
      'utf-8'
    );
    writeFileIfMissing(
      path.join(destPath, 'src', 'environments', 'environment.ts'),
      `export const environment = {
  production: false
};
`
    );
    writeFileIfMissing(
      path.join(destPath, 'src', 'environments', 'environment.development.ts'),
      `export const environment = {
  production: false
};
`
    );
  }

  const tailwindConfig = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts,scss}'],
  theme: { extend: {} },
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

  applyAngularTemplateCustomizations(destPath, { projectName, designColors });
  enforceAngularPackageVersions(destPath, stack);
  if (!preserveSrc) {
    ensureAngularRuntimeFiles(destPath);
    ensureAngularAppConfigUsesWebAngular(destPath);
  }
  console.log(`[angular] Minimal workspace injected at ${destPath} (preserveSrc=${preserveSrc})`);
}

/**
 * Re-lock root tooling files after AI generation without wiping converted src/.
 */
function restoreAngularRootConfigs(destPath, stack, options = {}) {
  const { projectName = 'migrated-angular-project', designColors = {} } = options;
  injectAngularWorkspaceTemplates(destPath, stack, {
    projectName,
    designColors,
    preserveSrc: true
  });
  console.log('[angular] Restored root tooling files (src/ conversion kept)');
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

function kebabStemFromPath(filePath) {
  const base = path.posix
    .basename(String(filePath || '').replace(/\\/g, '/'))
    .replace(/\.(component\.)?(ts|tsx|js|jsx|html|scss|css)$/i, '')
    .replace(/\.component$/i, '');
  return (
    base
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || ''
  );
}

function collectSourceStems(filesMap) {
  const stems = new Set();
  for (const rel of Object.keys(filesMap || {})) {
    const n = rel.replace(/\\/g, '/');
    if (!/^src\//.test(n)) continue;
    if (!/\.(ts|tsx|js|jsx|html)$/i.test(n)) continue;
    const stem = kebabStemFromPath(n);
    if (stem) stems.add(stem);
  }
  return stems;
}

const INVENTED_PAGE_STEMS = new Set([
  'home', 'dashboard', 'settings', 'login', 'register', 'signin', 'signup',
  'sign-in', 'sign-up', 'profile', 'about', 'landing', 'not-found'
]);

function dropInventedPlanPages(plan, sourceStems, sessionId) {
  return (plan || []).filter((item) => {
    const stem = kebabStemFromPath(item?.newPath);
    if (!INVENTED_PAGE_STEMS.has(stem)) return true;
    if (sourceStems.has(stem)) return true;
    console.log(`[${sessionId}] Dropping invented page not present in source: ${item.newPath}`);
    return false;
  });
}

function isPlaceholderGeneratedFile(filePath, content) {
  if (isPlaceholderTemplate(filePath, content)) return true;
  const text = String(content || '').trim();
  if (!text) return true;
  if (/\.html$/i.test(filePath) && text.length < 80 && /^<div class="[^"]*"><\/div>$/i.test(text)) {
    return true;
  }
  if (/\.(ts|tsx|js|jsx)$/i.test(filePath) && isTruncatedSource(content)) {
    return true;
  }
  return false;
}

/**
 * If the LLM omits source files from the blueprint, append plan items so
 * every application source file is converted.
 * Coverage is by destination stem matching the source file name — not by the
 * model's approximateSourceFilesToRead (which often maps admin-users.tsx onto
 * an invented home.component.ts).
 */
function ensurePlanCoversAllSourceFiles(plan, filesMap, toTech) {
  const isAngular = String(toTech || '').toLowerCase().includes('angular');
  const coveredStems = new Set();
  for (const item of plan) {
    const stem = kebabStemFromPath(item.newPath);
    if (stem) coveredStems.add(stem);
  }
  const plannedPaths = new Set(plan.map((p) => String(p.newPath || '').replace(/\\/g, '/')));
  const extras = [];

  const toKebab = (name) =>
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'converted';

  for (const rel of Object.keys(filesMap)) {
    const n = rel.replace(/\\/g, '/');
    if (!/^src\//.test(n)) continue;
    if (!/\.(ts|tsx|js|jsx|html|scss|css)$/i.test(n)) continue;
    if (/\.(spec|test)\./i.test(n)) continue;
    if (/routeTree\.gen|vite-env\.d|__root/.test(n)) continue;
    if (/(^|\/)(server|start)\.(ts|js)$/i.test(n)) continue;
    const kebab = kebabStemFromPath(n) || toKebab(path.posix.basename(n));
    if (kebab && coveredStems.has(kebab)) continue;

    if (isAngular) {
      if (isReactBootstrapPath(n)) continue;
      const dest = angularDestForReactSource(n);
      if (!dest || dest.kind === 'style') continue;
      if (dest.kind === 'component') {
        for (const newPath of dest.files) {
          if (plannedPaths.has(newPath)) continue;
          plannedPaths.add(newPath);
          extras.push({
            newPath,
            explanationOfSource: `Complete conversion of ${n}`,
            approximateSourceFilesToRead: [rel],
            complexity: newPath.endsWith('.scss') ? 'low' : 'medium',
            unit: dest.unit
          });
        }
        if (dest.kebab) coveredStems.add(dest.kebab);
        continue;
      }
      if ((dest.kind === 'model' || dest.kind === 'lib' || dest.kind === 'service') && dest.newPath) {
        if (plannedPaths.has(dest.newPath)) continue;
        plannedPaths.add(dest.newPath);
        extras.push({
          newPath: dest.newPath,
          explanationOfSource: `Complete conversion of ${n}`,
          approximateSourceFilesToRead: [rel],
          complexity: 'low',
          unit: dest.newPath
        });
        continue;
      }
    } else {
      // React target: Angular component triads become one .tsx (+ optional .scss).
      if (/\.html$/i.test(n)) continue;
      if (isReactScaffoldPath(n) || isReactScaffoldPath(n.replace(/^src\/app\//i, 'src/'))) continue;
      const newPath = normalizeReactPlanPath(n);
      if (!newPath) continue;
      if (isReactScaffoldPath(newPath)) continue;
      if (plannedPaths.has(newPath)) continue;
      plannedPaths.add(newPath);
      extras.push({
        newPath,
        explanationOfSource: `Complete conversion of ${n}`,
        approximateSourceFilesToRead: [rel],
        complexity: 'medium',
        unit: newPath
      });
    }
  }
  return extras;
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

function injectReactWorkspaceTemplates(destPath, versionStack = null, options = {}) {
  const { preserveSrc = false } = options;
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

  // 5. src stubs — only on first inject so later restore does not wipe converted files
  if (!preserveSrc) {
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

    // Stub App.tsx so the build doesn't fail on unit 1 (AI overwrites this later)
    const stubAppTsx = `export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', textAlign: 'center' }}>
      <h1>Migration in progress...</h1>
    </main>
  );
}
`;
    fs.writeFileSync(path.join(destPath, 'src', 'App.tsx'), stubAppTsx, 'utf-8');

    const indexScss = `@tailwind base;
@tailwind components;
@tailwind utilities;

/* Global app styles — prefer Tailwind utilities in components */
`;
    fs.writeFileSync(path.join(destPath, 'src', 'index.scss'), indexScss);
  }

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
  writeFileIfMissing(mainTsxPath, normalizedMain);

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
 * Write a minimal standalone app.config.ts only when missing.
 * Converted files own routing/providers after generation.
 */
function ensureAngularAppConfigUsesWebAngular(destPath) {
  const appConfigPath = path.join(destPath, 'src', 'app', 'app.config.ts');
  if (fs.existsSync(appConfigPath)) return;

  const kitConfig = `import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(),
    provideAnimationsAsync(),
  ],
};
`;
  ensureDirectoryExists(path.dirname(appConfigPath));
  fs.writeFileSync(appConfigPath, kitConfig, 'utf-8');
  console.log(`[angular] Wrote missing app.config.ts (minimal bootstrap)`);
}


function ensureAngularRuntimeFiles(destPath) {
  const srcAppDir = path.join(destPath, 'src', 'app');
  ensureDirectoryExists(srcAppDir);

  const componentTsPath = path.join(srcAppDir, 'app.component.ts');
  if (!fs.existsSync(componentTsPath)) {
    const componentTs = `import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
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
      `<router-outlet></router-outlet>\n`,
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

export const routes: Routes = [];
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
 * Collect a small source-file context for one unit (free-model token budget).
 */
function sourceContextForUnit(unit, filesMap) {
  const wanted = [];
  const seen = new Set();
  const add = (rel) => {
    const n = String(rel || '').replace(/\\/g, '/');
    if (!n || seen.has(n) || !filesMap[n] && !filesMap[rel]) return;
    seen.add(n);
    wanted.push(filesMap[n] ? n : rel);
  };

  // Destination stem matching source file names is authoritative. Planner
  // approximateSourceFilesToRead often maps a real page onto an invented Home.
  for (const f of unit.files || []) {
    const destStem = kebabStemFromPath(f.newPath);
    if (!destStem) continue;
    for (const rel of Object.keys(filesMap)) {
      const srcStem = kebabStemFromPath(rel);
      if (!srcStem) continue;
      if (
        srcStem === destStem ||
        srcStem === destStem.replace(/^admin-/, '') ||
        `admin-${srcStem}` === destStem
      ) {
        add(rel);
      }
    }
  }

  for (const f of unit.files || []) {
    for (const s of f.approximateSourceFilesToRead || []) add(s);
  }

  if (wanted.length === 0) {
    for (const f of unit.files || []) {
      const base = path.posix
        .basename(String(f.newPath || ''))
        .replace(/\.(component\.)?(ts|tsx|js|jsx|html|scss|css)$/i, '')
        .toLowerCase();
      if (base.length < 3) continue;
      for (const rel of Object.keys(filesMap)) {
        const leaf = path.posix.basename(rel.replace(/\\/g, '/')).toLowerCase();
        if (leaf.includes(base) && wanted.length < 4) add(rel);
      }
    }
  }

  let ctx = '';
  for (const rel of wanted) {
    const content = filesMap[rel] || filesMap[rel.replace(/\//g, '\\')];
    if (!content) continue;
    const chunk = `\n--- SOURCE FILE: ${rel} ---\n${content}\n`;
    if (ctx.length + chunk.length > UNIT_SOURCE_CONTEXT_MAX_CHARS) break;
    ctx += chunk;
  }
  return ctx;
}

/**
 * Parse a multi-file unit response (JSON or ===== FILE: path ===== markers).
 */
function parseUnitFileBundle(raw, expectedPaths = []) {
  const files = [];
  const cleaned = stripCodeFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : parsed.files;
    if (Array.isArray(arr)) {
      for (const f of arr) {
        const p = f.path || f.newPath;
        if (p && f.content != null) files.push({ path: String(p).replace(/\\/g, '/'), content: String(f.content) });
      }
    }
  } catch {
    /* marker format */
  }

  if (files.length === 0) {
    const re = /===== FILE:\s*(.+?)\s*=====\s*\r?\n([\s\S]*?)(?====== FILE:|===== END =====|$)/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      files.push({
        path: m[1].trim().replace(/\\/g, '/').replace(/^[`'"]+|[`'"]+$/g, ''),
        content: m[2].replace(/\n+$/, '')
      });
    }
  }

  if (files.length === 0 && expectedPaths.length === 1) {
    files.push({ path: expectedPaths[0], content: cleaned });
  }

  return files.filter((f) => f.path && f.content != null);
}

function extCompatible(expectedExt, actualExt) {
  const a = String(expectedExt || '').toLowerCase();
  const b = String(actualExt || '').toLowerCase();
  if (a === b) return true;
  if ((a === '.ts' && b === '.tsx') || (a === '.tsx' && b === '.ts')) return true;
  if ((a === '.js' && b === '.jsx') || (a === '.jsx' && b === '.js')) return true;
  if ((a === '.scss' && b === '.css') || (a === '.css' && b === '.scss')) return true;
  return false;
}

/** Match an AI bundle file to a planned path (PascalCase vs kebab, .ts vs .tsx). */
function matchUnitBundleFile(parsedFiles, expectedPath) {
  const expected = String(expectedPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const tsxExpected = expected.replace(/\.ts$/, '.tsx');
  const byPath = new Map(
    (parsedFiles || []).map((f) => [String(f.path || '').replace(/\\/g, '/').replace(/^\.?\//, ''), f])
  );
  const direct = byPath.get(expected) || byPath.get(tsxExpected);
  if (direct) return direct;

  const stripComp = (name) => String(name || '').replace(/\.component$/i, '');
  const expectedBase = stripComp(
    path.posix.basename(expected).replace(/\.(tsx|ts|jsx|js|scss|css|html)$/i, '')
  );
  const expectedExt = path.posix.extname(expected);
  const expectedStem = kebabStemFromPath(expected);

  const stemHit = (parsedFiles || []).find((f) => {
    const p = String(f.path || '').replace(/\\/g, '/').replace(/^\.?\//, '');
    const base = stripComp(path.posix.basename(p).replace(/\.(tsx|ts|jsx|js|scss|css|html)$/i, ''));
    const ext = path.posix.extname(p);
    if (!extCompatible(expectedExt, ext) && !(expectedExt === '.ts' && ext === '.jsx') && !(expectedExt === '.tsx' && ext === '.jsx')) {
      return false;
    }
    return (
      base === expectedBase ||
      base.toLowerCase() === expectedBase.toLowerCase() ||
      kebabStemFromPath(p) === expectedStem
    );
  });
  if (stemHit) return stemHit;

  if (/\.(tsx|ts|jsx|js)$/i.test(expected)) {
    const codeFiles = (parsedFiles || []).filter((f) =>
      /\.(tsx|ts|jsx|js)$/i.test(f.path) && String(f.content || '').trim()
    );
    if (codeFiles.length === 1) return codeFiles[0];
  }
  return null;
}

/**
 * When the AI omits a React component, build a .tsx from the matching Angular triad.
 */
function synthesizeReactUnitFromAngular(unit, filesMap) {
  if (!unit?.files?.length || !filesMap) return [];
  const destCode = (unit.files || []).find(
    (f) => /\.(tsx|ts|jsx|js)$/i.test(f.newPath) && !/\.d\.ts$/i.test(f.newPath)
  );
  if (!destCode) return [];
  const stem =
    kebabStemFromPath(destCode.newPath) || kebabStemFromPath(unit.label);
  if (!stem) return [];

  let ngHtml = '';
  let ngTs = '';
  let ngScss = '';
  for (const [rel, content] of Object.entries(filesMap)) {
    const n = String(rel).replace(/\\/g, '/');
    if (kebabStemFromPath(n) !== stem) continue;
    if (/\.component\.html$/i.test(n)) ngHtml = String(content || '');
    else if (/\.component\.ts$/i.test(n) && !/\.spec\./i.test(n)) ngTs = String(content || '');
    else if (/\.component\.(scss|css)$/i.test(n)) ngScss = String(content || '');
  }
  if (!ngHtml && !ngTs) return [];

  const pascal = toPascalCaseName(stem);
  const inputs = [...ngTs.matchAll(/@Input\(\)\s+(\w+)/g)].map((m) => m[1]);
  const outputs = [...ngTs.matchAll(/@Output\(\)\s+(\w+)/g)].map((m) => m[1]);
  const handlers = outputs.map(
    (name) => `on${name.charAt(0).toUpperCase()}${name.slice(1)}`
  );
  const props = [...new Set([...inputs, ...handlers])];
  const propsSig = props.length ? `{ ${props.join(', ')} }` : '';
  const jsxBody = (ngHtml || '<div />').trim();
  const stub = `import { useState } from 'react';

export default function ${pascal}(${propsSig}) {
  return (
    <>
${jsxBody}
    </>
  );
}
`;
  const converted = rewriteReactAngularLeftovers(stub);
  const out = [
    { path: destCode.newPath.replace(/\.ts$/i, '.tsx'), content: converted }
  ];
  const destScss = (unit.files || []).find((f) => /\.(scss|css)$/i.test(f.newPath));
  if (destScss) {
    out.push({
      path: destScss.newPath.replace(/\.css$/i, '.scss'),
      content: ngScss.trim() ? `${ngScss.trim()}\n` : '/* component */\n'
    });
  }
  return out;
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
  verifyNpmCiBuild,
  matchUnitBundleFile,
  normalizeReactPlanPath,
  groupPlanIntoMigrationUnits,
  coerceReactMigrationUnit,
  synthesizeReactUnitFromAngular
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
  const errorPaths = extractPathsFromBuildErrors(buildErrors);
  const currentFiles = readDirectoryRecursively(workspacePath, workspacePath);
  const subset = {};
  const keys = Object.keys(currentFiles);
  for (const p of errorPaths) {
    const norm = String(p).replace(/\\/g, '/');
    if (currentFiles[norm]) subset[norm] = currentFiles[norm];
    else {
      const hit = keys.find((k) => k.replace(/\\/g, '/').endsWith(norm) || norm.endsWith(k.replace(/\\/g, '/')));
      if (hit) subset[hit] = currentFiles[hit];
    }
  }
  if (Object.keys(subset).length === 0) {
    // Fallback: only the first 8 source files, never the whole tree
    for (const k of keys.slice(0, 8)) subset[k] = currentFiles[k];
  }
  if (String(targetTech).toLowerCase().includes('react')) {
    for (const k of keys) {
      if (Object.keys(subset).length >= 20) break;
      if (subset[k]) continue;
      if (/@angular\/|@ngxs\/|<mat-|\bmat-(?:button|icon|dialog)|@State\s*\(|store\.dispatch\s*\(\s*new /.test(currentFiles[k] || '')) {
        subset[k] = currentFiles[k];
      }
    }
  }
  const filesContext = buildFilesContext(subset);
  const isReactTarget = String(targetTech).toLowerCase().includes('react');
  const isAngularTarget = String(targetTech).toLowerCase().includes('angular');
  const libraryFixRules = isReactTarget
    ? `- If errors mention @ngxs/store, @State, Store.dispatch, or Action classes: rewrite that store as zustand (\`create\`, useXStore hook). Never keep NGXS in React.
- If errors mention @angular/material, mat-* tags, or MatDialog/MatSidenav: rewrite to @mui/material (Drawer, Dialog, AppBar, Toolbar, Button, IconButton, Icon).`
    : isAngularTarget
      ? `- NG1010 / "Unknown reference" on a name in @Component({ imports }) means that name is not imported as a VALUE. Add \`import { MatButtonModule } from '@angular/material/button'\` (and MatIconModule from '@angular/material/icon', MatSidenavModule, MatToolbarModule, etc.). Never \`import type\` for those symbols.
- Do NOT rewrite Angular Material to MUI in an Angular project. Keep mat-* templates and @angular/material imports.`
      : `- If a named import is missing, add the correct import — do not delete the feature.`;
  const fixPrompt = `The migrated ${targetTech} project has BUILD ERRORS. Fix ONLY the files causing errors.

BUILD ERROR OUTPUT:
\n${buildErrors}\n\nFILES MENTIONED IN ERRORS (use these EXACT paths — do not drop "app/" from Angular paths):
${errorPaths.length ? errorPaths.map((p) => `- ${p}`).join('\n') : '- (parse from error output)'}

CURRENT PROJECT FILES:
${filesContext}

IMPORTANT RULES:
- Output a JSON object with key "files" containing an array of objects:
  [{"path": "src/path/file.ts", "content": "full file content"}]
- You MAY change a .ts path to .tsx when the file contains JSX (TS1161 / Unterminated regular expression literal on a .ts file means JSX is in the wrong extension — emit the .tsx path and do not leave the .ts file).
- path MUST be an exact workspace-relative path from the error list (e.g. src/app/admin/... NOT src/admin/...), except for the .ts → .tsx rename above.
- For Angular, application code lives under src/app/ — never write src/admin or src/pages at the top of src/.
- Only include files that need to be changed to fix the build errors.
- Each file must be COMPLETE valid TypeScript/HTML/SCSS (not a diff, not truncated, no dangling commas/object literals).
- Do NOT include package.json, angular.json, tsconfig.json, or any root config files.
- You MAY update src/environments/environment*.ts when errors are about missing environment properties (theme, appTitle, etc.).
- Prefer extending environment with the missing keys rather than casting.
- Make the minimum changes needed to fix compilation errors.
- Do NOT delete converted pages/features to silence errors — fix the actual type/template/import issue.
${libraryFixRules}
- If a named import is missing, add the correct import — do not delete the feature.
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
async function verifyAndFixBuild(sessionId, workspacePath, targetTech, aiProvider, aiModel, sourceFilesMap = null, sourcePackageJson = null) {
  let lastErrors = '';
  const isReact = String(targetTech).toLowerCase().includes('react');
  const isAngular = String(targetTech).toLowerCase().includes('angular');
  let skipNpmInstall = false;

  for (let attempt = 1; attempt <= MAX_BUILD_FIX_ATTEMPTS; attempt++) {
    if (isReact) {
      const renamed = renameJsxTsFilesToTsx(workspacePath);
      if (renamed > 0) {
        console.log(`[${sessionId}] Renamed ${renamed} JSX .ts file(s) to .tsx before build`);
      }
    }
    console.log(`[${sessionId}] Final build verification attempt ${attempt}/${MAX_BUILD_FIX_ATTEMPTS}...`);
    const result = await verifyBuild(workspacePath, targetTech, sessionId, skipNpmInstall);
    if (result.installOk) skipNpmInstall = true;
    if (result.success) {
      return { verified: true, errors: '' };
    }
    lastErrors = result.errors || '';

    if (attempt < MAX_BUILD_FIX_ATTEMPTS) {
      if (isReact) {
        const repairedPkgs = repairReactWorkspace(workspacePath, { sourceFilesMap, sourcePackageJson }) || 0;
        const addedPkgs = addPackagesFromBuildErrors(workspacePath, result.errors);
        const typeFixed = fixReactTypeErrors(workspacePath, result.errors);
        const missingModule = /Cannot find module/.test(result.errors || '');
        if (repairedPkgs > 0 || addedPkgs > 0 || (missingModule && typeFixed === 0)) {
          console.log(`[${sessionId}] Installing dependencies after postprocess/package fixes...`);
          await runCommand('npm', ['install'], workspacePath, 300000);
          skipNpmInstall = true;
          continue;
        }
        if (typeFixed > 0) {
          console.log(`[${sessionId}] Mechanically fixed type errors in ${typeFixed} file(s). Retrying build...`);
          continue;
        }
      }
      if (isAngular) {
        const envPatched = patchEnvironmentMissingProps(workspacePath, result.errors);
        if (envPatched > 0) {
          console.log(`[${sessionId}] Patched ${envPatched} environment file(s). Retrying build...`);
          continue;
        }
        const materialPkgs = ensureAngularMaterialPackages(workspacePath, sourcePackageJson, sourceFilesMap);
        const ngFixed = fixAngularCompileErrors(workspacePath, result.errors);
        if (materialPkgs > 0) {
          console.log(`[${sessionId}] Added Angular Material packages. Installing dependencies...`);
          await runCommand('npm', ['install'], workspacePath, 300000);
          skipNpmInstall = true;
          repairAngularWorkspace(workspacePath, { sourceFilesMap, sourcePackageJson });
          continue;
        }
        if (ngFixed > 0) {
          repairAngularWorkspace(workspacePath, { sourceFilesMap, sourcePackageJson });
          console.log(`[${sessionId}] Mechanically fixed Angular compile errors in ${ngFixed} file(s). Retrying build...`);
          continue;
        }
      }
      console.log(`[${sessionId}] Asking AI to fix build errors (attempt ${attempt})...`);
      const fixes = await askAIToFixBuildErrors(sessionId, result.errors, workspacePath, aiProvider, aiModel, targetTech);
      if (fixes.length === 0) {
        // Mechanical JSX rename may still save the build on the next attempt.
        if (isReact && renameJsxTsFilesToTsx(workspacePath) > 0) {
          console.log(`[${sessionId}] AI returned no fixes; renamed JSX .ts files and retrying.`);
          continue;
        }
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
        let sanitized = sanitizeGeneratedContent(safePath.relative, fix.content);
        if (isReact && /\.(ts|tsx|js|jsx)$/i.test(safePath.relative)) {
          sanitized = rewriteReactAngularLeftovers(sanitized);
        }
        let destRel = safePath.relative;
        let destFull = safePath.full;
        if (isReact) {
          const dest = reactDestinationForContent(workspacePath, safePath.relative, sanitized);
          destRel = dest.relative;
          destFull = dest.full;
          if (dest.staleTsFull && dest.staleTsFull !== destFull) unlinkIfExists(dest.staleTsFull);
          if (destRel.endsWith('.tsx')) unlinkIfExists(destFull.replace(/\.tsx$/, '.ts'));
        }
        ensureDirectoryExists(path.dirname(destFull));
        fs.writeFileSync(destFull, sanitized, 'utf-8');
        console.log(`[${sessionId}] Fixed: ${destRel}`);
      }
      // Re-run post-process repairs after AI fixes
      if (isAngular) {
        repairAngularWorkspace(workspacePath, { sourceFilesMap });
      } else if (isReact) {
        repairReactWorkspace(workspacePath, { sourceFilesMap });
      }
    }
  }

  return { verified: false, errors: lastErrors };
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
function groupPlanIntoMigrationUnits(planItems, toTech = '') {
  const isReact = String(toTech || '').toLowerCase().includes('react');
  const prepared = isReact
    ? (planItems || [])
        .map((item) => {
          const newPath = normalizeReactPlanPath(item.newPath);
          if (!newPath) return null;
          let unit = item.unit;
          if (unit) {
            const u = normalizeReactPlanPath(String(unit));
            unit = u || newPath;
          }
          return { ...item, newPath, unit };
        })
        .filter(Boolean)
    : planItems;
  const sorted = sortPlanByDependencies(prepared);
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

    // Angular component triad → one unit (never for React — leftover .component.ts
    // paths are remapped to .tsx above).
    if (!isReact && /\.component\.(ts|html|scss|css)$/i.test(pathKey)) {
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
  const {
    fromTech = 'Unknown',
    toTech = 'Unknown',
    aiProvider = 'openrouter',
    aiModel,
    targetVersion,
    onProgress,
    referenceZipPath = null,
    priorityRulesMode = 'react-ui',
    customPriorityRules = null,
    enableVisualQa = false,
    visualQaRoutes = ['/'],
    resume = false,
  } = options;
  const isSameFramework = (fromTech || '').toLowerCase() === (toTech || '').toLowerCase();
  const report = (phase, message, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, message, ...extra });
    } catch {
      /* ignore progress listener errors */
    }
  };

  const checkpoint = readCheckpoint(sessionId);
  const isResume = Boolean(resume && checkpoint?.units?.length);

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

  // Append direction-specific complete-conversion prompt + version mandate
  const defaultSuffix = getDefaultPrompt(fromTech, toTech);
  const enhancedPrompt = `${userPrompt}\n\n${defaultSuffix}\n\n${versionMandate}`;

  // Priority rules — source of truth. Without a reference ZIP, source project wins.
  const hasReferenceZip = Boolean(referenceZipPath && fs.existsSync(referenceZipPath));
  const priorityRules = getPriorityRules(priorityRulesMode, customPriorityRules);
  const priorityRulesPrompt = formatPriorityRulesPrompt(priorityRules, { hasReference: hasReferenceZip });
  console.log(`[${sessionId}] Priority rules mode: ${priorityRulesMode}`);

  // Use absolute paths based on the already-defined EXTRACT_DIR
  const extractPath = path.join(EXTRACT_DIR, sessionId);
  const migrationWorkspacePath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
  const outputZipPath = path.join(EXTRACT_DIR, `${sessionId}-final.zip`);

  // Ensure folders exist
  ensureDirectoryExists(extractPath);
  ensureDirectoryExists(migrationWorkspacePath);

  // -----------------------------------------------------------------------
  // 1. Unpack original framework archive (skipped when resuming)
  // -----------------------------------------------------------------------
  if (isResume) {
    report('resume', `Resuming conversion from checkpoint (unit ${(checkpoint.completedUnitIndex ?? -1) + 2})...`);
    console.log(
      `[${sessionId}] Resume: next unit index ${(checkpoint.completedUnitIndex ?? -1) + 1} ` +
      `of ${checkpoint.units.length}`
    );
  } else {
    if (!sourceZipPath || !fs.existsSync(sourceZipPath)) {
      throw new Error('Source ZIP is required for a new conversion.');
    }
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
  }

  // -----------------------------------------------------------------------
  // 2. Determine best base path and read source files
  // -----------------------------------------------------------------------
  const baseSearchPath = findBaseSearchPath(extractPath);
  const filesMap = readDirectoryRecursively(baseSearchPath);

  if (Object.keys(filesMap).length === 0) {
    throw new Error('No readable source files found inside the uploaded ZIP.');
  }

  // Convert EVERY readable source file — do not strip features.
  const essentialFilesMap = filesMap;

  const fileTree = Object.keys(essentialFilesMap).map((f) => `- ${f}`).join('\n');
  const filesContextSummary = buildFilesContext(essentialFilesMap);

  console.log(
    `[${sessionId}] Read ${Object.keys(filesMap).length} source file(s); converting all of them (no template strip-down).`
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
  let projectName = checkpoint?.projectName || 'migrated-angular-project';
  let designColors = checkpoint?.designColors || {};
  const skipInject = isResume && fs.existsSync(path.join(migrationWorkspacePath, 'package.json'));
  if (!skipInject) {
    if (targetLower.includes('angular')) {
      projectName = extractProjectName(userPrompt, sourcePackageJson);
      designColors = extractDesignColors(userPrompt);
      console.log(
        `[${sessionId}] Injecting minimal Angular workspace (no starter-kit pages) ` +
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
  }

  let migrationUnits = isResume ? checkpoint.units : null;
  let startUnitIndex = isResume ? Math.max(0, (checkpoint.completedUnitIndex ?? -1) + 1) : 0;

  if (!migrationUnits) {
  // -----------------------------------------------------------------------
  // 2c. ANALYZER STAGE (ChatGPT workflow): analyze source + reference projects
  // -----------------------------------------------------------------------
  let sourceAnalysis = null;
  let referenceAnalysis = null;
  let migrationPlanPreview = null;
  try {
    report('analyze', 'Analyzing source project structure...');
    sourceAnalysis = analyzeSourceProject(extractPath);
    console.log(
      `[${sessionId}] Analyzer: source project = ${sourceAnalysis.framework}, ` +
      `${sourceAnalysis.fileCount} files, ${sourceAnalysis.components.length} components, ` +
      `${sourceAnalysis.services.length} services, ${sourceAnalysis.routes.length} routes`
    );

    if (referenceZipPath && fs.existsSync(referenceZipPath)) {
      report('analyze', 'Analyzing reference project architecture...');
      const refExtractPath = path.join(EXTRACT_DIR, `${sessionId}-reference`);
      ensureDirectoryExists(refExtractPath);
      try {
        const refZip = new AdmZip(referenceZipPath);
        refZip.extractAllTo(refExtractPath, true);
        referenceAnalysis = analyzeReferenceProject(refExtractPath);
        console.log(
          `[${sessionId}] Analyzer: reference project = ${referenceAnalysis.framework}, ` +
          `${referenceAnalysis.fileCount} files, ${referenceAnalysis.sharedComponents.length} shared components, ` +
          `${referenceAnalysis.services.length} services`
        );
      } catch (refErr) {
        console.warn(`[${sessionId}] Analyzer: failed to analyze reference project: ${refErr.message}`);
      }
    }

    migrationPlanPreview = buildMigrationPlan(sourceAnalysis, referenceAnalysis, fromTech, toTech);
    console.log(
      `[${sessionId}] Analyzer: migration plan preview — ${migrationPlanPreview.mappings.length} mappings, ` +
      `${migrationPlanPreview.plan.length} planned files`
    );
  } catch (analyzeErr) {
    console.warn(`[${sessionId}] Analyzer: analysis failed (continuing without it): ${analyzeErr.message}`);
  }

  // -----------------------------------------------------------------------
  // 3. AGENT STEP 1: Generate migration blueprint
  // -----------------------------------------------------------------------
  report('blueprint', 'Building migration blueprint...');
  console.log(`[${sessionId}] Stage 1: Building migration blueprint...`);

  const sameFrameworkInstruction = `
You are a code architect converting EVERY uploaded source file (same framework).

RULES:
- Convert the FULL app. Do NOT strip features. Do NOT drop CRUD, settings, admin, or extra pages.
- Plan a target file for every meaningful source file (components, pages, routes, services, hooks, utils, styles).
- Plan ONLY src/ files. Do NOT plan config files (package.json, angular.json, tsconfig*.json, index.html, vite.config).
- For Angular components, use templateUrl + styleUrl (NOT inline templates); plan full .ts + .html + .scss triads.
- There is NO starter-kit template. You must plan app.component, app.routes, and every feature from the source tree.
- The app must compile and run with the same user-visible functionality as the source.
- Output ONLY raw JSON (no markdown, no backticks, no explanation).

${INCREMENTAL_BLUEPRINT_PROMPT}
`;

  const crossFrameworkInstruction = `
You are a Principal Software Architect. Convert the incoming source codebase COMPLETELY into the target framework.

${INCREMENTAL_BLUEPRINT_PROMPT}

COMPLETE CONVERSION (MANDATORY):
- Plan a target file for EVERY source application file (pages, routes, components, services, hooks, utils, styles).
- Do NOT omit features. Do NOT reduce the app to auth + dashboard. CRUD, settings, admin, and extra pages MUST be converted.
- There is NO starter-kit template. Do not assume src/app/core, shared, store, or auth pages already exist.

- If targeting Angular: convert components into Angular Standalone Components under src/app/. NEVER plan paths like src/admin or src/pages outside src/app/.
- If targeting React: convert Angular components into React functional components with hooks. Plan PascalCase .tsx files (e.g. src/components/task-form-sidebar/TaskFormSidebar.tsx). NEVER plan .component.ts / .component.html / .component.scss or a unit id ending in .component. DO NOT create tsconfig.app.json, angular.json, or any Angular-specific config files.

IMPORTANT RULES FOR FILE GENERATION:
- For React projects: Only generate src/ files. Do NOT generate config files like package.json, tsconfig.json, vite.config.ts.
- For Angular projects: Only generate src/ files. Do NOT generate config files like package.json, tsconfig.json, angular.json.
- Convert the actual application code (components, services, utilities, pages, routes).
- USER MIGRATION MANDATE IS HIGHEST PRIORITY: when the user specifies titles, colors, themes, branding, or copy changes, every planned UI file must reflect those exact values instead of copying the source project defaults.
- For Angular: app.component.ts must use templateUrl/styleUrl — put all markup in app.component.html and styles in app.component.scss. Never plan inline templates in the .ts file when an .html sibling exists.
- For Angular: EVERY component needs its own .ts + .html + .scss triad with matching names (e.g. avatar.component.ts / avatar.component.html / avatar.component.scss). Never share one template across components. Use Tailwind utility classes in HTML; keep SCSS minimal.
- Styling for ALL targets: Tailwind CSS in templates + SCSS files only (never .css).
- For Angular: plan src/lib/* utility ports (utils.ts, format.ts, mock-data.ts) when the React app uses @/lib/*.
- For React: plan src/lib/* when the Angular app has shared utilities.
- Prefer @if / @for / @switch control flow in Angular templates over *ngIf / *ngFor when practical.
- Do NOT invent non-existent packages (e.g. @radix-ng/*). Use Angular primitives, CDK patterns, or plain custom components instead.
- Path aliases: @app/* → src/app/*, @env/* → src/environments/*, @/ → src/.
- Map lucide-react icons to plain inline SVG markup in Angular (NO @lucide/angular / lucide-angular / lucide-react packages). Every icon must be a real <svg xmlns=...>...</svg> with Lucide paths. For React target keep lucide-react.
- For Angular: NEVER plan Lucide* imports, LucideIconModule, <lucide-*> tags, or <svg lucideXxx>. Plan inline SVG only.
- For Angular: every planned .html must have matching public/protected members on its .ts sibling; no React leftover cn()/className/return-in-template patterns unless the class exposes them.
- For Angular: routes import page components from their own files — never from app.component.ts. Plan app.routes.ts covering EVERY converted page.
`;

  const blueprintSystemInstruction = isSameFramework ? sameFrameworkInstruction : crossFrameworkInstruction;

  const blueprintPrompt = `
[CURRENT CODEBASE FILE TREE MAP]
${fileTree}

[CURRENT APPLICATION FILES SOURCE CODE]
${filesContextSummary}

[MIGRATION CORE MANDATE]
${enhancedPrompt}

[PRIORITY RULES — DECISION HIERARCHY]
${priorityRulesPrompt}

[ANALYZER OUTPUT — SOURCE PROJECT ANALYSIS]
${sourceAnalysis ? JSON.stringify({
  framework: sourceAnalysis.framework,
  fileCount: sourceAnalysis.fileCount,
  components: sourceAnalysis.components,
  services: sourceAnalysis.services,
  routes: sourceAnalysis.routes,
  hooks: sourceAnalysis.hooks,
  contexts: sourceAnalysis.contexts,
}, null, 2) : 'No source analysis available.'}

[ANALYZER OUTPUT — REFERENCE PROJECT ARCHITECTURE]
${referenceAnalysis ? JSON.stringify({
  framework: referenceAnalysis.framework,
  fileCount: referenceAnalysis.fileCount,
  folders: referenceAnalysis.folders,
  sharedComponents: referenceAnalysis.sharedComponents,
  services: referenceAnalysis.services,
  guards: referenceAnalysis.guards,
  interceptors: referenceAnalysis.interceptors,
  styling: referenceAnalysis.styling,
}, null, 2) : 'No reference project analysis available.'}

[ANALYZER OUTPUT — MIGRATION PLAN PREVIEW]
${migrationPlanPreview ? JSON.stringify({
  mappings: migrationPlanPreview.mappings,
  plan: migrationPlanPreview.plan,
}, null, 2) : 'No migration plan preview available.'}

[FROM TECH] ${fromTech}
[TO TECH] ${toTech}
${isSameFramework ? 'NOTE: Same framework — convert every source file. Do NOT strip features.' : ''}
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
      ? (targetLower.includes('react')
        ? `You are converting an Angular project into React (Vite + TypeScript).

From the FILE TREE below, list EVERY application source file that must exist in the converted React project.
Include all pages, components, routes, services, hooks, and utils — not just auth/dashboard.

List each file on a new line, starting with "src/".
Use PascalCase .tsx for UI (never Angular .component.ts / .html / .scss).
Example:
src/App.tsx
src/pages/TaskList.tsx
src/components/task-form-sidebar/TaskFormSidebar.tsx
src/components/task-delete-dialog/TaskDeleteDialog.tsx

LIST ONLY THE FILE PATHS. No explanations. No JSON. No markdown.
Include ALL feature files from the source tree.`
        : `You are converting a frontend project file tree.

From the FILE TREE below, list EVERY application source file that must exist in the converted project.
Include all pages, components, routes, services, hooks, and utils — not just auth/dashboard.

List each file on a new line, starting with "src/".
Example:
src/app/app.component.ts
src/app/app.routes.ts
src/app/pages/admin-users/admin-users.component.ts

LIST ONLY THE FILE PATHS. No explanations. No JSON. No markdown.
Include ALL feature files from the source tree.`)
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
      const filePathRegex = /(?:src\/[\w./-]+\.(?:tsx|jsx|ts|html|css|scss|json))/g;
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
  const sourceStems = collectSourceStems(essentialFilesMap);
  let filteredPlan = targetFileList.filter((item) => {
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

    if (targetLower.includes('react')) {
      const remapped = normalizeReactPlanPath(planned);
      if (remapped == null) {
        console.log(`[${sessionId}] Skipping Angular HTML triad file in React plan: ${planned}`);
        return false;
      }
      if (remapped !== planned) {
        console.log(`[${sessionId}] Remapped React plan path ${planned} → ${remapped}`);
        planned = remapped;
        item.newPath = planned;
        if (item.unit && typeof item.unit === 'string') {
          const u = normalizeReactPlanPath(item.unit);
          if (u) item.unit = u;
        }
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
    if (targetLower.includes('angular') && isMisplacedAngularAppComponentPath(item.newPath)) {
      console.log(`[${sessionId}] Skipping misplaced root App plan path: ${item.newPath}`);
      return false;
    }
    item.newPath = safe.relative;
    return true;
  });

  filteredPlan = dropInventedPlanPages(filteredPlan, sourceStems, sessionId);

  if (filteredPlan.length === 0) {
    throw new Error('Migration plan contained no writable source files. Please try again with a clearer prompt.');
  }

  const coverageExtras = ensurePlanCoversAllSourceFiles(filteredPlan, essentialFilesMap, toTech);
  if (coverageExtras.length > 0) {
    console.log(`[${sessionId}] Adding ${coverageExtras.length} omitted source file(s) to the conversion plan.`);
    filteredPlan.push(...coverageExtras);
  }

  console.log(`[${sessionId}] Blueprint built. Total files to convert: ${filteredPlan.length}`);
  report('blueprint', `Blueprint ready — ${filteredPlan.length} file(s) planned.`);

  // Group into logical units (Angular triad / React+scss) and dependency order
  migrationUnits = groupPlanIntoMigrationUnits(filteredPlan, toTech);
  console.log(
    `[${sessionId}] Incremental units: ${migrationUnits.length} ` +
    `(from ${filteredPlan.length} planned files). One AI call per unit.`
  );

  writeCheckpoint(sessionId, {
    userPrompt,
    fromTech,
    toTech,
    aiProvider,
    aiModel,
    targetVersion,
    priorityRulesMode,
    projectName,
    designColors,
    units: migrationUnits,
    completedUnitIndex: -1,
    paused: false
  });
  } // end new-plan (not resume)

  if (!migrationUnits || migrationUnits.length === 0) {
    throw new Error('Migration plan contained no writable units. Please try again with a clearer prompt.');
  }

  // -----------------------------------------------------------------------
  // 4. AGENT STEP 2: Write each UNIT (small → large), build, fix, then next
  // -----------------------------------------------------------------------
  const fileWriterSystemInstruction = `
You are an elite Senior Frontend Engineer executing a framework translation.
You write ONE logical UNIT per response. A unit is:
- one file (service, util, routes, config-in-src), OR
- an Angular component triad (.ts + .html + .scss) written together, OR
- a React component (.tsx + optional .scss).

OUTPUT FORMAT:
- If more than one target file is listed, write EVERY listed file using this marker format (not JSON, not markdown fences around the whole response):
===== FILE: exact/path =====
<complete contents of THAT file only>
===== END =====
- If only one file is listed, markers are still preferred; raw code for that single file is also accepted.
- Never put HTML inside a .ts file or TypeScript inside a .html file.
- Never add comments like "// src/app/foo.component.html" inside a file body.

PER-FILE TYPE RULES:
- Angular .ts: TypeScript only. Use templateUrl/styleUrl. No HTML markup or CSS rules in the .ts file.
- Angular .html: HTML only with Tailwind utility classes. No TypeScript, no CSS/SCSS.
- Angular .scss: SCSS/CSS only. Prefer empty/minimal SCSS — styling belongs in Tailwind in the HTML. Empty files: /* component */
- Angular layout: keep converted files under src/app (pages, components, services, lib). Do not invent a starter-kit core/shared/store tree.
- React component: functional + hooks + TypeScript in a .tsx file. Tailwind className utilities; companion styles use .scss only.
- React .scss: minimal SCSS only; prefer Tailwind in JSX.
- Write COMPLETE code. No placeholders, no truncation, no "..." shortcuts.

CRITICAL RULES:
0. USER PROMPT FIRST: obey the user's migration mandate exactly (titles, colors, themes, branding, scope). Do NOT hallucinate packages, exports, APIs, files, or features that are not real / not requested / not required by the source conversion.
1. You are ONLY generating source code files (components, styles, utilities). Configuration files like package.json, tsconfig.json, vite.config.ts, angular.json are ALREADY provided and should NOT be generated.
2. For React: The main App component MUST be at src/App.tsx (NOT src/app/app.tsx). Import it as 'import App from "./App"' (NOT './app/app').
3. For React: pages, components, layouts, and ANY file that returns JSX MUST be .tsx — never .ts. Only utils, hooks, services, stores, and types stay .ts. If a listed path ends in .ts but the code has JSX, write it as the same path with .tsx.
4. DO NOT create Angular-style directory structures (src/app/ subdirectory) for React projects.
5. MANDATORY USER REQUIREMENTS override source defaults: if the user specifies titles, colors, theme values, or branding, apply those exact values in these files. Do NOT keep old source titles/colors when the user asked to change them.
6. For Angular components: use templateUrl and styleUrl in the .ts file. Put ALL HTML markup in the .html file (with Tailwind classes) and ALL leftover styles in the .scss file (styleUrl: './name.component.scss'). NEVER use .css, inline template, or styles property.
7. Files in the same unit must stay consistent (same title text, colors, and layout).
8. Each ===== FILE ===== body must contain ONLY that path's contents — never concatenate siblings into one body.
9. Angular standalone components MUST set standalone: true. If the template uses *ngIf, *ngFor, ngClass, ngStyle, or async pipe, import CommonModule from '@angular/common' (NOT from '@angular/core') and list it in the @Component imports array. Prefer @if / @for built-in control flow when possible.
10. Class name MUST match the file: avatar.component.ts → export class AvatarComponent (never AppComponent unless the file is app.component.ts).
11. Import RxJS symbols (Subject, takeUntil, map, etc.) from 'rxjs' — never from '@angular/core'.
12. Import Input, Output, inject, Injectable, Component from '@angular/core'. Do not use import type for symbols passed to inject().
13. Use WritableSignal (from signal()) when calling .set(); plain Signal is read-only.
14. Getters are NOT callable in templates: use avatarClasses not avatarClasses(). Methods that need () must be real methods, not get accessors.
15. Do not reference private fields in templates — use protected or public.
16. Path aliases that exist in the workspace: @/* → src/*, @app/* → src/app/*, @env/* → src/environments/*. Prefer relative imports under src/app. Do NOT invent @core/@shared/@store/@configs unless those folders exist in THIS conversion. Emit real src/lib/*.ts files when a cn() helper is needed.
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
29. app.routes.ts must import page components from their real files, never from './app.component'. Always \`export const routes\`. Include a route for every converted page.
30. Form error checks: use errors?.['required'] / errors?.['minlength'] bracket access.
31. HTML must be balanced and complete — no truncated templates (Unexpected EOF).
32. TARGET VERSION: Obey the TARGET VERSION MANDATE block exactly. If the user prompt names Angular/React version → that version; else latest stable. Never write a different major into package.json. Follow a clean folder structure (Angular: src/app with pages/components/services; React: components|features|hooks|lib|services) and high code quality.
33. Do NOT generate app.module.ts for modern Angular — standalone only. Child <app-*> components must be in the parent imports array.
34. STYLING MANDATE: All UI styling = Tailwind CSS utilities. All style files = .scss (never .css). Global: Angular src/styles.scss, React src/index.scss.
35. INCREMENTAL MIGRATION: Prefer code that compiles with only units written so far. Avoid importing files that are not yet generated; use temporary stubs or omit unfinished route entries until those units land.
36. COMPLETE CONVERSION: There is NO starter-kit template. Convert every source feature into real target files. Do not skip CRUD/admin/settings pages. You may overwrite stub app.component / app.routes / App.tsx.
37. ENVIRONMENTS: src/environments/environment*.ts start as { production }. Extend with keys the converted code needs in the SAME unit.
38. For React: @ngxs/store → zustand (\`import { create } from 'zustand'\`). No @State, @Action, Store.dispatch(new X()), or provideStore. Export a useXStore hook with the same CRUD methods.
39. For React: @angular/material → @mui/material. MatSidenav → Drawer, MatDialog → Dialog/DialogTitle/DialogContent/DialogActions, MatToolbar → AppBar+Toolbar, mat-icon → Icon (Material Icons font) or lucide-react, mat-button → Button, mat-icon-button → IconButton. Do not leave mat-* tags or @angular/material imports in React files.
40. Write COMPLETE files. Never truncate, never end with "...", never skip a listed unit. If a file uses JSX it MUST be .tsx.
`;

  const generatedFiles = {};
  let npmInstallDone = false;
  const skippedUnits = [];
  let indexesToWrite = [];
  for (let i = startUnitIndex; i < migrationUnits.length; i += 1) indexesToWrite.push(i);
  const sourceStack = detectSourceStack(essentialFilesMap, sourcePackageJson);
  const stackMappingHint = targetLower.includes('react')
    ? `
[SOURCE STACK → REACT MAPPING — MANDATORY]
${sourceStack.ngxs ? '- NGXS (@ngxs/store, @State, actions) → zustand create() store hook. Same CRUD methods, no decorators, no dispatch(new Action()).' : '- No NGXS in source.'}
${sourceStack.material ? '- Angular Material → @mui/material (Drawer, Dialog, AppBar, Toolbar, Button, IconButton, Icon). No mat-* tags, no @angular/material imports.' : '- No Angular Material in source.'}
`
    : '';

  const unitWriterSystemInstruction = `${fileWriterSystemInstruction}

UNIT OUTPUT FORMAT (MANDATORY):
Write EVERY file in the unit in ONE response using this exact marker format (not JSON):
===== FILE: src/path/to/file.ts =====
<complete file contents>
===== FILE: src/path/to/file.html =====
<complete file contents>
===== END =====
Do not wrap the whole response in markdown fences. Each file must be complete.`;

  for (let pass = 0; pass < 2; pass += 1) {
    if (pass === 1) {
      if (skippedUnits.length === 0) break;
      indexesToWrite = skippedUnits.map((s) => (typeof s === 'object' ? s.index : -1)).filter((i) => i >= 0);
      if (indexesToWrite.length === 0) break;
      console.log(`[${sessionId}] Retrying ${indexesToWrite.length} skipped unit(s)...`);
      report('unit', `Retrying ${indexesToWrite.length} skipped unit(s)...`);
      skippedUnits.length = 0;
    }

  for (const unitIndex of indexesToWrite) {
    let unit = migrationUnits[unitIndex];
    if (targetLower.includes('react')) {
      unit = coerceReactMigrationUnit(unit);
      migrationUnits[unitIndex] = unit;
      if (!unit.files.length) {
        console.log(`[${sessionId}] Skipping empty React unit ${unit.label} after Angular triad remap`);
        continue;
      }
    }
    if (targetLower.includes('react') && (unit.files || []).every((f) => isReactScaffoldPath(f.newPath))) {
      console.log(`[${sessionId}] Skipping React scaffold unit ${unit.label} (workspace template provides it)`);
      continue;
    }
    if (targetLower.includes('angular') && isIgnorableAngularUnit(unit)) {
      console.log(
        `[${sessionId}] Skipping Angular scaffold/misplaced App unit ${unit.label} (template provides src/app/app.component)`
      );
      continue;
    }
    report(
      'unit',
      `Converting unit ${unitIndex + 1}/${migrationUnits.length}: ${unit.label}`,
      { unitIndex: unitIndex + 1, unitTotal: migrationUnits.length }
    );
    console.log(
      `[${sessionId}] Unit [${unitIndex + 1}/${migrationUnits.length}] -> ${unit.label} ` +
      `(${unit.files.length} file${unit.files.length > 1 ? 's' : ''}, 1 AI call)`
    );

    const targetSpecificContext = sourceContextForUnit(unit, essentialFilesMap);
    const expectedPaths = unit.files.map((f) => f.newPath);
    const unitPrompt = `
[TARGET FILES IN THIS UNIT]
${expectedPaths.map((p) => `- ${p}`).join('\n')}

[RELEVANT SOURCE CODE]
${targetSpecificContext || '(no matched source files — convert from the unit purpose)'}

[USER MIGRATION REQUIREMENTS]
${userPrompt}

[PURPOSE]
${unit.files.map((f) => `- ${f.newPath}: ${f.explanationOfSource || unit.label}`).join('\n')}
${isSameFramework ? 'Keep the same framework. Convert fully — do not strip features.' : `Target framework: ${toTech}`}
${stackMappingHint}
Write ALL files listed above in one response using ===== FILE: path ===== markers.
Each marker body is ONLY that file's contents (tsx stays tsx, ts stays ts UNLESS it contains JSX — then use .tsx, html stays html, scss stays scss).
Never write placeholder pages (no "HomeComponent placeholder", no empty stub classes). Convert the real source UI, including lucide-react icons as inline SVG.
`;

    let bundleRaw = null;
    let parsedFiles = [];
    const maxUnitAttempts = 6;
    let unitPromptAttempt = unitPrompt;
    for (let attempt = 1; attempt <= maxUnitAttempts; attempt++) {
      try {
        bundleRaw = await callLLM(unitWriterSystemInstruction, unitPromptAttempt, false, aiProvider, aiModel);
        parsedFiles = parseUnitFileBundle(bundleRaw, expectedPaths);
        const placeholders = parsedFiles.filter((f) =>
          isPlaceholderGeneratedFile(f.path, f.content)
        );
        if (placeholders.length > 0) {
          console.warn(
            `[${sessionId}] Placeholder output for ${unit.label} (attempt ${attempt}/${maxUnitAttempts}) — retrying`
          );
          bundleRaw = null;
          parsedFiles = [];
          unitPromptAttempt = `${unitPrompt}

CRITICAL: Do NOT write placeholder text like "HomeComponent placeholder" or empty stub classes.
Do NOT truncate files (unbalanced braces or trailing "..."). Write COMPLETE source.
Convert the SOURCE files into a real working UI: Tailwind in templates, lucide-react icons as inline <svg>, real state and handlers.`;
          continue;
        }
        if (parsedFiles.length > 0) break;
        bundleRaw = null;
      } catch (err) {
        const rateLimited = err instanceof AllProvidersRateLimitedError || err?.status === 429;
        if (rateLimited) {
          const waitMs = Math.min(120000, Math.max(15000, getRetryAfterMs(err, 30000) * attempt));
          console.warn(
            `[${sessionId}] Rate limited on unit ${unit.label}. ` +
            `Waiting ${Math.round(waitMs / 1000)}s then retrying (${attempt}/${maxUnitAttempts})...`
          );
          report(
            'unit',
            `Rate limited — waiting ${Math.round(waitMs / 1000)}s, then continuing unit ${unitIndex + 1}/${migrationUnits.length}...`,
            { unitIndex: unitIndex + 1, unitTotal: migrationUnits.length }
          );
          await pause(waitMs);
          continue;
        }
        console.error(
          `[${sessionId}] LLM call failed for unit ${unit.label} ` +
          `(attempt ${attempt}/${maxUnitAttempts}):`,
          err.message
        );
        if (attempt < maxUnitAttempts) {
          await pause(4000);
        }
      }
    }

    if (!bundleRaw || parsedFiles.length === 0) {
      if (targetLower.includes('angular')) {
        const synthesized = synthesizeAngularUnitFromReact(unit, essentialFilesMap);
        if (synthesized.length > 0) {
          parsedFiles = synthesized;
          bundleRaw = 'synthesized-from-react-source';
          console.log(`[${sessionId}] Synthesized Angular unit from React source: ${unit.label}`);
        }
      } else if (targetLower.includes('react')) {
        const synthesized = synthesizeReactUnitFromAngular(unit, essentialFilesMap);
        if (synthesized.length > 0) {
          parsedFiles = synthesized;
          bundleRaw = 'synthesized-from-angular-source';
          console.log(`[${sessionId}] Synthesized React unit from Angular source: ${unit.label}`);
        }
      }
    }

    if (!bundleRaw || parsedFiles.length === 0) {
      console.warn(
        `[${sessionId}] Unit ${unit.label} failed after ${maxUnitAttempts} attempts — will not ship a stub.`
      );
      skippedUnits.push({ index: unitIndex, label: unit.label });
      report(
        'unit',
        `Unit ${unitIndex + 1}/${migrationUnits.length} (${unit.label}) did not convert — continuing remaining units, then failing if incomplete.`,
        { unitIndex: unitIndex + 1, unitTotal: migrationUnits.length }
      );
      writeCheckpoint(sessionId, {
        userPrompt,
        fromTech,
        toTech,
        aiProvider,
        aiModel,
        targetVersion,
        priorityRulesMode,
        projectName,
        designColors,
        units: migrationUnits,
        completedUnitIndex: unitIndex,
        paused: false,
        skippedUnit: unit.label
      });
      if (unitIndex < migrationUnits.length - 1) {
        await pause(RATE_LIMIT_PAUSE_MS);
      }
      continue;
    }

    let wroteAllExpected = true;
    for (const fileTarget of unit.files) {
      const expected = fileTarget.newPath.replace(/\\/g, '/');
      const expectedExt = path.posix.extname(expected).toLowerCase();
      if (targetLower.includes('react') && isReactScaffoldPath(expected)) {
        continue;
      }
      if (targetLower.includes('react') && expectedExt === '.html') {
        continue;
      }
      const match = matchUnitBundleFile(parsedFiles, expected);
      if (!match) {
        if (expectedExt === '.scss' || expectedExt === '.css') {
          const scssHint = expected.replace(/\.css$/i, '.scss');
          const safeScss = resolveSafeWritePath(migrationWorkspacePath, scssHint) ||
            resolveSafeWritePath(migrationWorkspacePath, expected);
          if (safeScss) {
            ensureDirectoryExists(path.dirname(safeScss.full));
            const scssBody = '/* component */\n';
            fs.writeFileSync(safeScss.full, scssBody, 'utf-8');
            generatedFiles[safeScss.relative] = scssBody;
            console.log(`[${sessionId}]   Wrote ${safeScss.relative} (empty SCSS companion)`);
            continue;
          }
        }
        const requiredCode = /\.(tsx|ts|jsx|js)$/i.test(expected) && !isReactScaffoldPath(expected);
        if (requiredCode) {
          console.warn(`[${sessionId}] Unit bundle missing ${fileTarget.newPath} — incomplete unit`);
          wroteAllExpected = false;
        } else {
          console.warn(`[${sessionId}] Unit bundle missing optional ${fileTarget.newPath} — continuing`);
        }
        continue;
      }
      let body = match.content;
      if (targetLower.includes('react') && /\.(ts|tsx|js|jsx)$/i.test(expected)) {
        body = rewriteReactAngularLeftovers(body);
      }
      const writeHint = targetLower.includes('react') && fileContainsJsx(body)
        ? expected.replace(/\.ts$/, '.tsx')
        : fileTarget.newPath;
      const safePath = resolveSafeWritePath(migrationWorkspacePath, writeHint) ||
        resolveSafeWritePath(migrationWorkspacePath, fileTarget.newPath);
      if (!safePath) {
        console.log(`[${sessionId}] Refusing unsafe write path: ${fileTarget.newPath}`);
        wroteAllExpected = false;
        continue;
      }
      const trimmedContent = sanitizeGeneratedContent(safePath.relative, body);
      let destRel = safePath.relative;
      let destFull = safePath.full;
      if (targetLower.includes('react')) {
        const dest = reactDestinationForContent(migrationWorkspacePath, safePath.relative, trimmedContent);
        destRel = dest.relative;
        destFull = dest.full;
        ensureDirectoryExists(path.dirname(destFull));
        if (dest.staleTsFull && dest.staleTsFull !== destFull) unlinkIfExists(dest.staleTsFull);
        if (destRel.endsWith('.tsx')) unlinkIfExists(destFull.replace(/\.tsx$/, '.ts'));
      } else {
        ensureDirectoryExists(path.dirname(destFull));
      }
      fs.writeFileSync(destFull, trimmedContent, 'utf-8');
      generatedFiles[destRel] = trimmedContent;
      console.log(`[${sessionId}]   Wrote ${destRel}`);
    }
    if (!wroteAllExpected && targetLower.includes('angular')) {
      const synthesized = synthesizeAngularUnitFromReact(unit, essentialFilesMap);
      for (const fileTarget of unit.files) {
        const expected = fileTarget.newPath.replace(/\\/g, '/');
        if (matchUnitBundleFile(parsedFiles, expected)) continue;
        const syn = matchUnitBundleFile(synthesized, expected);
        if (!syn) continue;
        const safePath = resolveSafeWritePath(migrationWorkspacePath, expected);
        if (!safePath) continue;
        ensureDirectoryExists(path.dirname(safePath.full));
        const trimmedContent = sanitizeGeneratedContent(safePath.relative, syn.content);
        fs.writeFileSync(safePath.full, trimmedContent, 'utf-8');
        generatedFiles[safePath.relative] = trimmedContent;
        console.log(`[${sessionId}]   Wrote ${safePath.relative} (synthesized from React source)`);
        parsedFiles.push(syn);
      }
      wroteAllExpected = unit.files.every((f) => {
        const expected = f.newPath.replace(/\\/g, '/');
        if (/\.(scss|css)$/i.test(expected)) return true;
        return Boolean(
          generatedFiles[expected] ||
            matchUnitBundleFile(parsedFiles, expected) ||
            fs.existsSync(path.join(migrationWorkspacePath, expected))
        );
      });
    }
    if (!wroteAllExpected && targetLower.includes('react')) {
      const synthesized = synthesizeReactUnitFromAngular(unit, essentialFilesMap);
      for (const fileTarget of unit.files) {
        const expected = fileTarget.newPath.replace(/\\/g, '/');
        if (/\.html$/i.test(expected)) continue;
        if (matchUnitBundleFile(parsedFiles, expected)) continue;
        const syn = matchUnitBundleFile(synthesized, expected);
        if (!syn) continue;
        const writeHint =
          targetLower.includes('react') && fileContainsJsx(syn.content)
            ? expected.replace(/\.ts$/, '.tsx')
            : expected;
        const safePath = resolveSafeWritePath(migrationWorkspacePath, writeHint) ||
          resolveSafeWritePath(migrationWorkspacePath, expected);
        if (!safePath) continue;
        let destRel = safePath.relative;
        let destFull = safePath.full;
        const dest = reactDestinationForContent(migrationWorkspacePath, safePath.relative, syn.content);
        destRel = dest.relative;
        destFull = dest.full;
        ensureDirectoryExists(path.dirname(destFull));
        if (dest.staleTsFull && dest.staleTsFull !== destFull) unlinkIfExists(dest.staleTsFull);
        if (destRel.endsWith('.tsx')) unlinkIfExists(destFull.replace(/\.tsx$/, '.ts'));
        const trimmedContent = sanitizeGeneratedContent(destRel, syn.content);
        fs.writeFileSync(destFull, trimmedContent, 'utf-8');
        generatedFiles[destRel] = trimmedContent;
        generatedFiles[expected] = trimmedContent;
        console.log(`[${sessionId}]   Wrote ${destRel} (synthesized from Angular source)`);
        parsedFiles.push(syn);
      }
      wroteAllExpected = unit.files.every((f) => {
        const expected = f.newPath.replace(/\\/g, '/');
        if (/\.(scss|css|html)$/i.test(expected)) return true;
        const tsxTwin = expected.replace(/\.ts$/, '.tsx');
        return Boolean(
          generatedFiles[expected] ||
            generatedFiles[tsxTwin] ||
            matchUnitBundleFile(parsedFiles, expected) ||
            fs.existsSync(path.join(migrationWorkspacePath, expected)) ||
            fs.existsSync(path.join(migrationWorkspacePath, tsxTwin))
        );
      });
    }
    if (!wroteAllExpected) {
      skippedUnits.push({ index: unitIndex, label: `${unit.label} (incomplete file set)` });
    }

    writeCheckpoint(sessionId, {
      userPrompt,
      fromTech,
      toTech,
      aiProvider,
      aiModel,
      targetVersion,
      priorityRulesMode,
      projectName,
      designColors,
      units: migrationUnits,
      completedUnitIndex: unitIndex,
      paused: false
    });

    // Periodic compile check — skip most units to save free-tier time/quota.
    // Failures do NOT stop the conversion; the final build still tries to fix.
    const isLastUnit = unitIndex === migrationUnits.length - 1;
    const shouldBuildNow =
      (targetLower.includes('angular') || targetLower.includes('react')) &&
      BUILD_EVERY_N_UNITS > 0 &&
      !isLastUnit &&
      (unitIndex + 1) % BUILD_EVERY_N_UNITS === 0;

    if (shouldBuildNow) {
      console.log(
        `[${sessionId}] Checkpoint build after unit ${unitIndex + 1}/${migrationUnits.length}...`
      );
      const buildResult = await verifyBuild(migrationWorkspacePath, toTech, sessionId, npmInstallDone);
      if (buildResult.installOk) npmInstallDone = true;
      if (buildResult.success) {
        console.log(`[${sessionId}] Checkpoint build ✅`);
      } else {
        console.warn(
          `[${sessionId}] Checkpoint build failed — continuing conversion (final fix at the end).\n` +
          (buildResult.errors || '').slice(-800)
        );
        if (targetLower.includes('angular')) repairAngularWorkspace(migrationWorkspacePath, {});
        else if (targetLower.includes('react')) {
          repairReactWorkspace(migrationWorkspacePath, {
            sourcePackageJson,
            sourceFilesMap: essentialFilesMap
          });
        }
      }
    }

    if (pass === 0 && unitIndex < migrationUnits.length - 1) {
      console.log(`[Rate Limiter] Cooling down for ${RATE_LIMIT_PAUSE_MS / 1000}s before next unit...`);
      await pause(RATE_LIMIT_PAUSE_MS);
    }
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
    console.log(`[${sessionId}] Restoring React tooling files (keeping converted src/)...`);
    injectReactWorkspaceTemplates(migrationWorkspacePath, targetVersions.react, { preserveSrc: true });
    ensureReactRuntimeFiles(migrationWorkspacePath);
    console.log(`[${sessionId}] Running React post-generation repairs...`);
    repairReactWorkspace(migrationWorkspacePath, {
      sourcePackageJson,
      sourceFilesMap: essentialFilesMap
    });
    enforceReactPackageVersions(migrationWorkspacePath, targetVersions.react);
  } else if (targetLower.includes('angular')) {
    console.log(
      `[${sessionId}] Restoring Angular tooling files (keeping converted src/)...`
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
    // Remove leftover src/app only after files have been hoisted into src/
    const srcAppDir = path.join(migrationWorkspacePath, 'src', 'app');
    if (fs.existsSync(srcAppDir)) {
      console.log(`[${sessionId}] Cleaning leftover Angular-style src/app after hoist`);
      fs.rmSync(srcAppDir, { recursive: true, force: true });
    }
  }

  // -----------------------------------------------------------------------
  // 5b. Quality gate — never ship stubs, skipped pages, or a failing build
  // -----------------------------------------------------------------------
  if (targetLower.includes('angular')) {
    const defects = collectConversionDefects(migrationWorkspacePath);
    const missingPages = collectMissingSourcePages(migrationWorkspacePath, essentialFilesMap);
    const problems = [];
    const realSkips = skippedUnits.filter(
      (s) =>
        !isIgnorableAngularUnit({
          label: s.label || s,
          files: [{ newPath: s.label || s }]
        })
    );
    if (realSkips.length) {
      problems.push(`skipped units: ${realSkips.map((s) => s.label || s).join(', ')}`);
    }
    if (defects.placeholders.length) {
      problems.push(`placeholder templates: ${defects.placeholders.join(', ')}`);
    }
    if (missingPages.length) {
      problems.push(`source pages never converted: ${missingPages.join(', ')}`);
    }
    if (problems.length) {
      throw new ConversionIncompleteError(
        `Conversion incomplete — refusing to ship a stub or partial project (${problems.join('; ')}). ` +
        `Retry the conversion, or pick a different free model.`
      );
    }
  } else if (skippedUnits.length) {
    throw new ConversionIncompleteError(
      `Conversion incomplete — skipped units: ${skippedUnits.map((s) => s.label || s).join(', ')}. Refusing to ship a partial project.`
    );
  }

  const buildCheck = await verifyAndFixBuild(
    sessionId,
    migrationWorkspacePath,
    toTech,
    aiProvider,
    aiModel || undefined,
    essentialFilesMap,
    sourcePackageJson
  );
  if (!buildCheck.verified) {
    const tail = String(buildCheck.errors || '').trim().slice(-1200);
    throw new ConversionIncompleteError(
      `Conversion failed: the migrated project did not compile after ${MAX_BUILD_FIX_ATTEMPTS} fix attempts. ` +
      `The ZIP was not created.${tail ? `\n${tail}` : ''}`
    );
  }

  // npm ci sanity check — the delivered project must install + build after only `npm ci`
  const npmCiCheck = await verifyNpmCiBuild(migrationWorkspacePath, toTech, sessionId);
  if (!npmCiCheck.ok) {
    throw new ConversionIncompleteError(
      `Conversion failed: clean npm ci + build did not succeed. The ZIP was not created.\n` +
      `${String(npmCiCheck.errors || '').slice(-1500)}`
    );
  }

  // -----------------------------------------------------------------------
  // 5c. VISUAL QA STAGE (ChatGPT workflow): screenshot comparison
  // -----------------------------------------------------------------------
  let visualQaReport = null;
  if (enableVisualQa && fs.existsSync(extractPath) && fs.existsSync(migrationWorkspacePath)) {
    report('visual-qa', 'Running visual QA — capturing screenshots of source vs migrated...');
    console.log(`[${sessionId}] Visual QA: comparing source vs migrated screenshots...`);
    try {
      const qaOutputDir = path.join(EXTRACT_DIR, `${sessionId}-visual-qa`);
      visualQaReport = await runVisualQa({
        sourcePath: extractPath,
        migratedPath: migrationWorkspacePath,
        sourceTech: fromTech,
        migratedTech: toTech,
        routes: visualQaRoutes,
        outputDir: qaOutputDir,
      });
      console.log(
        `[${sessionId}] Visual QA complete: ${visualQaReport.summary.passed}/${visualQaReport.summary.total} routes passed ` +
        `(avg similarity ${visualQaReport.summary.averageSimilarity})`
      );
      report('visual-qa', `Visual QA complete — ${visualQaReport.summary.passed}/${visualQaReport.summary.total} routes passed.`);
    } catch (qaErr) {
      console.warn(`[${sessionId}] Visual QA failed (continuing without it): ${qaErr.message}`);
      report('visual-qa', 'Visual QA failed — continuing without it.');
    }
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
  clearCheckpoint(sessionId);

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
  const { toTech = 'Unknown', aiProvider = 'openrouter', aiModel, referencePath = null, onProgress } = options;
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
    throw new ConversionIncompleteError(
      `Rework failed: the updated project did not compile after ${MAX_BUILD_FIX_ATTEMPTS} fix attempts. ` +
      `The ZIP was not created.${buildCheck.errors ? `\n${String(buildCheck.errors).slice(-1200)}` : ''}`
    );
  }

  // 5. npm ci sanity check
  const npmCiCheck = await verifyNpmCiBuild(workspacePath, toTech, sessionId);
  if (!npmCiCheck.ok) {
    throw new ConversionIncompleteError(
      `Rework failed: clean npm ci + build did not succeed. The ZIP was not created.\n` +
      `${String(npmCiCheck.errors || '').slice(-1500)}`
    );
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
