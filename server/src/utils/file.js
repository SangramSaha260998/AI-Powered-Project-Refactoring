import fs from 'fs';

/**
 * Recursively removes a directory and all its contents.
 * @param {string} dirPath - Path to the directory to remove
 */
export function removeDirectoryRecursive(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Removes a single file if it exists.
 * @param {string} filePath - Path to the file to remove
 */
export function removeFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Ensures a directory exists, creating it (and parents) if needed.
 * @param {string} dirPath - Path to the directory to ensure
 */
export function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
