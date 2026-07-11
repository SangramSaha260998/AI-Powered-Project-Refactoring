import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Copy of the validation logic from index.js
const FRAMEWORK_SIGNATURES = {
  angular: ['@angular/core'],
  react: ['react', 'react-dom']
};

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
  } catch {}
  return null;
}

function hasFilesWithExtensions(dirPath, extensions, maxDepth = 5) {
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
    } catch {}
    return false;
  }
  return scan(dirPath, 0);
}

function validateProjectFramework(extractPath, expectedFramework) {
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
  } catch {}

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
        failures.push(`Missing ${expectedDisplay} dependency: expected ${expectedSignatures.join(' or ')} in package.json.`);
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

// TEST: Angular project with fromTech = 'React'
const angularExtractPath = path.join(__dirname, 'extracted', '1783788916720-angular_project');
console.log('=' .repeat(70));
console.log('TEST 1: Angular project with fromTech = "React"');
console.log('=' .repeat(70));
const result1 = validateProjectFramework(angularExtractPath, 'React');
console.log('Result:', JSON.stringify(result1, null, 2));
console.log('');

// TEST: Angular project with fromTech = 'Angular'
console.log('=' .repeat(70));
console.log('TEST 2: Angular project with fromTech = "Angular" (should pass)');
console.log('=' .repeat(70));
const result2 = validateProjectFramework(angularExtractPath, 'Angular');
console.log('Result:', JSON.stringify(result2, null, 2));
console.log('');

// TEST: Does the angular project accidentally have .tsx files?
console.log('=' .repeat(70));
console.log('TEST 3: Check if Angular project has .jsx or .tsx files');
console.log('=' .repeat(70));
const hasJsx = hasFilesWithExtensions(angularExtractPath, ['.jsx', '.tsx']);
console.log('Has .jsx/.tsx files:', hasJsx);
console.log('');

// TEST: What about the 2nd Angular project zip?
const angularExtractPath2 = path.join(__dirname, 'extracted', '1783789352619-angular_project');
console.log('=' .repeat(70));
console.log('TEST 4: 2nd Angular project with fromTech = "React"');
console.log('=' .repeat(70));
const result4 = validateProjectFramework(angularExtractPath2, 'React');
console.log('Result:', JSON.stringify(result4, null, 2));
