import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, '..', 'src', 'services', 'migration.js');
const raw = fs.readFileSync(migrationPath, 'utf-8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let source = raw.replace(/\r\n/g, '\n');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf-8').replace(/\r\n/g, '\n');

let changed = 0;

/** Replace text between two single-line markers (exclusive). */
function replaceBetween(startMarker, endMarker, replacement, label) {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`[patch] start marker not found: ${label} :: ${startMarker.slice(0, 60)}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`[patch] end marker not found: ${label} :: ${endMarker.slice(0, 60)}`);
  source = source.slice(0, startIdx) + replacement + source.slice(endIdx);
  changed += 1;
  console.log(`[patch] replaced ${label}`);
}

// ---- 1. imports -----------------------------------------------------------
replaceBetween(
  "import {\n  angularRequiredNpmDeps,\n  ANGULAR_REQUIRED_PATH_ALIASES,\n  isAngularRequiredProtectedPath\n} from '../config/angularRequired.js';",
  "import { ensureDirectoryExists } from '../utils/file.js';",
  "import {\n  webAngularNpmDeps,\n  isWebAngularProtectedPath\n} from '../config/webAngular.js';",
  'imports'
);

// ---- 2. resolveSafeWritePath guard ---------------------------------------
replaceBetween(
  "  // angular_required kit — AI must not overwrite injected shared/core assets\n  if (isAngularRequiredProtectedPath(normalized)) {",
  "  // Only allow application source (and public assets) under known roots",
  "  // web_angular template kit — AI must not overwrite injected shared/core assets\n  if (isWebAngularProtectedPath(normalized)) {",
  'resolveSafeWritePath guard'
);

// ---- 3. enforceAngularPackageVersions ------------------------------------
replaceBetween(
  'function enforceAngularPackageVersions(destPath, stack) {',
  'function enforceReactPackageVersions(destPath, stack) {',
  read('enforce.js') + '\n\n',
  'enforceAngularPackageVersions'
);

// ---- 4. injectAngularWorkspaceTemplates ----------------------------------
const reactHeaderIdx = source.indexOf('// React workspace template injection');
if (reactHeaderIdx === -1) throw new Error('[patch] React workspace header not found');
const sepIdx = source.lastIndexOf('\n// ----', reactHeaderIdx);
if (sepIdx === -1) throw new Error('[patch] React workspace separator not found');
const injectStart = source.indexOf('function injectAngularWorkspaceTemplates(destPath, versionStack = null) {');
if (injectStart === -1) throw new Error('[patch] injectAngularWorkspaceTemplates start not found');
source = source.slice(0, injectStart) + read('inject.js') + '\n\n' + source.slice(sepIdx + 1);
changed += 1;
console.log('[patch] replaced injectAngularWorkspaceTemplates + helpers');

// ---- 5. kit section (stubs / shared files / app.config) -------------------
replaceBetween(
  'function ensureAngularRequiredCompanionStubs(destPath) {',
  'function ensureAngularRuntimeFiles(destPath) {',
  read('kit.js') + '\n\n',
  'companion stubs → ensureAngularAppConfigUsesWebAngular'
);

fs.writeFileSync(migrationPath, eol === '\n' ? source : source.replace(/\n/g, '\r\n'), 'utf-8');
console.log(`[patch] done — ${changed} regions replaced. EOL=${eol === '\r\n' ? 'CRLF' : 'LF'}`);
