import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateProjectFramework, hasFilesWithExtensions } from '../src/services/validator.js';

// Re-export for backward compatibility with any manual scripting
export { validateProjectFramework };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TEST: Angular project with fromTech = 'React'
const angularExtractPath = path.join(__dirname, '..', 'extracted', '1783788916720-angular_project');
console.log('='.repeat(70));
console.log('TEST 1: Angular project with fromTech = "React"');
console.log('='.repeat(70));
const result1 = validateProjectFramework(angularExtractPath, 'React');
console.log('Result:', JSON.stringify(result1, null, 2));
console.log('');

// TEST: Angular project with fromTech = 'Angular'
console.log('='.repeat(70));
console.log('TEST 2: Angular project with fromTech = "Angular" (should pass)');
console.log('='.repeat(70));
const result2 = validateProjectFramework(angularExtractPath, 'Angular');
console.log('Result:', JSON.stringify(result2, null, 2));
console.log('');

// TEST: Does the angular project accidentally have .tsx files?
console.log('='.repeat(70));
console.log('TEST 3: Check if Angular project has .jsx or .tsx files');
console.log('='.repeat(70));
const hasJsx = hasFilesWithExtensions(angularExtractPath, ['.jsx', '.tsx']);
console.log('Has .jsx/.tsx files:', hasJsx);
console.log('');

// TEST: What about the 2nd Angular project zip?
const angularExtractPath2 = path.join(__dirname, '..', 'extracted', '1783789352619-angular_project');
console.log('='.repeat(70));
console.log('TEST 4: 2nd Angular project with fromTech = "React"');
console.log('='.repeat(70));
const result4 = validateProjectFramework(angularExtractPath2, 'React');
console.log('Result:', JSON.stringify(result4, null, 2));
