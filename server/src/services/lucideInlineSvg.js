/**
 * Convert Lucide icon names / React lucide usages into plain inline <svg> markup.
 * No @lucide/angular or lucide-react in the Angular output — real SVG only.
 */

import { icons } from 'lucide';

const LUCIDE_SLUG_ALIASES = {
  logout: 'log-out',
  login: 'log-in',
  signin: 'log-in',
  signout: 'log-out',
  edit3: 'edit-3',
  edit2: 'edit-2',
  trash2: 'trash-2',
  checkcircle: 'check-circle',
  checkcircle2: 'check-circle-2',
  alertcircle: 'alert-circle',
  helpcircle: 'help-circle',
  xcircle: 'x-circle',
  usercog: 'user-cog',
  usercheck: 'user-check',
  userplus: 'user-plus',
  userminus: 'user-minus',
  shieldcheck: 'shield-check',
  shieldalert: 'shield-alert',
  eyeoff: 'eye-off',
  chevrondown: 'chevron-down',
  chevronup: 'chevron-up',
  chevronleft: 'chevron-left',
  chevronright: 'chevron-right',
  arrowleft: 'arrow-left',
  arrowright: 'arrow-right',
  morehorizontal: 'more-horizontal',
  morevertical: 'more-vertical',
  // common rename: older lucide-react Home → House in newer sets (both exist)
  home: 'home'
};

function kebabToPascal(slug) {
  return String(slug || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}

function pascalToKebab(name) {
  return String(name || '')
    .replace(/^Lucide/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

export function normalizeLucideSlug(rawSlug) {
  let slug = String(rawSlug || '')
    .replace(/^lucide-?/i, '')
    .replace(/_/g, '-')
    .trim()
    .toLowerCase();
  if (!slug) return 'circle';
  if (LUCIDE_SLUG_ALIASES[slug]) return LUCIDE_SLUG_ALIASES[slug];
  const compact = slug.replace(/-/g, '');
  if (LUCIDE_SLUG_ALIASES[compact]) return LUCIDE_SLUG_ALIASES[compact];
  return slug;
}

export function resolveLucidePascalName(raw) {
  const rawStr = String(raw || '').trim();
  if (!rawStr) return 'Circle';

  // Already Pascal: Home, LucideHome, UserCog
  if (/^Lucide[A-Z]/.test(rawStr)) {
    const bare = rawStr.slice('Lucide'.length);
    if (icons[bare]) return bare;
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(rawStr) && icons[rawStr]) return rawStr;

  const slug = normalizeLucideSlug(rawStr);
  const pascal = kebabToPascal(slug);
  if (icons[pascal]) return pascal;

  // Try without hyphens collapsing differently
  const alt = kebabToPascal(slug.replace(/-/g, ''));
  if (icons[alt]) return alt;

  // House/Home alias
  if (pascal === 'Home' && icons.House) return 'House';
  if (pascal === 'House' && icons.Home) return 'Home';

  return icons[pascal] ? pascal : 'Circle';
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function attrsToString(attrs) {
  return Object.entries(attrs || {})
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeAttr(v)}"`))
    .join(' ');
}

function renderIconNode(node) {
  if (!Array.isArray(node) || node.length < 2) return '';
  const [tag, attrs, children] = node;
  const attrStr = attrsToString(attrs);
  if (!children || (Array.isArray(children) && children.length === 0)) {
    return `<${tag}${attrStr ? ` ${attrStr}` : ''} />`;
  }
  if (typeof children === 'string') {
    return `<${tag}${attrStr ? ` ${attrStr}` : ''}>${children}</${tag}>`;
  }
  const inner = children.map((child) => renderIconNode(child)).join('');
  return `<${tag}${attrStr ? ` ${attrStr}` : ''}>${inner}</${tag}>`;
}

/**
 * Build a full inline <svg>...</svg> for a Lucide icon.
 * @param {string} name - Home | lucideHome | log-out | LucideLogOut
 * @param {string} [extraAttrs] - additional HTML attributes string (class="...", etc.)
 */
export function buildInlineLucideSvg(name, extraAttrs = '') {
  const pascal = resolveLucidePascalName(name);
  const tree = icons[pascal] || icons.Circle;
  if (!Array.isArray(tree) || tree[0] !== 'svg') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extraAttrs ? ` ${extraAttrs.trim()}` : ''} aria-hidden="true"></svg>`;
  }

  const [, baseAttrs, children] = tree;
  const merged = { ...baseAttrs, 'aria-hidden': 'true' };

  // Parse extraAttrs loosely and merge (class / className / size / width / height)
  const cleaned = String(extraAttrs || '')
    .replace(/\/\s*$/, '')
    .trim()
    .replace(/\bclassName\s*=/g, 'class=')
    .replace(/\b\[className\]\s*=/g, '[class]=')
    // Drop lucide directive leftovers
    .replace(/\s*lucide[A-Z][A-Za-z0-9]*\b/g, '')
    .replace(/\s*\[lucide(?:Icon)?\]\s*=\s*(?:"[^"]*"|'[^']*')/g, '')
    .replace(/\s*lucideIcon\s*=\s*(?:"[^"]*"|'[^']*')/g, '')
    .trim();

  // Pull plain class="..." into merged attrs when possible; leave Angular bindings as raw extras
  let rawExtras = cleaned;
  const classMatch = cleaned.match(/\bclass\s*=\s*"([^"]*)"/);
  if (classMatch && !/\[class\]|\(class\)|\{\{/.test(cleaned)) {
    merged.class = classMatch[1];
    rawExtras = cleaned.replace(/\bclass\s*=\s*"[^"]*"/, '').trim();
  }

  // size="16" / width / height overrides
  for (const key of ['width', 'height', 'stroke-width']) {
    const re = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`);
    const m = rawExtras.match(re);
    if (m) {
      merged[key] = m[1];
      rawExtras = rawExtras.replace(re, '').trim();
    }
  }

  const attrStr = attrsToString(merged);
  const inner = (children || []).map((child) => renderIconNode(child)).join('');
  return `<svg ${attrStr}${rawExtras ? ` ${rawExtras}` : ''}>${inner}</svg>`;
}

