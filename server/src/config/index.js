import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Framework dependency signatures used for project validation.
 */
export const FRAMEWORK_SIGNATURES = {
  angular: ['@angular/core'],
  react: ['react', 'react-dom']
};

/**
 * Port the migration engine listens on.
 * Override via the PORT environment variable.
 */
export const PORT = process.env.PORT || 5000;

/**
 * Directories for uploads and extracted projects.
 */
export const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
export const EXTRACT_DIR = path.resolve(__dirname, '..', '..', 'extracted');

/**
 * Maximum allowed upload file size (50 MB).
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Folders we MUST skip to avoid crashes or blowing past token limits
 */
export const IGNORED_FOLDERS = new Set([
  'node_modules',
  '.git',
  '.angular',
  'dist',
  'build',
  '.vscode',
  '.idea'
]);

/**
 * Text file extensions that are safe to read and send to the AI.
 */
export const TEXT_EXTENSIONS = [
  '.html', '.css', '.scss', '.sass', '.js', '.jsx',
  '.ts', '.tsx', '.json', '.md', '.txt', '.xml', '.yaml', '.yml',
  '.config.js', '.config.ts', '.mjs', '.cjs'
];

/**
 * Provider registry — maps provider names to their env var prefixes,
 * default endpoints, and available models.
 */
export const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    envPrefix: 'OPENROUTER',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    // Prefer a known free chat model over auto-router (auto can route to paid models).
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:4200',
      'X-Title': 'AI Framework Migration Studio',
    },
    // Only models that currently succeed on the free key. Dead/429-first slugs
    // waste minutes before fallback. Override with OPENROUTER_MODELS=...
    models: [
      'nvidia/nemotron-3-super-120b-a12b:free'
    ]
  },
  genai: {
    name: 'Google Gemini',
    envPrefix: 'GENAI',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.6-flash',
    // Largest Flash first, then next-largest. 2.0 / 2.5 are retired for new keys.
    // Override with GENAI_MODELS=gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite
    models: [
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite'
    ]
  },
  ollama: {
    name: 'Ollama Cloud',
    envPrefix: 'OLLAMA',
    // Cloud OpenAI-compatible endpoint. For local Ollama use:
    // OLLAMA_BASE_URL=http://localhost:11434/v1
    defaultBaseURL: 'https://ollama.com/v1',
    defaultModel: 'gpt-oss:120b',
    // Cloud needs an API key; local mode can run without one.
    requiresApiKey: false,
    // Largest first, then next-largest. Override with OLLAMA_MODELS=...
    models: [
      'gpt-oss:120b',
      'gpt-oss:20b'
    ]
  },
  groq: {
    name: 'Groq',
    envPrefix: 'GROQ',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'groq/compound',
    // Free Groq models only — largest first, then next-largest.
    // Override with GROQ_MODELS=custom/model1,custom/model2
    models: [
      'groq/compound',
      'allam-2-7b',
      'groq/compound-mini'
    ]
  },
  tokenrouter: {
    name: 'TokenRouter',
    envPrefix: 'TOKENROUTER',
    defaultBaseURL: 'https://api.tokenrouter.com/v1',
    defaultModel: 'deepseek/deepseek-v4-pro-0813-free',
    // Free TokenRouter models — largest first (pro → max → nano).
    // Override with TOKENROUTER_MODELS=custom/model1,custom/model2
    models: [
      'deepseek/deepseek-v4-pro-0813-free',
      'qwen/qwen3.8-max-free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
    ]
  }
};

/**
 * True when Ollama is pointed at ollama.com (cloud), not localhost.
 */
export function isOllamaCloudMode() {
  const base =
    process.env.OLLAMA_BASE_URL ||
    PROVIDERS.ollama?.defaultBaseURL ||
    '';
  return /ollama\.com/i.test(base);
}

