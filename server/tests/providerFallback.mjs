import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  getProviderFallbackChain,
  getProviderFallbackModels,
  hasConfiguredFallbackProvider,
  isProviderConfigured,
  sortModelsLargeToSmall,
} from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const chain = getProviderFallbackChain('genai');
assert.ok(chain[0] === 'genai', 'primary provider is first');
assert.ok(chain.length >= 1, 'chain is non-empty');
assert.equal(
  hasConfiguredFallbackProvider(chain, 0),
  chain.slice(1).some((id) => isProviderConfigured(id)),
  'hasConfiguredFallbackProvider matches configured tail'
);
assert.equal(hasConfiguredFallbackProvider(chain, chain.length - 1), false, 'last provider has no fallback');

const groqChain = getProviderFallbackChain('groq');
assert.equal(groqChain[0], 'groq', 'selected Groq is still tried first');
if (isProviderConfigured('genai')) {
  assert.equal(groqChain[1], 'genai', 'GenAI is the first recovery provider after Groq');
}
if (chain[0] === 'genai' && chain.includes('groq')) {
  assert.equal(chain[chain.length - 1], 'groq', 'Groq is last recovery when GenAI is primary');
}

assert.deepEqual(
  sortModelsLargeToSmall(
    ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash'],
    'genai'
  ),
  ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']
);
assert.deepEqual(
  sortModelsLargeToSmall(
    ['allam-2-7b', 'groq/compound-mini', 'groq/compound'],
    'groq'
  ),
  ['groq/compound', 'groq/compound-mini', 'allam-2-7b']
);
assert.deepEqual(
  sortModelsLargeToSmall(['gpt-oss:20b', 'gpt-oss:120b'], 'ollama'),
  ['gpt-oss:120b', 'gpt-oss:20b']
);

const genaiFromLargest = getProviderFallbackModels('genai', 'gemini-3.6-flash');
assert.equal(genaiFromLargest[0], 'gemini-3.6-flash');
assert.ok(
  genaiFromLargest.indexOf('gemini-3.5-flash') < genaiFromLargest.indexOf('gemini-3.5-flash-lite'),
  'GenAI rotation degrades Flash → Flash-Lite'
);

const genaiFromMid = getProviderFallbackModels('genai', 'gemini-3.5-flash');
assert.equal(genaiFromMid[0], 'gemini-3.5-flash', 'start at the selected model');
assert.equal(genaiFromMid.includes('gemini-3.6-flash'), false, 'do not rotate up to a larger model');

const groqModels = getProviderFallbackModels('groq');
assert.equal(groqModels[0], 'groq/compound');
assert.ok(
  groqModels.indexOf('groq/compound-mini') < groqModels.indexOf('allam-2-7b'),
  'Groq compound-mini is larger than allam-2-7b'
);

console.log('PASS: provider fallback chain');
console.log('  chain (genai primary):', chain.join(' → '));
console.log('  chain (groq primary):', groqChain.join(' → '));
console.log('  genai models:', genaiFromLargest.join(' → '));
console.log('  groq models:', groqModels.join(' → '));
