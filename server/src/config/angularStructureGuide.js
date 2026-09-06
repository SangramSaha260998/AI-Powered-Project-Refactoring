/**
 * Mandatory Angular feature-module folder rules — short mandate for prompts + validation.
 */

export const ANGULAR_STRUCTURE_MANDATE = `
## ANGULAR FOLDER STRUCTURE — HARD RULES (NON-NEGOTIABLE)

### REQUIRED tree (feature modules)
\`\`\`
src/app/pages/<area>/<feature>/
  pages/<screen>/          # route screens (task-list, dashboard, …)
    <screen>.component.ts|html|scss
  components/<widget>/     # feature-local UI (forms, sidebars, inline tables)
    <widget>.component.ts|html|scss
src/app/components/        # ONLY shared cross-feature widgets (confirmation-dialog, …)
src/app/services/
src/app/models/
src/app/store/<feature>/   # NGXS when needed
\`\`\`

### FORBIDDEN (will be rejected or auto-moved)
- Flat route screens: \`src/app/pages/task-list/\` (missing \`<area>/<feature>/pages/\`)
- Feature-local UI under shared components:
  \`src/app/components/task-form-sidebar/\`, \`src/app/components/task-table/\`
- Inventing duplicate \`core/\`, \`shared/\`, \`store/\` trees (the kit already ships them)

### Examples (single-feature task app)
| Role | Correct path |
|------|----------------|
| List page | \`src/app/pages/app/tasks/pages/task-list/task-list.component.*\` |
| Add/edit sidebar | \`src/app/pages/app/tasks/components/task-form-sidebar/task-form-sidebar.component.*\` |
| Delete dialog | \`src/app/pages/app/tasks/components/task-delete-dialog/task-delete-dialog.component.*\` |
| Model | \`src/app/models/task.model.ts\` |
| Routes | \`src/app/app.routes.ts\` imports from \`./pages/app/tasks/pages/task-list/...\` |

### Area / feature naming
- Use \`admin\` / \`auth\` when the source clearly has those areas.
- Single-feature CRUD apps: \`pages/app/<feature>/\` (e.g. \`pages/app/tasks/\`).
- Keep source feature names; pluralize the feature folder when sensible (\`task\` → \`tasks\`).

### Blueprint + unit output
Every planned \`newPath\` and every ===== FILE: path ===== MUST already use the full
\`pages/<area>/<feature>/pages|components/\` path — never a shortcut flat folder.
`;

/** Kit-provided top-level page areas — not flat feature screens. */
export const KIT_PAGE_AREAS = new Set(['auth', 'admin', 'common', 'deeplink']);

/** Shared components shipped with web_angular — never relocate. */
export const KIT_SHARED_COMPONENTS = new Set([
  'breadcrumbs',
  'confirmation-dialog',
  'global-search',
]);

/**
 * True when path follows pages/<area>/<feature>/pages|components/...
 */
export function isAngularFeatureModulePath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  return /^src\/app\/pages\/[^/]+\/[^/]+\/(pages|components)\//i.test(p);
}

/**
 * Flat screen directly under src/app/pages/<screen>/ (not kit area, not feature-module).
 */
export function isFlatAngularPagePath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const m = p.match(/^src\/app\/pages\/([^/]+)\//i);
  if (!m) return false;
  const first = m[1].toLowerCase();
  if (KIT_PAGE_AREAS.has(first)) return false;
  return !isAngularFeatureModulePath(p);
}

/**
 * Feature-local component wrongly placed under src/app/components/.
 */
export function isMisplacedAngularFeatureComponentPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const m = p.match(/^src\/app\/components\/([^/]+)\//i);
  if (!m) return false;
  return !KIT_SHARED_COMPONENTS.has(m[1].toLowerCase());
}

function pluralizeFeature(token) {
  const t = String(token || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!t) return 'feature';
  if (t.endsWith('s')) return t;
  if (t.endsWith('y') && !/[aeiou]y$/i.test(t)) return `${t.slice(0, -1)}ies`;
  return `${t}s`;
}

function featureTokenFromName(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/\.component\.(ts|html|scss)$/i, '')
    .replace(/-(list|table|form|form-sidebar|delete-dialog|add-edit|edit|detail|details)$/i, '');
  const parts = base.split('-').filter(Boolean);
  return parts[0] || base || 'feature';
}

/**
 * Infer { area, feature } from a list of planned or on-disk paths.
 */
