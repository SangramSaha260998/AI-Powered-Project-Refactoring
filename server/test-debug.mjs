import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  console.log(`\nvalidateProjectFramework called:`);
  console.log(`  extractPath: ${extractPath}`);
  console.log(`  expectedFramework: ${expectedFramework}`);
  console.log(`  expected (lower): ${expected}`);
  
  if (!expected || (expected !== 'angular' && expected !== 'react')) {
    return { valid: false, reason: `Unknown target framework: "${expectedFramework}".` };
  }
  const failures = [];
  const expectedDisplay = expected === 'angular' ? 'Angular' : 'React';

  // CHECK 1: package.json dependencies
  const candidates = [path.join(extractPath, 'package.json')];
  try {
    const entries = fs.readdirSync(extractPath, { withFileTypes: true });
    console.log(`  entries in extractPath:`);
    for (const entry of entries) {
      console.log(`    ${entry.name} (isDirectory: ${entry.isDirectory()})`);
      if (entry.isDirectory()) {
        candidates.push(path.join(extractPath, entry.name, 'package.json'));
      }
    }
  } catch (e) {
    console.log(`  Error reading dir: ${e.message}`);
  }

  console.log(`  candidate package.json paths:`);
  for (const c of candidates) {
    console.log(`    ${c} (exists: ${fs.existsSync(c)})`);
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
    console.log(`  No package.json found`);
  } else {
    console.log(`  Found package.json at: ${packageJsonPath}`);
    let packageData;
    try {
      const raw = fs.readFileSync(packageJsonPath, 'utf-8');
      packageData = JSON.parse(raw);
      console.log(`  Parsed package.json, name: ${packageData.name}`);
    } catch (e) {
      failures.push('Found package.json but it could not be parsed.');
      console.log(`  Error parsing package.json: ${e.message}`);
    }
    if (packageData) {
      const allDeps = {
        ...(packageData.dependencies || {}),
        ...(packageData.devDependencies || {}),
        ...(packageData.peerDependencies || {})
      };
      const depNames = Object.keys(allDeps);
      console.log(`  Dependencies found: ${depNames.slice(0, 10).join(', ')}...`);
      const expectedSignatures = FRAMEWORK_SIGNATURES[expected] || [];
      console.log(`  Looking for: ${expectedSignatures.join(', ')}`);
      const foundFramework = expectedSignatures.some(sig => depNames.includes(sig));
      console.log(`  foundFramework: ${foundFramework}`);
      if (!foundFramework) {
        failures.push(`Missing ${expectedDisplay} dependency: expected ${expectedSignatures.join(' or ')} in package.json.`);
      }
    }
  }

  // CHECK 2: Structural signal
  if (expected === 'angular') {
    const configFile = findConfigFile(extractPath, 'angular.json');
    console.log(`  angular.json found: ${configFile}`);
    if (!configFile) {
      failures.push('No angular.json found — this is not a standard Angular CLI project.');
    }
  } else if (expected === 'react') {
    const hasJsxTsx = hasFilesWithExtensions(extractPath, ['.jsx', '.tsx']);
    console.log(`  Has .jsx/.tsx files: ${hasJsxTsx}`);
    if (!hasJsxTsx) {
      failures.push('No .jsx or .tsx files found — this does not look like a React project.');
    }
  }

  console.log(`  failures: ${failures.length > 0 ? failures.join(' | ') : 'NONE'}`);
  
  if (failures.length > 0) {
    return {
      valid: false,
      reason: `The uploaded project does not appear to be a valid ${expectedDisplay} project:\n- ${failures.join('\n- ')}`
    };
  }
  return { valid: true };
}

// TEST: Test against BOTH old and new extraction directories
const paths = [
  path.join(__dirname, 'extracted', '1783788916720-angular_project'),
  path.join(__dirname, 'extracted', '1783789972001-1783788916720-angular_project')
];

for (const p of paths) {
  console.log('\n' + '='.repeat(70));
  console.log(`Testing: ${p}`);
  console.log('='.repeat(70));
  console.log('\n--- with fromTech = "React" ---');
  const result1 = validateProjectFramework(p, 'React');
  console.log('Result:', JSON.stringify(result1, null, 2));
  
  console.log('\n--- with fromTech = "Angular" ---');
  const result2 = validateProjectFramework(p, 'Angular');
  console.log('Result:', JSON.stringify(result2, null, 2));
}
