import cors from 'cors';
import { getFrontendOrigins } from './config/index.js';

function originAllowed(origin, allowed) {
  if (!origin) return true;
  for (const entry of allowed) {
    if (entry === origin) return true;
    if (entry.startsWith('*.') && origin.endsWith(entry.slice(1))) return true;
  }
  return false;
}

/**
 * CORS for split Vercel (frontend) + Render (API) deployments.
 * Set FRONTEND_URL on Render to your Vercel URL(s), comma-separated.
 * Supports *.vercel.app when an entry is literally "*.vercel.app".
 */
export function createCorsMiddleware() {
  const allowed = getFrontendOrigins();
  if (allowed.length === 0) {
    return cors();
  }
  return cors({
    origin(origin, callback) {
      if (originAllowed(origin, allowed)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  });
}
