import { Router } from 'express';

const router = Router();

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/frontend/v1/catalog/models';

/**
 * A catalog entry is free when its primary endpoint is marked is_free.
 */
function isFreeOpenRouterModel(model) {
  return model?.endpoint?.is_free === true;
}

/**
 * Only chat/text-generation models — skip embeddings / rerank / etc.
 */
function isChatCapableModel(model) {
  if (model?.has_text_output === false) return false;

  const modalities = model?.output_modalities;
  if (Array.isArray(modalities) && modalities.length > 0) {
    return modalities.includes('text');
  }

  // If modalities are missing, keep the model (catalog may omit the field).
  return true;
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
          isChatCapableModel(model)
      )
      .map((model) => ({
        // OpenRouter free variant id, e.g. "poolside/laguna-s-2.1:free"
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

export default router;
