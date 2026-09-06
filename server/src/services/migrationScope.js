/**
 * Phased migration scopes — convert a subset of a large app first (e.g. landing page only).
 */

import path from 'path';

export const MIGRATION_SCOPES = {
  FULL: 'full',
  LANDING_FIRST: 'landing-first',
};

const LANDING_ROUTE_PATHS = new Set(['', '/', 'home', 'landing', 'index', 'welcome']);
const LANDING_COMPONENT_NAMES =
  /^(Home|Landing|LandingPage|Index|MainPage|Welcome|Hero)(Page|Screen|View)?$/i;

const BOOTSTRAP_FILE_RE =
  /(^|\/)src\/(main|index|vite-env\.d)\.(tsx?|jsx?|ts)$|(^|\/)src\/App\.(tsx|jsx)$|(^|\/)src\/(index|global|styles?)\.(css|scss)$|tailwind\.config\.(js|ts|mjs|cjs)$/i;

/**
 * @param {string} [value]
 * @returns {'full' | 'landing-first'}
 */
export function normalizeMigrationScope(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (v === 'landing-first' || v === 'landing' || v === 'landing-only' || v === 'phase-1' || v === 'phase1') {
    return MIGRATION_SCOPES.LANDING_FIRST;
  }
  return MIGRATION_SCOPES.FULL;
}

export function isLandingFirstScope(scope) {
  return normalizeMigrationScope(scope) === MIGRATION_SCOPES.LANDING_FIRST;
}

function isBootstrapSourceFile(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (BOOTSTRAP_FILE_RE.test(p)) return true;
  if (/package\.json$/i.test(p)) return true;
  return false;
}

function isSharedUtilityFile(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  return /(^|\/)src\/(lib|utils|hooks|types|models|constants|config|assets)\//i.test(p);
}

function resolveComponentFileByName(name, map) {
  if (!name) return null;
  for (const candidate of Object.keys(map)) {
    const cp = candidate.replace(/\\/g, '/');
    if (!/\.(tsx|jsx)$/i.test(cp)) continue;
    const cbase = path.posix.basename(cp).replace(/\.(tsx|jsx)$/i, '');
    if (cbase === name || cbase === `${name}Page` || cbase === `${name}Screen`) return cp;
  }
  return null;
}

