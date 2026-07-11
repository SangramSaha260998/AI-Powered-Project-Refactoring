import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateProjectFramework } from '../src/services/validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TEST: Test against BOTH old and new extraction directories
const paths = [
  path.join(__dirname, '..', 'extracted', '1783788916720-angular_project'),
  path.join(__dirname, '..', 'extracted', '1783789972001-1783788916720-angular_project')
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
