import { Router } from 'express';

const router = Router();

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/frontend/v1/catalog/models';
const OLLAMA_CLOUD_TAGS_URL = 'https://ollama.com/api/tags';
const GENAI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function firstEnvKey(envName) {
  return (process.env[envName] || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)[0] || '';
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

export default router;