export function inferAngularFeatureContext(paths = []) {
  let area = 'app';
  const names = [];

  for (const raw of paths) {
    const p = String(raw || '').replace(/\\/g, '/');
    if (/^src\/app\/pages\/admin\//i.test(p)) area = 'admin';
    if (/^src\/app\/pages\/auth\//i.test(p)) area = 'auth';

    const flat = p.match(/^src\/app\/pages\/([^/]+)\//i);
    if (flat && !KIT_PAGE_AREAS.has(flat[1].toLowerCase()) && !isAngularFeatureModulePath(p)) {
      names.push(flat[1]);
    }

    const modScreen = p.match(/^src\/app\/pages\/[^/]+\/[^/]+\/pages\/([^/]+)\//i);
    if (modScreen) names.push(modScreen[1]);

    const comp = p.match(/^src\/app\/components\/([^/]+)\//i);
    if (comp && !KIT_SHARED_COMPONENTS.has(comp[1].toLowerCase())) {
      names.push(comp[1]);
    }

    const modComp = p.match(/^src\/app\/pages\/[^/]+\/[^/]+\/components\/([^/]+)\//i);
    if (modComp) names.push(modComp[1]);
  }

  const tokens = names.map(featureTokenFromName).filter(Boolean);
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  let best = 'feature';
  let bestCount = 0;
  for (const [t, c] of counts) {
    if (c > bestCount) {
      best = t;
      bestCount = c;
    }
  }

  // Respect existing feature-module folder when present
  for (const raw of paths) {
    const p = String(raw || '').replace(/\\/g, '/');
    const m = p.match(/^src\/app\/pages\/([^/]+)\/([^/]+)\/(pages|components)\//i);
    if (m) {
      area = m[1];
      return { area, feature: m[2] };
    }
  }

  return { area, feature: pluralizeFeature(best) };
}

/**
 * Normalize one planned path onto the feature-module tree.
 */
export function normalizeAngularPlanPath(relPath, context) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!p.startsWith('src/app/')) return p;
  if (isAngularFeatureModulePath(p)) return p;

  const { area, feature } = context || { area: 'app', feature: 'feature' };

  const flatPage = p.match(/^src\/app\/pages\/([^/]+)\/(.+)$/i);
  if (flatPage) {
    const screen = flatPage[1];
    const rest = flatPage[2];
    if (!KIT_PAGE_AREAS.has(screen.toLowerCase())) {
      return `src/app/pages/${area}/${feature}/pages/${screen}/${rest}`;
    }
  }

  const sharedComp = p.match(/^src\/app\/components\/([^/]+)\/(.+)$/i);
  if (sharedComp) {
    const compName = sharedComp[1];
    const rest = sharedComp[2];
    if (!KIT_SHARED_COMPONENTS.has(compName.toLowerCase())) {
      return `src/app/pages/${area}/${feature}/components/${compName}/${rest}`;
    }
  }

  return p;
}

/**
 * Normalize blueprint plan items (newPath + unit ids).
 */
export function normalizeAngularMigrationPlan(planItems = []) {
  const paths = planItems.map((item) => String(item?.newPath || ''));
  const context = inferAngularFeatureContext(paths);
  const pathMap = new Map();

  for (const raw of paths) {
    const normalized = normalizeAngularPlanPath(raw, context);
    if (normalized !== raw) pathMap.set(raw, normalized);
  }

  if (pathMap.size === 0) return planItems;

  const remap = (value) => {
    if (!value || typeof value !== 'string') return value;
    const norm = value.replace(/\\/g, '/');
    if (pathMap.has(norm)) return pathMap.get(norm);
    for (const [from, to] of pathMap) {
      if (norm.startsWith(from)) return to + norm.slice(from.length);
    }
    return norm;
  };

  return planItems.map((item) => {
    const newPath = remap(item.newPath);
    const unit = item.unit ? remap(item.unit) : item.unit;
    const dependencies = Array.isArray(item.dependencies)
      ? item.dependencies.map((d) => remap(d))
      : item.dependencies;
    return { ...item, newPath, unit, dependencies };
  });
}

export function angularStructureOutputViolatesMandate(parsedFiles = []) {
  for (const file of parsedFiles) {
    const p = String(file.path || '').replace(/\\/g, '/');
    if (isFlatAngularPagePath(p)) return true;
    if (isMisplacedAngularFeatureComponentPath(p)) return true;
  }
  return false;
}

export const ANGULAR_STRUCTURE_RETRY_SUFFIX = `
CRITICAL FOLDER STRUCTURE VIOLATION — your last output was REJECTED.
- Route screens MUST be under src/app/pages/<area>/<feature>/pages/<screen>/ (NOT src/app/pages/<screen>/).
- Feature-local sidebars/tables/dialogs MUST be under src/app/pages/<area>/<feature>/components/<name>/ (NOT src/app/components/<name>/).
- Regenerate every FILE path using the ANGULAR FOLDER STRUCTURE mandate. Example task app:
  src/app/pages/app/tasks/pages/task-list/task-list.component.ts
  src/app/pages/app/tasks/components/task-form-sidebar/task-form-sidebar.component.ts
`;
