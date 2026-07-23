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
    defaultModel: 'google/gemma-4-31b-it:free',
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:4200',
      'X-Title': 'AI Framework Migration Studio',
    },
    models: []
  },
  genai: {
    name: 'Google Gemini',
    envPrefix: 'GENAI',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']
  },
  ollama: {
    name: 'Ollama (Local)',
    envPrefix: 'OLLAMA',
    defaultBaseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    requiresApiKey: false,
    // Only used in fallback / selection when explicitly enabled.
    models: [
      'llama3.1', 'llama3', 'mistral', 'codellama',
      'deepseek-coder', 'mixtral', 'phi3', 'gemma2',
      'qwen2', 'qwen2.5-coder:7b', 'qwen2.5-coder:3b',
      'qwen2.5-coder:1.5b', 'deepseek-r1'
    ]
  }
};

/**
 * Default order for automatic cross-provider fallback when a provider's
 * keys are exhausted (quota / auth / rate-limit / network / 5xx).
 * Primary (UI-selected) provider is always tried first; then this list minus the primary.
 * Override via AI_FALLBACK_CHAIN=openrouter,genai,ollama
 *
 * Ollama is only included when OLLAMA_ENABLED=true (avoids hanging on dead local server).
 */
export const DEFAULT_PROVIDER_FALLBACK_CHAIN = [
  'openrouter',
  'genai',
  'ollama',
];

/**
 * Builds the provider attempt order for a migration request.
 * Always starts with the user-selected provider (even if not "configured"
 * for auto-fallback — e.g. Ollama selected in UI without OLLAMA_ENABLED).
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
 * Ollama is opt-in via OLLAMA_ENABLED=true so a dead local server does not hang migrations.
 * (Selecting Ollama explicitly in the UI still works via getProviderFallbackChain.)
 */
export function isProviderConfigured(provider) {
  const prov = PROVIDERS[provider];
  if (!prov) return false;

  if (provider === 'ollama') {
    return String(process.env.OLLAMA_ENABLED || '').toLowerCase() === 'true';
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
 * Rate-limit pause between AI file generations (in ms).
 * Helps stay under free-tier TPM quotas.
 */
export const RATE_LIMIT_PAUSE_MS = 5500;