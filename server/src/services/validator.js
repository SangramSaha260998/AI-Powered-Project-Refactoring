import fs from 'fs';
import path from 'path';
import { FRAMEWORK_SIGNATURES } from '../config/index.js';

/**
 * Searches for a config file (e.g. angular.json) inside the extract directory.
 * Checks root first, then one level deep.
 * @param {string} extractPath - Root of the extracted project
 * @param {string} fileName - Config file name to find
 * @returns {string|null} Full path to the file if found, null otherwise
 */
function findConfigFile(extractPath, fileName) {
  const rootPath = path.join(extractPath, fileName);
  if (fs.existsSync(rootPath)) return rootPath;
  try {
    const entries = fs.readdirSync(extractPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = path.join(extractPath, entry.name, fileName);
        if (fs.existsSync(nested)) return nested;
      }
    }
  } catch {
    // ignore permission errors
  }
  return null;
}

/**
 * Recursively scans a directory tree to see if any files with the given
 * extensions exist (up to a max depth).
 * @param {string} dirPath - Root directory to scan
 * @param {string[]} extensions - File extensions to look for (e.g. ['.jsx', '.tsx'])
 * @param {number} maxDepth - Maximum recursion depth
 * @returns {boolean} True if at least one matching file is found
 */
export function hasFilesWithExtensions(dirPath, extensions, maxDepth = 5) {
  function scan(currentPath, depth) {
    if (depth > maxDepth) return false;
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          if (scan(fullPath, depth + 1)) return true;
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) return true;
        }
      }
    } catch {
      // ignore permission errors
    }
    return false;
  }
  return scan(dirPath, 0);
}

/**
 * Validates that an extracted project matches the expected frontend framework.
 *
 * Checks:
 *  1. package.json includes the framework's signature dependency.
 *  2. Structural signals (angular.json for Angular, .jsx/.tsx files for React).
 *
 * @param {string} extractPath - Root of the extracted project
 * @param {string} expectedFramework - 'Angular' or 'React' (case-insensitive)
 * @returns {{ valid: boolean, reason?: string }} Validation result
 */
export function validateProjectFramework(extractPath, expectedFramework) {
  const expected = (expectedFramework || '').toLowerCase().trim();
  if (!expected || (expected !== 'angular' && expected !== 'react')) {
    return { valid: false, reason: `Unknown target framework: "${expectedFramework}".` };
  }
  const failures = [];
  const expectedDisplay = expected === 'angular' ? 'Angular' : 'React';

  // CHECK 1: package.json dependencies
  const candidates = [path.join(extractPath, 'package.json')];
  try {
    const entries = fs.readdirSync(extractPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push(path.join(extractPath, entry.name, 'package.json'));
      }
    }
  } catch {
    // ignore
  }

  let packageJsonPath = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      packageJsonPath = candidate;
      break;
    }
  }

  if (!packageJsonPath) {
    failures.push('No package.json found in the uploaded project.');
  } else {
    let packageData;
    try {
      const raw = fs.readFileSync(packageJsonPath, 'utf-8');
      packageData = JSON.parse(raw);
    } catch {
      failures.push('Found package.json but it could not be parsed.');
    }
    if (packageData) {
      const allDeps = {
        ...(packageData.dependencies || {}),
        ...(packageData.devDependencies || {}),
        ...(packageData.peerDependencies || {})
      };
      const depNames = Object.keys(allDeps);
      const expectedSignatures = FRAMEWORK_SIGNATURES[expected] || [];
      const foundFramework = expectedSignatures.some(sig => depNames.includes(sig));
      if (!foundFramework) {
        failures.push(
          `Missing ${expectedDisplay} dependency: expected ${expectedSignatures.join(' or ')} in package.json.`
        );
      }
    }
  }

  // CHECK 2: Structural signal
  if (expected === 'angular') {
    if (!findConfigFile(extractPath, 'angular.json')) {
      failures.push('No angular.json found — this is not a standard Angular CLI project.');
    }
  } else if (expected === 'react') {
    if (!hasFilesWithExtensions(extractPath, ['.jsx', '.tsx'])) {
      failures.push('No .jsx or .tsx files found — this does not look like a React project.');
    }
  }

  if (failures.length > 0) {
    return {
      valid: false,
      reason: `The uploaded project does not appear to be a valid ${expectedDisplay} project:\n- ${failures.join('\n- ')}`
    };
  }
  return { valid: true };
}