/**
 * Default order for automatic cross-provider fallback when a provider's
 * keys are exhausted (quota / auth / rate-limit / network / 5xx).
 * Primary (UI-selected) provider is always tried first; then this list minus the primary.
 * Override via AI_FALLBACK_CHAIN=genai,openrouter,ollama
 *
 * Ollama Cloud is included automatically when OLLAMA_API_KEY is set.
 * Local Ollama requires OLLAMA_ENABLED=true.
 */
export const DEFAULT_PROVIDER_FALLBACK_CHAIN = [
  'genai',
  'groq',
  'ollama',
  'openrouter',
  'tokenrouter',
];

/**
 * Builds the provider attempt order for a migration request.
 * Always starts with the user-selected provider (even if not "configured"
 * for auto-fallback — e.g. local Ollama selected without OLLAMA_ENABLED).
 * Then appends remaining chain entries that are configured.
 *
 * @param {string} primaryProvider
 * @returns {string[]}
 */
export function getProviderFallbackChain(primaryProvider = 'openrouter') {
  const fromEnv = (process.env.AI_FALLBACK_CHAIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const base = fromEnv.length > 0 ? fromEnv : DEFAULT_PROVIDER_FALLBACK_CHAIN;
  const knownConfigured = base.filter((id) => PROVIDERS[id] && isProviderConfigured(id));

  const primary = PROVIDERS[primaryProvider] ? primaryProvider : knownConfigured[0];
  if (!primary) {
    return [];
  }

  const rest = knownConfigured.filter((id) => id !== primary);
  return [primary, ...rest];
}

/**
 * Returns whether a provider can be used in the automatic fallback chain.
 * - Ollama Cloud: configured when OLLAMA_API_KEY is set
 * - Ollama Local: configured when OLLAMA_ENABLED=true
 */
export function isProviderConfigured(provider) {
  const prov = PROVIDERS[provider];
  if (!prov) return false;

  if (provider === 'ollama') {
    const apiKey = process.env.OLLAMA_API_KEY || '';
    const hasKey = apiKey
      .split(',')
      .map((k) => k.trim())
      .some(Boolean);

    if (isOllamaCloudMode()) {
      return hasKey;
    }

    // Local Ollama: opt-in so a dead localhost server does not hang migrations.
    return (
      hasKey ||
      String(process.env.OLLAMA_ENABLED || '').toLowerCase() === 'true'
    );
  }

  // Groq: not considered configured unless GROQ_API_KEY is set
  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY || '';
    return apiKey
      .split(',')
      .map((k) => k.trim())
      .some(Boolean);
  }

  // TokenRouter: not considered configured unless TOKENROUTER_API_KEY is set
  if (provider === 'tokenrouter') {
    const apiKey = process.env.TOKENROUTER_API_KEY || '';
    return apiKey
      .split(',')
      .map((k) => k.trim())
      .some(Boolean);
  }

  if (prov.requiresApiKey === false) return true;

  const apiKey = process.env[`${prov.envPrefix}_API_KEY`] || '';
  return apiKey
    .split(',')
    .map((k) => k.trim())
    .some(Boolean);
}

/**
 * Returns an array of { baseURL, model, apiKey, defaultHeaders? } configs.
 * Multiple API keys are supported via comma-separated env var.
 * When one key hits a quota/rate-limit, the system falls back to the next.
 *
 * @param {string} [provider='openrouter'] - Provider key from the PROVIDERS registry
 * @param {string} [overrideModel] - Optional model override (otherwise uses default)
 * @returns {Array<{baseURL: string, model: string, apiKey: string, defaultHeaders?: object}>}
 */
