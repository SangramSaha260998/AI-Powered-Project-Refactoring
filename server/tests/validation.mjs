import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateProjectFramework, hasFilesWithExtensions } from '../src/services/validator.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('PASS:', message);
  }
}

function makeProject(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const angularPkg = JSON.stringify({
  name: 'demo-ng',
  dependencies: { '@angular/core': '^20.0.0' },
});
const reactPkg = JSON.stringify({
  name: 'demo-react',
  dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
});

const angularDir = makeProject('val-ng-', {
  'package.json': angularPkg,
  'angular.json': '{"version":1}',
  'src/app/app.component.ts': 'export class AppComponent {}',
});

const reactTsxDir = makeProject('val-react-tsx-', {
  'package.json': reactPkg,
  'src/App.tsx': 'export default function App() { return null; }',
});

const reactJsDir = makeProject('val-react-js-', {
  'package.json': reactPkg,
  'src/App.js': 'export default function App() { return null; }',
});

const nestedAngular = makeProject('val-ng-nested-', {
  'my-app/package.json': angularPkg,
  'my-app/angular.json': '{"version":1}',
  'my-app/src/app/app.component.ts': 'export class AppComponent {}',
});

try {
  const ngAsReact = validateProjectFramework(angularDir, 'React');
  assert(ngAsReact.valid === false, 'Angular project rejected when fromTech is React');

  const ngAsNg = validateProjectFramework(angularDir, 'Angular');
  assert(ngAsNg.valid === true, 'Angular project accepted when fromTech is Angular');

  const reactAsNg = validateProjectFramework(reactTsxDir, 'Angular');
  assert(reactAsNg.valid === false, 'React project rejected when fromTech is Angular');

  const reactAsReact = validateProjectFramework(reactTsxDir, 'React');
  assert(reactAsReact.valid === true, 'React TSX project accepted when fromTech is React');

  const jsOnly = validateProjectFramework(reactJsDir, 'React');
  assert(jsOnly.valid === true, 'JavaScript-only React project (App.js) is accepted');

  const nested = validateProjectFramework(nestedAngular, 'Angular');
  assert(nested.valid === true, 'Nested Angular ZIP (one folder down) is accepted');

  const unknown = validateProjectFramework(angularDir, 'Vue');
  assert(unknown.valid === false, 'Unknown framework is rejected');

  assert(
    hasFilesWithExtensions(reactTsxDir, ['.tsx']) === true,
    'hasFilesWithExtensions finds .tsx'
  );
  assert(
    hasFilesWithExtensions(angularDir, ['.jsx', '.tsx']) === false,
    'Angular tree has no .jsx/.tsx'
  );
} finally {
  for (const dir of [angularDir, reactTsxDir, reactJsDir, nestedAngular]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.exitCode) {
  console.error('\nSome validation tests failed.');
} else {
  console.log('\nAll validation tests passed.');
}
