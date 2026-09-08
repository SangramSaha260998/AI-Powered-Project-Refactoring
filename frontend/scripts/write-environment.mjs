/**
 * Injects deployment API URL into environment.ts before ng build.
 * Vercel: set API_BASE_URL in project Environment Variables.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'src', 'environments', 'environment.ts');

const apiBaseUrl =
  process.env.API_BASE_URL ||
  process.env.NG_APP_API_BASE_URL ||
  'https://ai-powered-project-refactoring-1.onrender.com/api';

const normalized = apiBaseUrl.replace(/\/+$/, '').endsWith('/api')
  ? apiBaseUrl.replace(/\/+$/, '')
  : `${apiBaseUrl.replace(/\/+$/, '')}/api`;

const content = `export const environment = {
  production: true,
  apiBaseUrl: '${normalized.replace(/'/g, "\\'")}',
};
`;

fs.writeFileSync(outPath, content, 'utf-8');
console.log(`[write-environment] apiBaseUrl → ${normalized}`);
