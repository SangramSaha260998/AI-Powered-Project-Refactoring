import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from the server root directory (one level up from this file's directory)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { execSync } from 'child_process';
import app from './app.js';
import { PORT, getProviderConfigs, getProviderIds, PROVIDERS } from './config/index.js';

// ---------------------------------------------------------------------------
// Validate all configured AI providers on startup
// ---------------------------------------------------------------------------
const providerIds = getProviderIds();
let anyKeyConfigured = false;

for (const providerId of providerIds) {
  const configs = getProviderConfigs(providerId);
  const validKeys = configs.filter(cfg => cfg.apiKey);

  if (validKeys.length === 0) {
    const provConfig = PROVIDERS[providerId];
    // Providers marked as not requiring a key (e.g. local Ollama) are fine without one
    if (provConfig && provConfig.requiresApiKey === false) {
      anyKeyConfigured = true;
      console.log(`${provConfig.name} (${providerId}): No API key required (local).  [model: ${configs[0]?.model}]`);
    } else {
      console.warn(`WARNING: ${provConfig?.envPrefix}_API_KEY is not set.`);
      console.warn(`  Provider "${providerId}" (${provConfig?.name}) will be unavailable.`);
    }
  } else {
    anyKeyConfigured = true;
    const label = `${PROVIDERS[providerId].name} (${providerId})`;
    if (validKeys.length > 1) {
      console.log(`${label}: ${validKeys.length} key(s) configured — fallback enabled.`);
      validKeys.forEach((cfg, i) => {
        const masked = cfg.apiKey.length > 8
          ? cfg.apiKey.slice(0, 4) + '...' + cfg.apiKey.slice(-4)
          : '****';
        console.log(`  Key ${i + 1}: ${masked}  [model: ${cfg.model}]`);
      });
    } else {
      const masked = validKeys[0].apiKey.length > 8
        ? validKeys[0].apiKey.slice(0, 4) + '...' + validKeys[0].apiKey.slice(-4)
        : '****';
      console.log(`${label}: 1 key configured — ${masked}  [model: ${validKeys[0].model}]`);
    }
  }
}

if (!anyKeyConfigured) {
  console.warn('WARNING: No API keys configured for any AI provider.');
  console.warn('The AI migration pipeline will fail without at least one valid API key.');
  console.warn('Set them in the server/.env file or as system environment variables.');
}

// ---------------------------------------------------------------------------
// Start the migration engine — auto-resolve port conflicts
// ---------------------------------------------------------------------------
function startServer(port, retries = 1) {
  const server = app.listen(port, () => {
    console.log(`Migration Engine listening on http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`Port ${port} is in use. Attempting to free it...`);
      try {
        const platform = process.platform;
        if (platform === 'win32') {
          execSync(
            `for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${port} "') do taskkill /F /PID %a`,
            { stdio: 'ignore', shell: 'cmd.exe', windowsHide: true, timeout: 5000 }
          );
        } else {
          execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { stdio: 'ignore', timeout: 5000 });
        }
      } catch (_) {
        // Kill failed (process may have already exited) — retry anyway
      }
      console.log(`Freed or confirmed port ${port} free. Retrying...`);
      setTimeout(() => startServer(port, 0), 1500);
    } else {
      console.error('Server failed to start:', err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);
