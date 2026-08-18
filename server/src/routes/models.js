import { Router } from 'express';

const router = Router();

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/frontend/v1/catalog/models';
const OLLAMA_CLOUD_TAGS_URL = 'https://ollama.com/api/tags';
const GENAI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const TOKENROUTER_MODELS_URL = 'https://api.tokenrouter.com/v1/models';

function firstEnvKey(envName) {
  return (process.env[envName] || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)[0] || '';
}

/**
 * Retryable HTTP status codes — transient failures that may succeed on retry.
 * Includes 400 because TokenRouter occasionally returns 400 for rate-limits.
 */
const RETRYABLE_STATUS_CODES = new Set([400, 429, 500, 502, 503, 504]);

/**
 * In-memory cache for the TokenRouter models catalog.
 * The model list rarely changes, so a short-lived cache dramatically
 * reduces upstream API calls and avoids rate-limiting entirely.
 */
const modelsCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_STALE_TTL_MS = 60 * 60 * 1000; // serve stale for up to 1 hour on failure

function cacheGet(key) {
  const entry = modelsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return { ...entry, fresh: true };
  }
  if (Date.now() - entry.fetchedAt < CACHE_STALE_TTL_MS) {
    return { ...entry, fresh: false };
  }
  modelsCache.delete(key);
  return null;
}

function cacheSet(key, data) {
  modelsCache.set(key, { data, fetchedAt: Date.now() });
}

/**
 * Fetches a URL with automatic retry on transient failures (429 / 5xx),
 * plus an in-memory cache that serves stale data if upstream is rate-limited.
 *
 * @param {string} url - The URL to fetch
 * @param {object} [options] - Fetch options (headers, method, etc.)
 * @param {number} [maxRetries=3] - Maximum number of retry attempts
 * @returns {Promise<{response: Response, fromCache: boolean}>}
 */
async function fetchWithRetryAndCache(url, options = {}, maxRetries = 3) {
  // 1. Return fresh cache immediately (no upstream call at all)
  const cached = cacheGet(url);
  if (cached?.fresh) {
    return { response: jsonResponse(cached.data), fromCache: true };
  }

  // 2. Try upstream with retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter: 700ms, 1.4s, 2.8s (keep below ~3s)
      const baseDelay = 700 * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
    }

    try {
      const response = await fetch(url, options);

      if (response.ok) {
        // Parse and cache the JSON response
        const data = await response.json();
        cacheSet(url, data);
        return {
          response: new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
          fromCache: false,
        };
      }

      // Non-OK from upstream
      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        // Non-transient error (e.g. 401/403/404) — serve stale cache if we have it
        if (cached) {
          return { response: jsonResponse(cached.data), fromCache: true, stale: true };
        }
        return { response, fromCache: false };
      }

      // Transient error — respect Retry-After if provided
      if (attempt < maxRetries) {
        const retryAfter = response.headers?.get?.('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          if (Number.isFinite(seconds) && seconds > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(seconds * 1000, 8000)));
          }
        }
      }
    } catch (err) {
      // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
      if (attempt === maxRetries) {
        if (cached) {
          return { response: jsonResponse(cached.data), fromCache: true, stale: true };
        }
        throw err;
      }
    }
  }

  // 3. Upstream failed on all retries — serve stale cache if present, else last response
  if (cached) {
    return { response: jsonResponse(cached.data), fromCache: true, stale: true };
  }
  return { response: jsonResponse({ error: 'Upstream fetch failed after retries.' }, 502), fromCache: false };
}

/** Helper to build a synthetic Response from cached JSON data. */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A catalog entry is free when its primary endpoint is marked is_free.
 */
function isFreeOpenRouterModel(model) {
  return model?.endpoint?.is_free === true;
}

/**
 * Only chat/text-generation models — skip embeddings / rerank / etc.
 */
function isChatCapableOpenRouterModel(model) {
  if (model?.has_text_output === false) return false;

  const modalities = model?.output_modalities;
  if (Array.isArray(modalities) && modalities.length > 0) {
    return modalities.includes('text');
  }

  return true;
}

/**
 * Gemini "free-tier usable" chat models: generateContent + gemini* family.
 * (Google does not expose an is_free flag; free-tier keys can call these within quota.)
 */
function isGeminiChatModel(model) {
  const name = String(model?.name || '').toLowerCase();
  const methods = model?.supportedGenerationMethods || [];
  if (!methods.includes('generateContent')) return false;
  if (!name.includes('gemini')) return false;
  if (name.includes('embed') || name.includes('imagen') || name.includes('aqa')) return false;
  // Prefer stable aliases; skip ultra-long dated preview duplicates when possible
  return true;
}

