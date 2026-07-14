import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Framework dependency signatures used for project validation.
 */
export const FRAMEWORK_SIGNATURES = {
  angular: ['@angular/core'],
  react: ['react', 'react-dom']
};

/**
 * Port the migration engine listens on.
 * Override via the PORT environment variable.
 */
export const PORT = process.env.PORT || 5000;

/**
 * Directories for uploads and extracted projects.
 */
export const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
export const EXTRACT_DIR = path.resolve(__dirname, '..', '..', 'extracted');

/**
 * Maximum allowed upload file size (50 MB).
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Folders we MUST skip to avoid crashes or blowing past token limits
 */
export const IGNORED_FOLDERS = new Set([
  'node_modules',
  '.git',
  '.angular',
  'dist',
  'build',
  '.vscode',
  '.idea'
]);

/**
 * Text file extensions that are safe to read and send to the AI.
 */
export const TEXT_EXTENSIONS = [
  '.html', '.css', '.scss', '.sass', '.js', '.jsx',
  '.ts', '.tsx', '.json', '.md', '.txt', '.xml', '.yaml', '.yml',
  '.config.js', '.config.ts', '.mjs', '.cjs'
];

/**
 * Gemini model to use for AI-powered migration.
 */
export const GEMINI_MODEL = 'gemini-2.0-flash-001';

/**
 * Rate-limit pause between AI file generations (in ms).
 * Helps stay under free-tier TPM quotas.
 */
export const RATE_LIMIT_PAUSE_MS = 5500;