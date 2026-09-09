import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  getProviderFallbackChain,
  hasConfiguredFallbackProvider,
  isProviderConfigured,
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

console.log('PASS: provider fallback chain');
console.log('  chain:', chain.join(' → '));
