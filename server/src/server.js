import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from the server root directory (one level up from this file's directory)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import app from './app.js';
import { PORT, getOpenAIConfig } from './config/index.js';

// Check that the OpenAI-compatible API key is configured
const openAICfg = getOpenAIConfig();
if (!openAICfg.apiKey) {
  console.warn('WARNING: OPENAI_API_KEY environment variable is not set.');
  console.warn('The AI migration pipeline will fail without a valid API key.');
  console.warn('Set it in the server/.env file or as a system environment variable.');
}

// ---------------------------------------------------------------------------
// Start the migration engine
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Migration Engine listening on http://localhost:${PORT}`);
});
