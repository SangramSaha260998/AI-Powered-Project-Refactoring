import assert from 'node:assert/strict';
import { isFallbackWorthyError, nextLlmRotateAction } from '../src/services/migration.js';

const groq413 = isFallbackWorthyError({
  status: 413,
  message: '413 Request Entity Too Large',
});
assert.equal(groq413.worthy, true);
assert.equal(groq413.reason, 'payload-too-large');

const msgOnly = isFallbackWorthyError({
  message: '413 Request Entity Too Large',
});
assert.equal(msgOnly.worthy, true);
assert.equal(msgOnly.reason, 'payload-too-large');

const context = isFallbackWorthyError({
  status: 400,
  message: 'This model maximum context length is exceeded',
});
assert.equal(context.worthy, true);
assert.equal(context.reason, 'payload-too-large');

const fatal = isFallbackWorthyError({ status: 400, message: 'bad request' });
assert.equal(fatal.worthy, false);

const rate = isFallbackWorthyError({ status: 429, message: 'Too Many Requests' });
assert.equal(rate.worthy, true);
assert.equal(rate.reason, 'rate-limit');

const twoKeysThreeModels = {
  modelIndex: 0,
  totalModels: 3,
  keyIndex: 0,
  totalKeys: 2,
  hasNextProvider: true,
};

assert.equal(
  nextLlmRotateAction({ ...twoKeysThreeModels, reason: 'rate-limit', statusCode: 429 }),
  'next-model',
  '429 on first model must rotate to the next model, not the next LLM'
);
assert.equal(
  nextLlmRotateAction({ ...twoKeysThreeModels, modelIndex: 2, reason: 'rate-limit', statusCode: 429 }),
  'next-key',
  '429 after last model on a key rotates to the next key'
);
assert.equal(
  nextLlmRotateAction({
    ...twoKeysThreeModels,
    modelIndex: 2,
    keyIndex: 1,
    reason: 'rate-limit',
    statusCode: 429,
  }),
  'next-provider',
  '429 after last key × last model rotates to the next LLM'
);
assert.equal(
  nextLlmRotateAction({ ...twoKeysThreeModels, reason: 'payload-too-large', statusCode: 413 }),
  'next-provider',
  '413 skips remaining models and jumps to the next LLM'
);
assert.equal(
  nextLlmRotateAction({ ...twoKeysThreeModels, reason: 'quota/auth', statusCode: 401 }),
  'next-key',
  '401 skips remaining models and jumps to the next key'
);

console.log('PASS: llm fallback worthiness (413 rotates instead of failing)');
console.log('PASS: model rotation runs before key/provider rotation on 429');
