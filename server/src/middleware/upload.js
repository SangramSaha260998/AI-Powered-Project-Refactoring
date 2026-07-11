import multer from 'multer';
import path from 'path';
import { UPLOAD_DIR } from '../config/index.js';
import { ensureDirectoryExists } from '../utils/file.js';

// Ensure the upload directory exists at startup
ensureDirectoryExists(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

/**
 * Multer middleware configured to accept a single ZIP file
 * under the field name 'projectZip'.
 */
export const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Only ZIP files are allowed!'), false);
    }
    cb(null, true);
  }
});
