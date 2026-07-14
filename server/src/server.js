import 'dotenv/config';
import app from './app.js';
import { PORT } from './config/index.js';

// Ensure the Google GenAI API key is set
if (!process.env.GOOGLE_API_KEY) {
  console.warn('WARNING: GOOGLE_API_KEY environment variable is not set.');
  console.warn('The AI migration pipeline will fail without a valid API key.');
  console.warn('Set it in a .env file or as a system environment variable.');
}

// ---------------------------------------------------------------------------
// Start the migration engine
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Migration Engine listening on http://localhost:${PORT}`);
});