/**
 * Collect PascalCase icon names imported from lucide packages in a TS source file.
 */
export function collectLucideImportNames(source) {
  const names = new Set();
  if (!source) return names;
  const re =
    /import\s*\{([^}]*)\}\s*from\s*['"](?:lucide-react|lucide-angular|@lucide\/angular|lucide)['"]\s*;?/g;
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const bare = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (!bare) continue;
      if (
        bare === 'createLucideIcon' ||
        bare === 'icons' ||
        bare === 'default' ||
        bare.startsWith('provide') ||
        bare.endsWith('Module')
      ) {
        continue;
      }
      names.add(bare.replace(/^Lucide/, '') || bare);
      names.add(bare);
    }
  }
  return names;
}

/**
 * Rewrite all Lucide-ish markup in an Angular HTML template to plain inline SVG.
 */
export function rewriteHtmlLucideToInlineSvg(html, source = '') {
  if (!html) return html;
  let updated = html;
  const imported = collectLucideImportNames(source);

  // <lucide-home class="x"></lucide-home> / />
  updated = updated.replace(
    /<lucide-([a-z0-9-]+)([^>]*?)(?:\/>|>([\s\S]*?)<\/lucide-\1>)/gi,
    (_full, slug, attrs) => buildInlineLucideSvg(slug, attrs)
  );
  updated = updated.replace(/<\/lucide-[a-z0-9-]+>/gi, '');

  // <LucideHome .../> / <LucideHome>...</LucideHome>
  updated = updated.replace(
    /<(Lucide[A-Z][A-Za-z0-9]*)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g,
    (_full, symbol, attrs) => {
      if (symbol === 'LucideIcon' || symbol === 'LucideIconNode') return _full;
      return buildInlineLucideSvg(symbol, attrs);
    }
  );

  // <svg lucideHome class="x"></svg> or <svg lucideHome ... />
  updated = updated.replace(
    /<svg([^>]*?)\s(lucide[A-Z][A-Za-z0-9]*)\b([^>]*)>([\s\S]*?)<\/svg>/g,
    (_full, pre, attr, post) => buildInlineLucideSvg(attr, `${pre} ${post}`)
  );
  updated = updated.replace(
    /<svg([^>]*?)\s(lucide[A-Z][A-Za-z0-9]*)\b([^>]*)\/>/g,
    (_full, pre, attr, post) => buildInlineLucideSvg(attr, `${pre} ${post}`)
  );

  // <svg [lucide]="'Power'"> / [lucideIcon]="'home'"
  updated = updated.replace(
    /<svg([^>]*)\s\[lucide(?:Icon)?\]="\s*'([A-Za-z0-9-]+)'\s*"([^>]*)>([\s\S]*?)<\/svg>/gi,
    (_full, pre, name, post) => buildInlineLucideSvg(name, `${pre} ${post}`)
  );
  updated = updated.replace(
    /<svg([^>]*)\s\[lucide(?:Icon)?\]="\s*'([A-Za-z0-9-]+)'\s*"([^>]*)\/>/gi,
    (_full, pre, name, post) => buildInlineLucideSvg(name, `${pre} ${post}`)
  );
  // Ternary with same both sides
  updated = updated.replace(
    /<svg([^>]*)\s\[lucide(?:Icon)?\]="[^"]*\?\s*'([A-Za-z0-9-]+)'\s*:\s*'\2'\s*"([^>]*)>([\s\S]*?)<\/svg>/gi,
    (_full, pre, name, post) => buildInlineLucideSvg(name, `${pre} ${post}`)
  );

  // React-style <Home className="x" /> when Home was imported from lucide-*
  if (imported.size) {
    for (const name of imported) {
      const bare = name.replace(/^Lucide/, '');
      if (!bare || !/^[A-Z]/.test(bare)) continue;
      if (!icons[bare] && !icons[`Lucide${bare}`] && !icons[name]) continue;
      const re = new RegExp(
        `<${bare}(\\s[^>]*)?(?:\\/>|>([\\s\\S]*?)<\\/${bare}>)`,
        'g'
      );
      updated = updated.replace(re, (_full, attrs = '') => buildInlineLucideSvg(bare, attrs));
    }
  }

  return updated;
}