function geminiModelId(model) {
  return String(model?.name || '').replace(/^models\//, '');
}

/**
 * GET /api/models/openrouter
 * Proxies OpenRouter catalog and returns only free chat models.
 */
router.get('/models/openrouter', async (req, res) => {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL);
    if (!response.ok) {
      return res.status(502).json({
        error: `Failed to fetch OpenRouter models (HTTP ${response.status}).`,
      });
    }

    const payload = await response.json();
    const models = payload?.data;

    if (!Array.isArray(models)) {
      return res.status(502).json({ error: 'Unexpected OpenRouter models response shape.' });
    }

    const freeModels = models
      .filter(
        (model) =>
          !model?.hidden &&
          !model?.endpoint?.is_hidden &&
          !model?.endpoint?.is_disabled &&
          isFreeOpenRouterModel(model) &&
          isChatCapableOpenRouterModel(model)
      )
      .map((model) => ({
        id: model.endpoint?.model_variant_slug || model.slug,
        label: model.name || model.short_name || model.slug,
      }));

    res.json({ models: freeModels });
  } catch (err) {
    console.error('OpenRouter models fetch failed:', err);
    res.status(502).json({
      error: err.message || 'Failed to fetch OpenRouter free models.',
    });
  }
});

/**
 * GET /api/models/ollama
 * Lists Ollama Cloud models (requires OLLAMA_API_KEY).
 */
router.get('/models/ollama', async (req, res) => {
  try {
    const apiKey = firstEnvKey('OLLAMA_API_KEY');
    if (!apiKey) {
      return res.status(503).json({
        error: 'OLLAMA_API_KEY is not set. Add it in server/.env to load Ollama Cloud models.',
      });
    }

    const response = await fetch(OLLAMA_CLOUD_TAGS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Failed to fetch Ollama Cloud models (HTTP ${response.status}).`,
      });
    }

    const payload = await response.json();
    const models = payload?.models;

    if (!Array.isArray(models)) {
      return res.status(502).json({ error: 'Unexpected Ollama models response shape.' });
    }

    const mapped = models
      .map((model) => {
        const id = model?.model || model?.name;
        if (!id) return null;
        return {
          id,
          label: model?.name || id,
        };
      })
      .filter(Boolean)
      // De-dupe by id
      .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);

    res.json({ models: mapped });
  } catch (err) {
    console.error('Ollama Cloud models fetch failed:', err);
    res.status(502).json({
      error: err.message || 'Failed to fetch Ollama Cloud models.',
    });
  }
});

/**
 * GET /api/models/genai
 * Lists Gemini chat models available to the configured API key.
 */
router.get('/models/genai', async (req, res) => {
  try {
    const apiKey = firstEnvKey('GENAI_API_KEY');
    if (!apiKey) {
      return res.status(503).json({
        error: 'GENAI_API_KEY is not set. Add it in server/.env to load Gemini models.',
      });
    }

    const url = new URL(GENAI_MODELS_URL);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '100');

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({
        error: `Failed to fetch Gemini models (HTTP ${response.status}).`,
      });
    }

    const payload = await response.json();
    const models = payload?.models;

    if (!Array.isArray(models)) {
      return res.status(502).json({ error: 'Unexpected Gemini models response shape.' });
    }

    const mapped = models
      .filter(isGeminiChatModel)
      .map((model) => {
        const id = geminiModelId(model);
        return {
          id,
          label: model.displayName ? `${model.displayName} (${id})` : id,
        };
      })
      .filter((m) => m.id)
      .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
      // Prefer flash models first for free-tier friendliness
      .sort((a, b) => {
        const af = a.id.includes('flash') ? 0 : 1;
        const bf = b.id.includes('flash') ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.id.localeCompare(b.id);
      });

    res.json({ models: mapped });
  } catch (err) {
    console.error('Gemini models fetch failed:', err);
    res.status(502).json({
      error: err.message || 'Failed to fetch Gemini models.',
    });
  }
});

/**
 * Known best/popular Groq free models to sort to the top of the dropdown.
 * Ordered by quality/speed preference.
 */
const TOP_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.3-70b-specdec',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
  'llama-3.2-3b-preview',
  'llama-3.2-1b-preview',
];

/**
 * Models to exclude (non-chat, embeddings, etc.)
 */
const EXCLUDED_GROQ_MODELS = new Set([
  'whisper-large-v3',
  'whisper-large-v3-turbo',
  'distil-whisper-large-v3-en',
  'llama-guard-3-8b',
]);

/**
 * A Groq model is free when its pricing.prompt is 0 or undefined.
 * Groq exposes pricing in the API response — models with no prompt price
 * (or a zero prompt price) are free-tier accessible.
 */
function isFreeGroqModel(model) {
  const pricing = model?.pricing;
  if (!pricing) return true; // no pricing info → assume free
  const prompt = parseFloat(pricing.prompt);
  const completion = parseFloat(pricing.completion);
  // Free if both prompt and completion are 0 or undefined/NaN
  return (Number.isNaN(prompt) || prompt === 0) && (Number.isNaN(completion) || completion === 0);
}

/**
 * GET /api/models/groq
 * Fetches all models from Groq API and returns only free chat models.
 * Groq exposes pricing in the API response — models with zero/undefined
 * pricing are free-tier accessible.
 */
router.get('/models/groq', async (req, res) => {
  try {
    const apiKey = firstEnvKey('GROQ_API_KEY');
    if (!apiKey) {
      return res.status(503).json({
        error: 'GROQ_API_KEY is not set. Add it in server/.env to load Groq models.',
      });
    }

    const response = await fetch(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Failed to fetch Groq models (HTTP ${response.status}).`,
      });
    }

    const payload = await response.json();
    const models = payload?.data;

    if (!Array.isArray(models)) {
      return res.status(502).json({ error: 'Unexpected Groq models response shape.' });
    }

    // Filter to free chat models only, then sort with best models first
    const mapped = models
      .filter((model) => {
        const id = String(model?.id || '');
        // Filter out whisper/llama-guard (non-chat) models AND paid models
        return (
          !EXCLUDED_GROQ_MODELS.has(id) &&
          !id.includes('whisper') &&
          isFreeGroqModel(model)
        );
      })
      .map((model) => ({
        id: model.id,
        label: model.id,
      }))
      .filter((m) => m.id)
      .sort((a, b) => {
        const aIdx = TOP_GROQ_MODELS.indexOf(a.id);
        const bIdx = TOP_GROQ_MODELS.indexOf(b.id);
        // Known top models first, sorted by their index in TOP_GROQ_MODELS
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        // Alphabetical for the rest
        return a.id.localeCompare(b.id);
      });

    res.json({ models: mapped });
  } catch (err) {
    console.error('Groq models fetch failed:', err);
    res.status(502).json({
      error: err.message || 'Failed to fetch Groq models.',
    });
  }
});

