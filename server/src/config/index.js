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