/**
 * Remove every lucide package import and Lucide* / icon entries from @Component imports.
 */
export function stripLucidePackageUsage(source) {
  if (!source) return source;
  let updated = source;

  // Remember names imported from lucide packages before deleting lines
  const lucideNames = collectLucideImportNames(updated);

  // Drop import lines from lucide packages
  updated = updated.replace(
    /^\s*import\s*\{[^}]*\}\s*from\s*['"](?:lucide-react|lucide-angular|@lucide\/angular|lucide)['"]\s*;?\s*\n?/gm,
    ''
  );
  updated = updated.replace(
    /^\s*import\s+\w+\s+from\s*['"](?:lucide-react|lucide-angular|@lucide\/angular|lucide)['"]\s*;?\s*\n?/gm,
    ''
  );

  // Remove Lucide* / provideLucide* / known icon names from standalone imports arrays
  updated = updated.replace(
    /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
    (full, start, mid, end) => {
      const items = mid
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((item) => {
          const bare = item.split(/\s+as\s+/)[0].trim();
          const unprefixed = bare.replace(/^Lucide/, '');
          if (/^Lucide[A-Z]/.test(bare)) return false;
          if (/^provideLucide/.test(bare)) return false;
          if (bare === 'LucideIcon' || bare === 'LucideIconModule' || bare === 'LucideAngularModule') {
            return false;
          }
          if (lucideNames.has(bare) || lucideNames.has(unprefixed)) return false;
          if (icons[bare] || icons[unprefixed]) return false;
          return true;
        });
      return `${start}${items.join(', ')}${end}`;
    }
  );

  return updated;
}

export { pascalToKebab, kebabToPascal };