export function getProviderConfigs(provider = 'openrouter', overrideModel) {
  const prov = PROVIDERS[provider];
  if (!prov) {
    throw new Error(`Unknown AI provider "${provider}". Valid options: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = process.env[`${prov.envPrefix}_API_KEY`] || '';
  const baseURL = process.env[`${prov.envPrefix}_BASE_URL`] || prov.defaultBaseURL;
  const model = overrideModel || process.env[`${prov.envPrefix}_MODEL`] || prov.defaultModel;
  const defaultHeaders = prov.defaultHeaders || undefined;

  const keys = apiKey
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    // Return one empty config so callers still get a consistent check
    return [{ baseURL, model, apiKey: '', ...(defaultHeaders ? { defaultHeaders } : {}) }];
  }

  return keys.map(apiKey => ({
    baseURL,
    model,
    apiKey,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  }));
}

/**
 * Returns the list of supported provider IDs.
 */
export function getProviderIds() {
  return Object.keys(PROVIDERS);
}

/**
 * Returns the list of models for a given provider.
 */
export function getProviderModels(provider = 'openrouter') {
  const prov = PROVIDERS[provider];
  return prov ? prov.models : [];
}

/**
 * Builds the ordered list of models to try for a provider's automatic fallback.
 * Order (duplicates removed, first occurrence wins):
 *   1. UI-selected model (primary provider only)
 *   2. Env override (<PREFIX>_MODELS, comma-separated) — server-admin preference
 *   3. Provider's built-in free-model fallback list
 *   4. Provider defaultModel as a final safety net
 *
 * This powers the "model → key → provider" rotation in callLLM(): when a
 * (key, model) pair crosses its rate limit, the next free model on the SAME
 * key is tried before moving to the next key or provider.
 *
 * @param {string} provider - Provider key from the PROVIDERS registry
 * @param {string} [overrideModel] - Model chosen in the UI (primary provider only)
 * @returns {string[]}
 */
export function getProviderFallbackModels(provider = 'openrouter', overrideModel) {
  const prov = PROVIDERS[provider];
  if (!prov) return [];

  const fromEnv = (process.env[`${prov.envPrefix}_MODELS`] || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const candidates = [
    ...(overrideModel ? [overrideModel] : []),
    ...fromEnv,
    ...(prov.models || []),
    ...(prov.defaultModel ? [prov.defaultModel] : [])
  ];

  const seen = new Set();
  const result = [];
  for (const model of candidates) {
    if (!model) continue;
    if (seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }

  return result;
}

/**
 * Rate-limit pause between AI file generations (in ms).
 * Helps stay under free-tier TPM quotas.
 * Override via RATE_LIMIT_PAUSE_MS=2200
 */
export const RATE_LIMIT_PAUSE_MS = parseInt(process.env.RATE_LIMIT_PAUSE_MS, 10) || 2200;

/**
 * Max wait for a single LLM HTTP request. Hung calls fail over to the next
 * model/key/provider instead of blocking the conversion.
 * Override via LLM_REQUEST_TIMEOUT_MS=90000
 */
export const LLM_REQUEST_TIMEOUT_MS = Number.isFinite(parseInt(process.env.LLM_REQUEST_TIMEOUT_MS, 10))
  ? parseInt(process.env.LLM_REQUEST_TIMEOUT_MS, 10)
  : 60000;

/**
 * How often to run a compile check during conversion.
 * 0 = only after every unit is written (final build still always runs).
 * Default 6: better for free-tier quotas (ng build is slow and burns time/tokens).
 * Override via BUILD_EVERY_N_UNITS=8
 */
export const BUILD_EVERY_N_UNITS = Number.isFinite(parseInt(process.env.BUILD_EVERY_N_UNITS, 10))
  ? parseInt(process.env.BUILD_EVERY_N_UNITS, 10)
  : 6;

/**
 * Max build-fix attempts per incremental UNIT before failing the migration.
 * Each unit (e.g. Angular .ts+.html+.scss triad) is written, then built.
 * On failure the AI is asked to fix; after this many failures the pipeline STOPS.
 * Override via MAX_BUILD_FIX_ATTEMPTS=5
 */
export const MAX_BUILD_FIX_ATTEMPTS = parseInt(process.env.MAX_BUILD_FIX_ATTEMPTS, 10) || 3;