import app from './app.js';
import { PORT } from './config/index.js';

// ---------------------------------------------------------------------------
// Start the migration engine
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Migration Engine listening on http://localhost:${PORT}`);
});
