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
  stepfun: {
    name: 'Stepfun',
    envPrefix: 'OPENAI',
    defaultBaseURL: 'https://api.stepfun.ai/v1',
    defaultModel: 'step-3.7-flash',
    models: ['step-3.7-flash', 'step-3.5-flash', 'step-1-flash']
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
    models: [
      'llama3.1', 'llama3', 'mistral', 'codellama',
      'deepseek-coder', 'mixtral', 'phi3', 'gemma2',
      'qwen2', 'qwen2.5-coder:7b', 'qwen2.5-coder:3b',
      'qwen2.5-coder:1.5b', 'deepseek-r1'
    ]
  }
};

/**
 * Returns an array of { baseURL, model, apiKey } configs for the given provider.
 * Multiple API keys are supported via comma-separated env var.
 * When one key hits a quota/rate-limit, the system falls back to the next.
 *
 * @param {string} [provider='stepfun'] - Provider key from the PROVIDERS registry
 * @param {string} [overrideModel] - Optional model override (otherwise uses default)
 * @returns {Array<{baseURL: string, model: string, apiKey: string}>}
 */
export function getProviderConfigs(provider = 'stepfun', overrideModel) {
  const prov = PROVIDERS[provider];
  if (!prov) {
    throw new Error(`Unknown AI provider "${provider}". Valid options: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = process.env[`${prov.envPrefix}_API_KEY`] || '';
  const baseURL = process.env[`${prov.envPrefix}_BASE_URL`] || prov.defaultBaseURL;
  const model = overrideModel || process.env[`${prov.envPrefix}_MODEL`] || prov.defaultModel;

  const keys = apiKey
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    // Return one empty config so callers still get a consistent check
    return [{ baseURL, model, apiKey: '' }];
  }

  return keys.map(apiKey => ({ baseURL, model, apiKey }));
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
export function getProviderModels(provider = 'stepfun') {
  const prov = PROVIDERS[provider];
  return prov ? prov.models : [];
}

// ---------------------------------------------------------------------------
// Deprecated — kept for backward compatibility; use getProviderConfigs() instead
// ---------------------------------------------------------------------------

export function getOpenAIConfig() {
  const configs = getProviderConfigs('stepfun');
  return configs[0] || { baseURL: '', model: '', apiKey: '' };
}

export function getOpenAIConfigs() {
  return getProviderConfigs('stepfun');
}

/**
 * Rate-limit pause between AI file generations (in ms).
 * Helps stay under free-tier TPM quotas.
 */
export const RATE_LIMIT_PAUSE_MS = 5500;