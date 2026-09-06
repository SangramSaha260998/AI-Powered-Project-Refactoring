/**
 * Mechanical enforcement: relocate flat pages / misplaced feature components
 * onto the pages/<area>/<feature>/pages|components/ tree and fix imports.
 */

import fs from 'fs';
import path from 'path';
import {
  inferAngularFeatureContext,
  isAngularFeatureModulePath,
  isFlatAngularPagePath,
  isMisplacedAngularFeatureComponentPath,
  KIT_PAGE_AREAS,
  KIT_SHARED_COMPONENTS,
  normalizeAngularPlanPath,
} from '../config/angularStructureGuide.js';

function walkSrcFiles(destPath, filter) {
  const srcRoot = path.join(destPath, 'src');
  const results = [];
  if (!fs.existsSync(srcRoot)) return results;

  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue;
        walk(full);
        continue;
      }
      if (filter(name, full)) results.push(full);
    }
  };
  walk(srcRoot);
  return results;
}

function collectRelPaths(destPath) {
  return walkSrcFiles(destPath, () => true).map((full) =>
    path.relative(destPath, full).replace(/\\/g, '/'),
  );
}

function ensureDirForFile(destPath, relFile) {
  const dir = path.dirname(path.join(destPath, relFile));
  fs.mkdirSync(dir, { recursive: true });
}

function moveFile(destPath, fromRel, toRel) {
  if (fromRel === toRel) return false;
  const fromAbs = path.join(destPath, fromRel);
  const toAbs = path.join(destPath, toRel);
  if (!fs.existsSync(fromAbs)) return false;
  ensureDirForFile(destPath, toRel);
  fs.renameSync(fromAbs, toAbs);
  return true;
}

function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) pruneEmptyDirs(full);
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

/**
 * Build oldRel → newRel moves for the workspace.
 */
export function buildAngularStructureMoves(destPath) {
  const relPaths = collectRelPaths(destPath);
  const context = inferAngularFeatureContext(relPaths);
  const moves = new Map();

  for (const rel of relPaths) {
    const normalized = normalizeAngularPlanPath(rel, context);
    if (normalized !== rel) moves.set(rel, normalized);
  }

  return { moves, context };
}

/**
 * Apply import / templateUrl path rewrites after files move.
 */
function rewritePathReferences(content, moves) {
  let out = String(content || '');
  const sorted = [...moves.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of sorted) {
    const fromPosix = from.replace(/\\/g, '/');
    const toPosix = to.replace(/\\/g, '/');

    // Exact quoted paths
    out = out.split(fromPosix).join(toPosix);

    // Relative imports: compute common replacements
    const fromDir = path.posix.dirname(fromPosix);
    const toDir = path.posix.dirname(toPosix);
    if (fromDir !== toDir) {
      const fromNoExt = fromPosix.replace(/\.(ts|html|scss)$/i, '');
      const toNoExt = toPosix.replace(/\.(ts|html|scss)$/i, '');
      out = out.split(fromNoExt).join(toNoExt);
    }

    // Folder-only references (component directories)
    const fromFolder = fromPosix.replace(/\/[^/]+$/, '');
    const toFolder = toPosix.replace(/\/[^/]+$/, '');
    if (fromFolder !== toFolder && fromFolder.includes('/')) {
      const fromTail = fromFolder.split('/').slice(-2).join('/');
      const toTail = toFolder.split('/').slice(-4).join('/');
      if (fromTail && toTail && fromTail !== toTail) {
        out = out.split(fromTail).join(toTail);
      }
    }
  }

  return out;
}

/**
 * Relocate misplaced files and patch imports across src/.
 * Returns number of files moved.
 */
export function enforceAngularFolderStructure(destPath) {
  const { moves } = buildAngularStructureMoves(destPath);
  if (moves.size === 0) return 0;

  let moved = 0;
  const sortedMoves = [...moves.entries()].sort((a, b) => a[0].length - b[0].length);

  for (const [from, to] of sortedMoves) {
    if (moveFile(destPath, from, to)) moved += 1;
  }

  const textFiles = walkSrcFiles(
    destPath,
    (name) => /\.(ts|html|scss|json)$/i.test(name),
  );

  for (const full of textFiles) {
    try {
      const original = fs.readFileSync(full, 'utf-8');
      const updated = rewritePathReferences(original, moves);
      if (updated !== original) {
        fs.writeFileSync(full, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf-8');
      }
    } catch {
      /* ignore */
    }
  }

  pruneEmptyDirs(path.join(destPath, 'src', 'app', 'pages'));
  pruneEmptyDirs(path.join(destPath, 'src', 'app', 'components'));

  return moved;
}

export {
  isAngularFeatureModulePath,
  isFlatAngularPagePath,
  isMisplacedAngularFeatureComponentPath,
  KIT_PAGE_AREAS,
  KIT_SHARED_COMPONENTS,
};