function extractLandingComponentsFromRouterFile(content, map) {
  const found = [];
  const text = String(content || '');
  const patterns = [
    /path\s*=\s*['"]\/['"][\s\S]*?element\s*=\s*\{?\s*<([A-Z][A-Za-z0-9]*)/gi,
    /path\s*:\s*['"]\/['"][\s\S]*?element\s*:\s*<([A-Z][A-Za-z0-9]*)/gi,
    /index\s+element\s*=\s*\{?\s*<([A-Z][A-Za-z0-9]*)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const resolved = resolveComponentFileByName(m[1], map);
      if (resolved) found.push(resolved);
    }
  }
  return [...new Set(found)];
}

/**
 * Detect landing / home entry component files in a React (or similar) project.
 * @returns {string[]} workspace-relative paths under src/
 */
export function findLandingSeedFiles(filesMap, sourceAnalysis = null) {
  const seeds = new Set();
  const map = filesMap || {};

  for (const route of sourceAnalysis?.routes || []) {
    const routePath = String(route.path || '').replace(/\/$/, '') || '';
    const normalized = routePath === '' ? '/' : routePath.startsWith('/') ? routePath.slice(1) : routePath;
    if (LANDING_ROUTE_PATHS.has(route.path) || LANDING_ROUTE_PATHS.has(normalized) || normalized === '') {
      const file = String(route.file || '').replace(/\\/g, '/');
      if (!file || !map[file]) continue;
      if (/App\.(tsx|jsx)$/i.test(path.posix.basename(file))) {
        for (const comp of extractLandingComponentsFromRouterFile(map[file], map)) {
          seeds.add(comp);
        }
      } else {
        seeds.add(file);
      }
    }
  }

  for (const [file, content] of Object.entries(map)) {
    const p = file.replace(/\\/g, '/');
    if (!/^src\//.test(p) || !/\.(tsx|jsx)$/i.test(p)) continue;

    const base = path.posix.basename(p).replace(/\.(tsx|jsx)$/i, '');
    if (LANDING_COMPONENT_NAMES.test(base) && /\/(pages|views|screens|routes)\//i.test(p)) {
      seeds.add(p);
    }

    const text = String(content || '');
    if (
      /(?:path\s*=\s*['"]\/['"]|path\s*:\s*['"]\/['"]|\bindex\s+element\s*=)/i.test(text) &&
      /\/(pages|views|screens|App|routes)\//i.test(p)
    ) {
      const compRe =
        /(?:path\s*=\s*['"]\/['"]|path\s*:\s*['"]\/['"]|index\s+element\s*=\s*\{?\s*<)\s*([A-Z][A-Za-z0-9]*)/g;
      let m;
      while ((m = compRe.exec(text)) !== null) {
        const resolved = resolveComponentFileByName(m[1], map);
        if (resolved) seeds.add(resolved);
      }
    }
  }

  if (seeds.size === 0) {
    const pageCandidates = Object.keys(map)
      .map((f) => f.replace(/\\/g, '/'))
      .filter((p) => /^src\//.test(p) && /\/(pages|views|screens)\/[^/]+\.(tsx|jsx)$/i.test(p))
      .sort();
    if (pageCandidates.length) seeds.add(pageCandidates[0]);
  }

  return [...seeds];
}

/**
 * Collect landing seeds + transitive local imports + bootstrap / shared utils used by them.
 */
export function filterFilesMapToLandingScope(filesMap, sourceAnalysis = null) {
  const map = filesMap || {};
  const graph = sourceAnalysis?.dependencyGraph;
  const edges = graph?.edges || [];
  const seeds = findLandingSeedFiles(map, sourceAnalysis);

  const allowed = new Set();
  for (const p of Object.keys(map)) {
    if (isBootstrapSourceFile(p)) allowed.add(p.replace(/\\/g, '/'));
  }

  const queue = [...seeds];
  for (const seed of seeds) allowed.add(seed.replace(/\\/g, '/'));

  while (queue.length) {
    const current = queue.shift();
    for (const edge of edges) {
      if (edge.from !== current) continue;
      const dep = String(edge.to || '').replace(/\\/g, '/');
      if (!dep || !map[dep] || allowed.has(dep)) continue;
      if (isBootstrapSourceFile(dep)) {
        allowed.add(dep);
        continue;
      }
      allowed.add(dep);
      queue.push(dep);
    }
  }

  // Include shared utils/models only when referenced from the landing tree
  for (const p of [...allowed]) {
    if (!isSharedUtilityFile(p)) continue;
    allowed.add(p);
  }

  const filtered = {};
  for (const p of allowed) {
    if (map[p]) filtered[p] = map[p];
  }

  if (Object.keys(filtered).length === 0) {
    return map;
  }

  return filtered;
}

export function getLandingFirstScopePrompt() {
  return `
## MIGRATION SCOPE: LANDING PAGE FIRST (PHASE 1 — MANDATORY)

You are NOT converting the entire application in this run.

### IN SCOPE (convert fully — real UI + real behavior)
- The **landing / home page** (route \`/\` or the project's main marketing/home screen)
- Every **child component** used by that landing page (hero, header, footer, nav, CTA sections, etc.)
- **Services, hooks, utils, models, and store slices** that the landing page actually imports
- **App shell + routing** wired so the landing page loads at \`/\` and **compiles**

### OUT OF SCOPE (do NOT implement yet)
- Dashboard, admin, auth flows, settings, CRUD lists, profile, or any other route/screen
- Do NOT plan or generate full implementations for pages the landing page does not use
- Other routes may be **omitted** from \`app.routes.ts\` OR listed as simple redirects/placeholders that compile
  (e.g. \`{ path: 'dashboard', redirectTo: '/', pathMatch: 'full' }\`) — **no full feature conversion**

### Quality bar for in-scope work
- Landing page components must have **complete functionality** (handlers, state, forms, links) — not stubs.
- Do NOT spread effort across the whole app; depth on the landing experience wins over breadth.

### Later phases
The user will run another migration pass later to add remaining routes. Design routing so expansion is easy.
`;
}

/**
 * Apply scope to the source file map used for blueprint + unit conversion.
 */
export function applyMigrationScope(filesMap, sourceAnalysis, scope) {
  const normalized = normalizeMigrationScope(scope);
  if (normalized !== MIGRATION_SCOPES.LANDING_FIRST) {
    return {
      scope: MIGRATION_SCOPES.FULL,
      filesMap: filesMap || {},
      landingSeeds: [],
    };
  }

  const landingSeeds = findLandingSeedFiles(filesMap, sourceAnalysis);
  const scopedMap = filterFilesMapToLandingScope(filesMap, sourceAnalysis);

  return {
    scope: MIGRATION_SCOPES.LANDING_FIRST,
    filesMap: scopedMap,
    landingSeeds,
  };
}