/**
 * Models to exclude (non-chat, embeddings, etc.)
 */
const EXCLUDED_TOKENROUTER_MODELS = new Set([
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002',
]);

/**
 * Static fallback list of known free TokenRouter models.
 * Used when the upstream API is unavailable (rate-limited / down) so the
 * endpoint NEVER returns a 502 — the frontend always gets a valid model list.
 * This list mirrors the actual free models returned by the TokenRouter API
 * (models whose ID contains "free").
 */
const FALLBACK_TOKENROUTER_MODELS = [
  'deepseek/deepseek-v4-pro-0813-free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'qwen/qwen3.8-max-free',
];

/**
 * Known free TokenRouter models.
 * TokenRouter does not expose an is_free flag in its API response,
 * so we identify free models by checking if the model ID contains
 * "free" (e.g. `:free` suffix, `-free` suffix, or `-free` anywhere).
 *
 * Override with TOKENROUTER_MODELS in .env for a custom free-model list.
 */
function isFreeTokenRouterModel(model) {
  const id = String(model?.id || '');
  // Match any model ID that includes "free" (case-insensitive):
  //   - nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
  //   - deepseek/deepseek-v4-pro-0813-free
  //   - qwen/qwen3.8-max-free
  return /free/i.test(id);
}

/**
 * GET /api/models/tokenrouter
 * Fetches all models from TokenRouter API and returns only free chat models.
 * TokenRouter provides access to models across 13 providers (OpenAI, Anthropic, Google, etc.).
 * Free models are identified by an explicit allowlist and the :free naming convention.
 */
router.get('/models/tokenrouter', async (req, res) => {
  try {
    const apiKey = firstEnvKey('TOKENROUTER_API_KEY');
    if (!apiKey) {
      return res.status(503).json({
        error: 'TOKENROUTER_API_KEY is not set. Add it in server/.env to load TokenRouter models.',
      });
    }

    let { response } = await fetchWithRetryAndCache(TOKENROUTER_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // Upstream fetch failed even after retries — serve the static fallback
    // list so the frontend NEVER sees a 502/503 from this endpoint.
    if (!response.ok || response.status !== 200) {
      console.warn(
        `[TokenRouter] Upstream returned HTTP ${response.status} — using static fallback model list.`
      );
      return res.json({
        models: FALLBACK_TOKENROUTER_MODELS.map((id) => ({ id, label: id })),
      });
    }

    const payload = await response.json();
    const models = payload?.data;

    if (!Array.isArray(models)) {
      // Unexpected response shape — serve static fallback so we never 502.
      console.warn('[TokenRouter] Unexpected response shape — using static fallback model list.');
      return res.json({
        models: FALLBACK_TOKENROUTER_MODELS.map((id) => ({ id, label: id })),
      });
    }

    // Filter out non-free and non-chat models, then map to {id, label}
    const mapped = models
      .filter((model) => {
        const id = String(model?.id || '');
        return isFreeTokenRouterModel(model) && !EXCLUDED_TOKENROUTER_MODELS.has(id) && !id.includes('embedding');
      })
      .map((model) => ({
        id: model.id,
        label: model.id,
      }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));

    res.json({ models: mapped });
  } catch (err) {
    // Any unexpected error — still serve the static fallback list
    // so the endpoint never returns a 502 to the frontend.
    console.error('TokenRouter models fetch failed:', err.message);
    res.json({
      models: FALLBACK_TOKENROUTER_MODELS.map((id) => ({ id, label: id })),
    });
  }
});

export default router;
