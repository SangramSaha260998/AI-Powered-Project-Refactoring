import fs from 'fs';
import path from 'path';
import { ensureDirectoryExists } from '../utils/file.js';

/**
 * Post-generation repair for migrated Angular / React workspaces.
 * Fixes the systemic issues AI conversions commonly introduce.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function walkFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkFiles(full, predicate, results);
    } else if (predicate(entry.name, full)) {
      results.push(full);
    }
  }
  return results;
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function toPascalCase(name) {
  return String(name)
    .replace(/\.component$/i, '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function componentClassNameFromFile(filePath) {
  const base = path.basename(filePath, '.ts');
  if (base === 'app.component') return 'AppComponent';
  const withoutSuffix = base.replace(/\.component$/i, '');
  const pascal = toPascalCase(withoutSuffix);
  return pascal.endsWith('Component') ? pascal : `${pascal}Component`;
}

function ensureImport(source, symbol, fromModule) {
  const fromRe = fromModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingRe = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${fromRe}['"]\\s*;?`,
    'g'
  );

  let symbolPresent = false;
  let updated = source.replace(existingRe, (full, names) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
    const bareNames = parts.map((n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
    if (bareNames.includes(symbol)) {
      symbolPresent = true;
      return full;
    }
    // Only augment the first import from this module
    if (symbolPresent) return full;
    symbolPresent = true;
    return `import { ${parts.concat(symbol).join(', ')} } from '${fromModule}';`;
  });

  if (symbolPresent) return dedupeImports(updated);

  const line = `import { ${symbol} } from '${fromModule}';`;
  const lastImport = [...updated.matchAll(/^import\s.+;$/gm)].pop();
  if (lastImport && lastImport.index !== undefined) {
    const insertAt = lastImport.index + lastImport[0].length;
    updated = `${updated.slice(0, insertAt)}\n${line}${updated.slice(insertAt)}`;
  } else {
    updated = `${line}\n${updated}`;
  }
  return dedupeImports(updated);
}

function removeNamedImport(source, symbol, fromModule) {
  const fromRe = fromModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namedImportRe = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${fromRe}['"]\\s*;?\\s*\\n?`,
    'g'
  );
  return source.replace(namedImportRe, (full, names) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
    const hasSymbol = parts.some(
      (n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() === symbol
    );
    if (!hasSymbol) return full;
    const remaining = parts.filter(
      (n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() !== symbol
    );
    if (remaining.length === 0) return '';
    return `import { ${remaining.join(', ')} } from '${fromModule}';\n`;
  });
}

/** Collapse duplicate identical import lines. */
function dedupeImports(source) {
  const seen = new Set();
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('import ')) return true;
      if (seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    })
    .join('\n');
}

function rewriteImportModule(source, fromModule, toModule) {
  const re = new RegExp(
    `(from\\s*['"])${fromModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"])`,
    'g'
  );
  return source.replace(re, `$1${toModule}$2`);
}

function hasDecoratorImportsArray(source) {
  return /@Component\s*\(\s*\{[\s\S]*?\bimports\s*:/.test(source);
}

function ensureDecoratorImport(source, symbol) {
  if (!/@Component\s*\(/.test(source)) return source;

  if (hasDecoratorImportsArray(source)) {
    return source.replace(/(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/, (full, start, mid, end) => {
      const items = mid.split(',').map((s) => s.trim()).filter(Boolean);
      if (items.some((item) => item === symbol || item.startsWith(`${symbol} `))) {
        return full;
      }
      const next = items.length ? `${items.join(', ')}, ${symbol}` : symbol;
      return `${start}${next}${end}`;
    });
  }

  return source.replace(/(@Component\s*\(\s*\{)/, `$1\n  imports: [${symbol}],`);
}

function ensureStandaloneTrue(source) {
  if (!/@Component\s*\(/.test(source)) return source;
  if (/\bstandalone\s*:/.test(source)) {
    return source.replace(/\bstandalone\s*:\s*false/, 'standalone: true');
  }
  return source.replace(/(@Component\s*\(\s*\{)/, `$1\n  standalone: true,`);
}

/**
 * Insert members just inside the first exported class body.
 */
function insertIntoClassBody(source, snippet) {
  if (!snippet || !snippet.trim()) return source;
  return source.replace(/(export\s+class\s+\w+[^{]*\{)/, `$1\n${snippet}\n`);
}

function classHasMember(source, name) {
  const re = new RegExp(
    `\\b(?:(?:public|protected|private|readonly)\\s+)*${name}\\s*[=:(]|\\bget\\s+${name}\\s*\\(|\\b${name}\\s*\\(`
  );
  return re.test(source);
}

/**
 * Map legacy/AI lucide tag slugs to real Lucide icon slugs (kebab-case).
 * AI often emits <lucide-logout> instead of log-out.
 */
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
  morevertical: 'more-vertical'
};

function normalizeLucideSlug(rawSlug) {
  let slug = String(rawSlug || '')
    .replace(/^lucide-?/i, '')
    .replace(/_/g, '-')
    .trim()
    .toLowerCase();
  if (!slug) return 'circle';
  if (LUCIDE_SLUG_ALIASES[slug]) return LUCIDE_SLUG_ALIASES[slug];
  // logout already handled; also collapse accidental camelCase leftovers
  const compact = slug.replace(/-/g, '');
  if (LUCIDE_SLUG_ALIASES[compact]) return LUCIDE_SLUG_ALIASES[compact];
  return slug;
}

function lucideSlugToSymbolAndAttr(rawSlug) {
  const slug = normalizeLucideSlug(rawSlug);
  const pascal = slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return {
    slug,
    symbol: `Lucide${pascal}`,
    attr: `lucide${pascal}`
  };
}

/**
 * Rewrite forbidden legacy / React lucide usages into @lucide/angular SVG form:
 *   <lucide-logout class="x"></lucide-logout>
 *   <LucideLogOut class="x" />
 * into:
 *   <svg lucideLogOut class="x"></svg>
 */
function rewriteLegacyLucideHtmlTags(html) {
  if (!html || !/lucide/i.test(html)) return html;

  let updated = html;

  // Legacy element tags: <lucide-foo ...>…</lucide-foo> or <lucide-foo .../>
  updated = updated.replace(
    /<lucide-([a-z0-9-]+)([^>]*?)(?:\/>|>([\s\S]*?)<\/lucide-\1>)/gi,
    (_full, slug, attrs) => {
      const { attr } = lucideSlugToSymbolAndAttr(slug);
      const cleanAttrs = normalizeLucideSvgAttrs(attrs);
      return `<svg ${attr}${cleanAttrs ? ` ${cleanAttrs}` : ''}></svg>`;
    }
  );
  updated = updated.replace(/<\/lucide-[a-z0-9-]+>/gi, '');

  // PascalCase component tags AI sometimes emits: <LucideHome ...></LucideHome> / />
  updated = updated.replace(
    /<(Lucide[A-Z][A-Za-z0-9]*)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g,
    (_full, symbol, attrs) => {
      if (symbol === 'LucideIcon' || symbol === 'LucideIconNode') return _full;
      const attr = `lucide${symbol.slice('Lucide'.length)}`;
      const cleanAttrs = normalizeLucideSvgAttrs(attrs);
      return `<svg ${attr}${cleanAttrs ? ` ${cleanAttrs}` : ''}></svg>`;
    }
  );

  // React leftover self-closing icons that kept lucide-react names as elements when
  // the file already imports Lucide* — e.g. <Home class="x" /> is too ambiguous;
  // only rewrite when written as lucide-prefixed or Lucide-prefixed (handled above).

  return updated;
}

function normalizeLucideSvgAttrs(attrs) {
  return String(attrs || '')
    .replace(/\/\s*$/, '')
    .trim()
    .replace(/\bclassName\s*=/g, 'class=')
    .replace(/\b\[className\]\s*=/g, '[class]=');
}

/**
 * lucide-react exports Home/Search; @lucide/angular exports LucideHome/LucideSearch.
 * Rename named imports and matching @Component imports entries.
 */
function renameLucideReactSymbolsToAngular(source) {
  if (!/from\s*['"]@lucide\/angular['"]/.test(source)) return source;

  const renamed = new Map(); // Home → LucideHome

  let updated = source.replace(
    /import\s*\{([^}]*)\}\s*from\s*['"]@lucide\/angular['"]\s*;?/g,
    (full, names) => {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
      const mapped = parts.map((p) => {
        const isType = /^type\s+/.test(p);
        const bare = p.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        const alias = p.includes(' as ') ? p.split(/\s+as\s+/)[1].trim() : null;
        if (
          bare.startsWith('Lucide') ||
          bare === 'provideLucideIcons' ||
          bare === 'provideLucideConfig' ||
          bare === 'LucideIcon' ||
          bare === 'LucideIconNode'
        ) {
          return p;
        }
        const angularName = `Lucide${bare}`;
        renamed.set(bare, angularName);
        if (alias) {
          renamed.set(alias, angularName);
          return `${isType ? 'type ' : ''}${angularName}`;
        }
        return `${isType ? 'type ' : ''}${angularName}`;
      });
      return `import { ${[...new Set(mapped)].join(', ')} } from '@lucide/angular';`;
    }
  );

  if (renamed.size === 0) return updated;

  // Update @Component({ imports: [Home, ...] }) → [LucideHome, ...]
  updated = updated.replace(
    /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
    (full, start, mid, end) => {
      const items = mid.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
        return renamed.get(item) || item;
      });
      return `${start}${items.join(', ')}${end}`;
    }
  );

  return updated;
}

/**
 * Ensure every lucideXxx attribute / LucideXxx usage has a matching import + decorator import.
 */
function syncLucideImportsFromTemplate(source, html) {
  const symbols = new Set();

  for (const m of html.matchAll(/\s(lucide[A-Z][A-Za-z0-9]*)\b/g)) {
    const attr = m[1];
    symbols.add(`Lucide${attr.slice('lucide'.length)}`);
  }
  for (const m of html.matchAll(/<lucide-([a-z0-9-]+)/gi)) {
    symbols.add(lucideSlugToSymbolAndAttr(m[1]).symbol);
  }
  // Keep already-imported Lucide* that still appear as values
  for (const m of source.matchAll(/\b(Lucide[A-Z][A-Za-z0-9]*)\b/g)) {
    if (['LucideIcon', 'LucideIconNode', 'LucideIconData'].includes(m[1])) continue;
    // Only keep if referenced in template attrs we care about — skip unused later via warnings
  }

  let updated = source;
  for (const sym of symbols) {
    updated = ensureImport(updated, sym, '@lucide/angular');
    updated = ensureDecoratorImport(updated, sym);
  }
  // Drop LucideIconModule-style leftovers again after sync
  updated = repairLucideAngularImports(updated);
  return updated;
}

/**
 * Fix hallucinated @lucide/angular module-style imports.
 * LucideIconModule / LucideAngularModule do not exist on @lucide/angular.
 */
function repairLucideAngularImports(source) {
  const hallucinated = ['LucideIconModule', 'LucideAngularModule', 'LucideAngularComponent'];
  let updated = source;

  for (const sym of hallucinated) {
    if (new RegExp(`\\b${sym}\\b`).test(updated)) {
      updated = removeNamedImport(updated, sym, '@lucide/angular');
      updated = removeNamedImport(updated, sym, 'lucide-angular');
      updated = updated.replace(
        /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
        (full, start, mid, end) => {
          const items = mid
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((item) => item !== sym && !item.startsWith(`${sym} `));
          return `${start}${items.join(', ')}${end}`;
        }
      );
    }
  }

  // LucideIcon is a directive/component value in @lucide/angular — but AI sometimes
  // treats it as a type-only import inside NgModules. Strip from NgModule imports.
  if (/@NgModule\s*\(/.test(updated) && /\bLucideIcon\b/.test(updated)) {
    updated = updated.replace(
      /(@NgModule\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
      (full, start, mid, end) => {
        const items = mid
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((item) => item !== 'LucideIcon');
        return `${start}${items.join(', ')}${end}`;
      }
    );
  }

  return updated;
}

/**
 * Collect template identifiers that must exist on the component class.
 * Conservative: only root member accesses / calls, not loop vars or nested props.
 */
function collectTemplateMemberNames(html) {
  const names = new Set();
  const skip = new Set([
    'true', 'false', 'null', 'undefined', 'this', 'as', 'let', 'of', 'if', 'else',
    'then', 'track', 'when', 'case', 'default', 'void', 'typeof', 'instanceof',
    'new', 'await', 'async', 'class', 'style', 'ngClass', 'ngStyle', 'ngIf', 'ngFor',
    'ngModel', 'ngSwitch', 'index', 'first', 'last', 'even', 'odd', 'count',
    '$event', '$implicit', 'item', 'event'
  ]);

  const add = (id) => {
    if (!id || skip.has(id)) return;
    if (/^[A-Z]/.test(id)) return;
    if (id.startsWith('ng') || id.startsWith('lucide') || id.startsWith('app')) return;
    names.add(id);
  };

  for (const m of html.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);

  for (const m of html.matchAll(/(?:\[[\w.-]+\]|\([\w.-]+\))="\s*([A-Za-z_][A-Za-z0-9_]*)\s*[.(]/g)) {
    add(m[1]);
  }

  for (const m of html.matchAll(/\[\(ngModel\)\]="\s*([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);

  for (const m of html.matchAll(/\*ngIf="([^"]*)"/g)) {
    for (const id of m[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      if (!skip.has(id[1])) add(id[1]);
    }
  }

  for (const m of html.matchAll(/\*ngFor="\s*let\s+\w+\s+of\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    add(m[1]);
  }

  for (const m of html.matchAll(/@if\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);
  for (const m of html.matchAll(/@for\s*\(\s*\w+\s+of\s+([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);

  return names;
}

/**
 * Stub missing template members so the app compiles after inconsistent AI sibling generation.
 */
function stubMissingTemplateMembers(source, html) {
  const needed = collectTemplateMemberNames(html);
  const snippets = [];

  for (const name of needed) {
    if (classHasMember(source, name)) continue;
    // Heuristic stubs
    if (/^(is|has|show|hide|can|should|creating|editing|loading|open|disabled)/i.test(name) ||
        name.endsWith('Count') ||
        name === 'q') {
      snippets.push(`  ${name}: any = ${name === 'q' ? "''" : 'false'};`);
    } else if (/s$/.test(name) || /List|Items|Users|Options|Rows/i.test(name) || name === 'filteredUsers') {
      snippets.push(`  ${name}: any[] = [];`);
    } else if (/^(on|handle|toggle|create|edit|save|cancel|submit|delete|remove|add|close|open|select|scroll)/i.test(name) ||
               /For$|Date$|Of$/.test(name) ||
               name === 'initials' ||
               name === 'gradientFor' ||
               name === 'shortDate') {
      snippets.push(`  ${name}(..._args: any[]) { return _args[0] ?? null; }`);
    } else {
      snippets.push(`  ${name}: any = null;`);
    }
  }

  if (!snippets.length) return source;
  return insertIntoClassBody(source, snippets.join('\n'));
}

/**
 * Import standalone child components referenced as <app-...> in the template.
 */
function syncAppChildComponentImports(source, html, tsPath, srcRoot) {
  const selectors = [...html.matchAll(/<(app-[a-z0-9-]+)\b/gi)].map((m) => m[1].toLowerCase());
  if (!selectors.length) return source;

  const bySelector = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts'))) {
    if (path.resolve(file) === path.resolve(tsPath)) continue;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const sel = content.match(/selector\s*:\s*['"]([^'"]+)['"]/);
      const cls = content.match(/export\s+class\s+(\w+)/);
      if (sel && cls) bySelector.set(sel[1].toLowerCase(), { file, className: cls[1] });
    } catch {
      /* ignore */
    }
  }

  let updated = source;
  for (const sel of new Set(selectors)) {
    const hit = bySelector.get(sel);
    if (!hit) continue;
    if (new RegExp(`\\b${hit.className}\\b`).test(updated) &&
        new RegExp(`imports\\s*:\\s*\\[[^\\]]*\\b${hit.className}\\b`).test(updated)) {
      continue;
    }
    let rel = path.relative(path.dirname(tsPath), hit.file).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    rel = rel.replace(/\.ts$/, '');
    updated = ensureImport(updated, hit.className, rel);
    updated = ensureDecoratorImport(updated, hit.className);
  }
  return updated;
}

/**
 * Fix FormBuilder / FormGroup definite-assignment and init-order mistakes.
 */
function repairFormBuilderInit(source) {
  let updated = source;

  // form: FormGroup; without initializer → form!: FormGroup;
  updated = updated.replace(
    /(^\s*)(form\s*:\s*FormGroup\s*;)/m,
    '$1form!: FormGroup;'
  );

  // form: FormGroup = this.fb.group before fb is declared → use inject(FormBuilder)
  if (/form\s*:\s*FormGroup\s*=\s*this\.fb\b/.test(updated)) {
    updated = ensureImport(updated, 'inject', '@angular/core');
    updated = ensureImport(updated, 'FormBuilder', '@angular/forms');
    if (!/fb\s*=\s*inject\(\s*FormBuilder\s*\)/.test(updated)) {
      updated = insertIntoClassBody(
        updated,
        '  private readonly fb = inject(FormBuilder);'
      );
    }
    // Remove broken duplicate fb declarations that reference themselves
    updated = updated.replace(
      /^\s*private\s+readonly\s+fb\s*:\s*FormBuilder\s*=\s*this\.fbInstance\s*;\s*$/gm,
      ''
    );
    updated = updated.replace(
      /^\s*(?:private|protected|public)?\s*readonly\s+fbInstance\b.*$/gm,
      ''
    );
  }

  // changes.initial → changes['initial']
  updated = updated.replace(/\bchanges\.(\w+)\b/g, "changes['$1']");

  // EventEmitter typed as void wrongly: onSave(user) when Output is EventEmitter<void>
  // Soft-fix common pattern: this.onSave(user) → this.onSave.emit(user) if onSave is Output
  updated = updated.replace(/\bthis\.(\w+)\(([^)]*)\)\s*;/g, (full, name, args) => {
    if (new RegExp(`@Output\\(\\)\\s*${name}\\s*=`).test(updated)) {
      return `this.${name}.emit(${args});`;
    }
    return full;
  });

  return updated;
}

/**
 * Normalize common embla-carousel import hallucinations.
 */
function repairEmblaImports(source) {
  if (!/from\s*['"]embla-carousel['"]/.test(source)) return source;

  let updated = source;
  updated = updated.replace(
    /import\s*\{([^}]*)\}\s*from\s*['"]embla-carousel['"]\s*;?/,
    (full, names) => {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
      const needsDefault = parts.some(
        (p) => p.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() === 'Embla'
      );
      const typeImports = [];
      for (const p of parts) {
        const bare = p.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (bare === 'Embla') continue;
        if (bare === 'EmblaOptions') typeImports.push('EmblaOptionsType');
        else if (bare === 'EmblaApi' || bare === 'EmblaCarouselApi') typeImports.push('EmblaCarouselType');
        else typeImports.push(bare);
      }
      const unique = [...new Set(typeImports)];
      if (needsDefault && unique.length) {
        return `import EmblaCarousel, { ${unique.join(', ')} } from 'embla-carousel';`;
      }
      if (needsDefault) return `import EmblaCarousel from 'embla-carousel';`;
      if (unique.length) return `import { ${unique.join(', ')} } from 'embla-carousel';`;
      return `import EmblaCarousel from 'embla-carousel';`;
    }
  );

  // Only rewrite type/value usages when we introduced EmblaCarousel default import
  if (/\bimport\s+EmblaCarousel\b/.test(updated)) {
    updated = updated.replace(
      /(?<![\w.])Embla(?!Carousel|Options|Api)(?=\s*[\(<])/g,
      'EmblaCarousel'
    );
  }
  updated = updated.replace(/\bEmblaOptions\b/g, 'EmblaOptionsType');
  updated = updated.replace(/\bEmblaApi\b/g, 'EmblaCarouselType');

  return updated;
}

/**
 * Repair Angular HTML leftovers that commonly break ng serve after React conversions.
 */
function repairAngularTemplateHtml(html, source) {
  let updated = html;

  // Empty event bindings are invalid
  updated = updated.replace(/\s*\((click|input|change|submit|blur|focus|keydown|keyup)\)\s*=\s*(["'])\s*\2/g, '');

  // Strip illegal `return ...` from event bindings; keep preceding statements
  updated = updated.replace(
    /\((click|input|change|submit)\)="([^"]*)"/g,
    (full, evt, expr) => {
      let fixed = expr
        .replace(/;?\s*return\s+[^;]*;?\s*$/g, '')
        .replace(/;?\s*return\s+[^;]*;?/g, '')
        .trim()
        .replace(/;\s*$/, '');
      if (!fixed) return '';
      // If still multi-statement with return leftovers cleaned, leave as statement list
      return `(${evt})="${fixed}"`;
    }
  );

  // Form validator index-signature access
  updated = updated.replace(
    /\.errors\?\.(required|minlength|maxlength|pattern|email|min|max)\b/g,
    ".errors?.['$1']"
  );
  updated = updated.replace(
    /\.errors\.(required|minlength|maxlength|pattern|email|min|max)\b/g,
    ".errors['$1']"
  );

  return updated;
}

/**
 * Ensure template-referenced helpers/inputs exist on the component class.
 */
function ensureTemplateMembers(source, html) {
  let updated = source;
  const snippets = [];

  if (/\bcn\s*\(/.test(html) && !classHasMember(updated, 'cn')) {
    updated = ensureImport(updated, 'cn', '@/lib/utils');
    snippets.push('  protected readonly cn = cn;');
  }

  if (/\bclassName\b/.test(html) && !classHasMember(updated, 'className')) {
    updated = ensureImport(updated, 'Input', '@angular/core');
    snippets.push("  @Input() className = '';");
  }

  // Common React→Angular open-state mismatch: template uses isOpen, class has open
  if (/\bisOpen\b/.test(html) && !classHasMember(updated, 'isOpen') && classHasMember(updated, 'open')) {
    snippets.push('  get isOpen() { return this.open; }');
  }

  if (/@HostListener\b/.test(updated)) {
    updated = ensureImport(updated, 'HostListener', '@angular/core');
  }

  // Drop node:process / process imports from browser components
  updated = updated.replace(/import\s+process\s+from\s*['"]node:process['"]\s*;?\s*\n?/g, '');
  updated = updated.replace(/import\s+\*\s+as\s+process\s+from\s*['"](?:node:)?process['"]\s*;?\s*\n?/g, '');
  updated = updated.replace(/import\s+process\s+from\s*['"]process['"]\s*;?\s*\n?/g, '');

  if (snippets.length) {
    updated = insertIntoClassBody(updated, snippets.join('\n'));
  }

  return updated;
}

function stripCssLeakedIntoTs(source) {
  // Remove broken/unterminated styles/template blocks first
  let cleaned = source
    .replace(/styles\s*:\s*`[\s\S]*?(?:`\s*,?|,)/g, '')
    .replace(/styles\s*:\s*\[[\s\S]*?(?:\]\s*,?|,)/g, '')
    .replace(/styleUrls?\s*:\s*\[[^\]]*\]\s*,?/g, '')
    .replace(/template\s*:\s*`[\s\S]*?(?:`\s*,?|,)/g, '');

  // Find end of the LAST exported class so multi-component files stay intact
  const classStarts = [...cleaned.matchAll(/export\s+class\s+\w+[^{]*\{/g)];
  if (classStarts.length === 0) {
    cleaned = cleaned.replace(/,\s*(\n\s*\}\))/g, '$1');
    return cleaned;
  }

  const lastMatch = classStarts[classStarts.length - 1];
  const lastStart = lastMatch.index ?? 0;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let classEnd = -1;

  for (let i = lastStart; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') inTemplate = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        classEnd = i;
        break;
      }
    }
  }

  if (classEnd !== -1) {
    const head = cleaned.slice(0, classEnd + 1);
    const tail = cleaned.slice(classEnd + 1);
    const hasMoreTs =
      /(?:^|\n)\s*(?:export\s+)?(?:class|function|const|type|interface|enum|@Component|@Directive|@Pipe|@Injectable)\b/.test(
        tail
      );
    if (hasMoreTs) {
      // Keep TypeScript that follows (additional exports). Only drop pure CSS/HTML chunks.
      cleaned = head + tail
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          if (!t) return true;
          if (/^(export\s+|import\s+|type\s+|interface\s+|const\s+|function\s+|enum\s+|\/\/|\/\*|@Component|@Directive|@Pipe|@Injectable|@Input|@Output)/.test(t)) {
            return true;
          }
          // Drop obvious CSS rules / HTML tags
          if (/^(?:\.[a-zA-Z_-]|#[a-zA-Z_-]|<[a-zA-Z!/])/.test(t)) return false;
          if (/^[a-z-]+\s*:\s*[^;]+;\s*$/.test(t)) return false;
          return true;
        })
        .join('\n');
    } else {
      // Remainder is not more TS — keep only harmless trailing lines
      const safeTail = tail
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          if (!t) return true;
          if (/^(export\s+|import\s+|type\s+|interface\s+|\/\/|\/\*)/.test(t)) return true;
          if (/^[{}.#@]|:/.test(t) || /;\s*$/.test(t)) return false;
          return !/[{;]/.test(t);
        })
        .join('\n');
      cleaned = `${head}${safeTail}`;
    }
  }

  cleaned = cleaned.replace(/,\s*(\n\s*\}\))/g, '$1');
  return cleaned;
}


function extractLeakedCss(source) {
  const chunks = [];
  const styleBlocks = [
    ...source.matchAll(/styles\s*:\s*`([\s\S]*?)`/g),
    ...source.matchAll(/styles\s*:\s*\[\s*`([\s\S]*?)`\s*\]/g)
  ];
  for (const match of styleBlocks) {
    if (match[1] && /[{;]/.test(match[1])) chunks.push(match[1].trim());
  }
  return chunks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Angular component repair
// ---------------------------------------------------------------------------

function collectReferencedAssetPaths(source, tsPath) {
  const dir = path.dirname(tsPath);
  const assets = [];
  for (const match of source.matchAll(/templateUrl\s*:\s*['"]([^'"]+)['"]/g)) {
    assets.push({ type: 'html', full: path.resolve(dir, match[1]), rel: match[1] });
  }
  for (const match of source.matchAll(/styleUrl\s*:\s*['"]([^'"]+)['"]/g)) {
    assets.push({ type: 'css', full: path.resolve(dir, match[1]), rel: match[1] });
  }
  for (const match of source.matchAll(/styleUrls\s*:\s*\[([^\]]*)\]/g)) {
    for (const inner of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      assets.push({ type: 'css', full: path.resolve(dir, inner[1]), rel: inner[1] });
    }
  }
  return assets;
}

function readAllTemplates(source, tsPath) {
  const assets = collectReferencedAssetPaths(source, tsPath);
  const htmlAssets = assets.filter((a) => a.type === 'html');
  if (htmlAssets.length === 0) {
    const fallback = tsPath.replace(/\.ts$/, '.html');
    if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf-8');
    return '';
  }
  return htmlAssets
    .map((a) => (fs.existsSync(a.full) ? fs.readFileSync(a.full, 'utf-8') : ''))
    .join('\n');
}

function repairAngularComponentFile(tsPath) {
  let source = fs.readFileSync(tsPath, 'utf-8');
  const original = source;
  const className = componentClassNameFromFile(tsPath);
  const baseName = path.basename(tsPath, '.ts');
  const htmlPath = tsPath.replace(/\.ts$/, '.html');
  const cssPath = tsPath.replace(/\.ts$/, '.css');

  // Extract leaked CSS before stripping
  const leakedCss = extractLeakedCss(source);
  source = stripCssLeakedIntoTs(source);

  // Fix PRIMARY class name only when it's the common AppComponent mistake
  const firstClass = source.match(/export\s+class\s+(\w+)/);
  if (
    firstClass &&
    (firstClass[1] === 'AppComponent' || firstClass[1] === 'App' || firstClass[1] === 'Component') &&
    className !== 'AppComponent'
  ) {
    source = source.replace(/export\s+class\s+\w+/, `export class ${className}`);
  } else if (firstClass && firstClass[1] !== className && /\/app\.component\.ts$/.test(tsPath.replace(/\\/g, '/'))) {
    source = source.replace(/export\s+class\s+\w+/, `export class ${className}`);
  }

  // Wrong imports from @angular/core
  const coreWrong = ['CommonModule', 'NgIf', 'NgFor', 'NgForOf', 'NgClass', 'NgStyle', 'NgSwitch', 'NgTemplateOutlet', 'AsyncPipe', 'JsonPipe', 'DatePipe', 'CurrencyPipe', 'DecimalPipe', 'PercentPipe', 'SlicePipe', 'TitleCasePipe', 'LowerCasePipe', 'UpperCasePipe', 'KeyValuePipe'];
  for (const sym of coreWrong) {
    if (
      new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from\\s*['"]@angular\\/core['"]`).test(source)
    ) {
      source = removeNamedImport(source, sym, '@angular/core');
      source = ensureImport(source, sym, '@angular/common');
    }
  }
  source = source.replace(
    /import\s*\{\s*(CommonModule|NgIf|NgFor|NgClass|NgStyle)(?:\s*,\s*(CommonModule|NgIf|NgFor|NgClass|NgStyle))*\s*\}\s*from\s*['"]@angular\/core['"]\s*;?/g,
    (full) => {
      const symbols = [...full.matchAll(/\b(CommonModule|NgIf|NgFor|NgClass|NgStyle)\b/g)].map((m) => m[1]);
      const unique = [...new Set(symbols)];
      return `import { ${unique.join(', ')} } from '@angular/common';`;
    }
  );

  // RxJS symbols wrongly imported from @angular/core
  const rxjsWrong = ['Subject', 'BehaviorSubject', 'ReplaySubject', 'Observable', 'of', 'from', 'map', 'filter', 'takeUntil', 'take', 'tap', 'switchMap', 'catchError', 'debounceTime', 'distinctUntilChanged', 'combineLatest', 'forkJoin', 'firstValueFrom', 'lastValueFrom'];
  for (const sym of rxjsWrong) {
    if (new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from\\s*['"]@angular\\/core['"]`).test(source)) {
      source = removeNamedImport(source, sym, '@angular/core');
      source = ensureImport(source, sym, 'rxjs');
    }
  }

  // lucide-react / legacy lucide-angular → @lucide/angular (Angular 22 compatible)
  source = rewriteImportModule(source, 'lucide-react', '@lucide/angular');
  source = rewriteImportModule(source, 'lucide-angular', '@lucide/angular');
  source = renameLucideReactSymbolsToAngular(source);
  source = repairLucideAngularImports(source);
  source = repairEmblaImports(source);

  // import type { X } used as value — promote common Angular DI tokens
  const typeOnlyValueSymbols = ['DestroyRef', 'Injector', 'ElementRef', 'Renderer2', 'ChangeDetectorRef', 'NgZone', 'ViewContainerRef', 'TemplateRef'];
  for (const sym of typeOnlyValueSymbols) {
    const typeImportRe = new RegExp(
      `import\\s+type\\s*\\{([^}]*)\\}\\s*from\\s*['"]@angular\\/core['"]`
    );
    const m = source.match(typeImportRe);
    if (m && m[1].split(',').some((p) => p.trim().replace(/^type\s+/, '') === sym)) {
      if (new RegExp(`\\binject\\(\\s*${sym}\\b|\\bproviders\\s*:[\\s\\S]*\\b${sym}\\b`).test(source)) {
        source = source.replace(typeImportRe, (full, names) => {
          const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
          const remaining = parts.filter((n) => n.replace(/^type\s+/, '') !== sym);
          const lines = [];
          if (remaining.length) lines.push(`import type { ${remaining.join(', ')} } from '@angular/core';`);
          lines.push(`import { ${sym} } from '@angular/core';`);
          return `${lines.join('\n')}\n`;
        });
        source = source.replace(
          new RegExp(`(import\\s*\\{[^}]*)\\btype\\s+${sym}\\b([^}]*\\}\\s*from\\s*['"]@angular\\/core['"])`),
          `$1${sym}$2`
        );
      }
    }
  }
  source = source.replace(
    /import\s*\{([^}]*)\}\s*from\s*['"]@angular\/core['"]/g,
    (full, names) => {
      const needsValue = typeOnlyValueSymbols.some(
        (sym) =>
          new RegExp(`\\btype\\s+${sym}\\b`).test(names) &&
          new RegExp(`\\binject\\(\\s*${sym}\\b`).test(source)
      );
      if (!needsValue) return full;
      const fixed = names.replace(/\btype\s+(DestroyRef|Injector|ElementRef|Renderer2|ChangeDetectorRef|NgZone|ViewContainerRef|TemplateRef)\b/g, '$1');
      return full.replace(names, fixed);
    }
  );

  // providedIn: 'server' is invalid
  source = source.replace(/providedIn\s*:\s*['"]server['"]/g, "providedIn: 'root'");

  // ReadableSignal / Signal.write fixes
  if (/\bReadableSignal\b/.test(source)) {
    source = ensureImport(source, 'Signal', '@angular/core');
    if (/\.set\s*\(/.test(source)) {
      source = ensureImport(source, 'WritableSignal', '@angular/core');
      source = source.replace(/\bReadableSignal\b/g, 'WritableSignal');
    } else {
      source = source.replace(/\bReadableSignal\b/g, 'Signal');
    }
  }

  // signal used as a type → Signal
  source = source.replace(/:\s*signal\s*</g, ': Signal<');
  if (/:\s*Signal\s*</.test(source)) {
    source = ensureImport(source, 'Signal', '@angular/core');
  }
  // If code calls .set( on signal-typed fields, prefer WritableSignal annotations
  if (/\.set\s*\(/.test(source) && /:\s*Signal\s*</.test(source)) {
    source = ensureImport(source, 'WritableSignal', '@angular/core');
    source = source.replace(/:\s*Signal\s*</g, ': WritableSignal<');
  }

  if (/\binject\s*\(/.test(source)) {
    source = ensureImport(source, 'inject', '@angular/core');
  }
  if (/@Input\s*\(/.test(source)) {
    source = ensureImport(source, 'Input', '@angular/core');
  }
  if (/@Output\s*\(/.test(source)) {
    source = ensureImport(source, 'Output', '@angular/core');
  }
  if (/@Injectable\s*\(/.test(source)) {
    source = ensureImport(source, 'Injectable', '@angular/core');
  }

  source = ensureStandaloneTrue(source);

  // Ensure every templateUrl/styleUrl target file exists (do NOT rewrite paths)
  if (!/templateUrl\s*:/.test(source) && /@Component\s*\(/.test(source)) {
    source = source.replace(/(@Component\s*\(\s*\{)/, `$1\n  templateUrl: './${baseName}.html',`);
  }
  if (!/styleUrl\s*:/.test(source) && !/styleUrls\s*:/.test(source) && /@Component\s*\(/.test(source)) {
    source = source.replace(/(@Component\s*\(\s*\{)/, `$1\n  styleUrl: './${baseName}.css',`);
  }

  const assets = collectReferencedAssetPaths(source, tsPath);
  for (const asset of assets) {
    if (fs.existsSync(asset.full)) continue;
    ensureDirectoryExists(path.dirname(asset.full));
    if (asset.type === 'html') {
      fs.writeFileSync(asset.full, `<div class="${path.basename(asset.full, '.html')}"></div>\n`, 'utf-8');
    } else {
      fs.writeFileSync(asset.full, `/* ${path.basename(asset.full)} */\n`, 'utf-8');
    }
  }

  const template = readAllTemplates(source, tsPath);

  // Template-driven module needs
  const needsCommon =
    /\*ngIf|\*ngFor|\*ngSwitch|\[ngClass\]|\[ngStyle\]|\[ngTemplateOutlet\]|\|\s*async\b|\|\s*json\b|\|\s*date\b/.test(
      template
    ) ||
    /\*ngIf|\*ngFor|\[ngClass\]|\[ngStyle\]/.test(source);

  if (needsCommon) {
    source = ensureImport(source, 'CommonModule', '@angular/common');
    source = ensureDecoratorImport(source, 'CommonModule');
  }

  if (/\[\(ngModel\)\]|\[ngModel\]|\bngModel\b/.test(template)) {
    source = ensureImport(source, 'FormsModule', '@angular/forms');
    source = ensureDecoratorImport(source, 'FormsModule');
  }

  if (/\[formGroup\]|formControlName|\[formControl\]/.test(template)) {
    source = ensureImport(source, 'ReactiveFormsModule', '@angular/forms');
    source = ensureDecoratorImport(source, 'ReactiveFormsModule');
  }

  if (/routerLink|router-outlet|RouterLink|RouterOutlet/.test(template)) {
    if (/router-outlet/.test(template)) {
      source = ensureImport(source, 'RouterOutlet', '@angular/router');
      source = ensureDecoratorImport(source, 'RouterOutlet');
    }
    if (/routerLink|RouterLink/.test(template)) {
      source = ensureImport(source, 'RouterLink', '@angular/router');
      source = ensureDecoratorImport(source, 'RouterLink');
    }
  }

  // Remove provideHttpClient / EnvironmentProviders from @Component providers
  source = source.replace(/providers\s*:\s*\[[^\]]*(?:provideHttpClient|provideRouter|provideAnimations)[^\]]*\]\s*,?/g, '');

  // Fix ErrorHandler misuse: super.handleError in non-derived class
  if (/super\.handleError/.test(source) && !/extends\s+\w+/.test(source)) {
    source = source.replace(/super\.handleError\([^)]*\);?/g, 'console.error(error);');
  }

  // process.env without @types/node
  if (/\bprocess\.env\b/.test(source)) {
    source = source.replace(
      /\bprocess\.env\.(\w+)/g,
      "((typeof process !== 'undefined' && process.env && process.env.$1) || '')"
    );
  }

  // Repair each referenced HTML template
  const htmlFiles = new Set(
    assets.filter((a) => a.type === 'html').map((a) => a.full)
  );
  if (htmlFiles.size === 0) htmlFiles.add(htmlPath);

  for (const targetHtml of htmlFiles) {
    if (!fs.existsSync(targetHtml)) {
      fs.writeFileSync(targetHtml, `<div class="${baseName}"></div>\n`, 'utf-8');
      continue;
    }
    let html = fs.readFileSync(targetHtml, 'utf-8');
    // Self-closing capitalized / unknown components
    html = html.replace(/<([A-Z][\w.-]*)([^>]*?)\/>/g, '<$1$2></$1>');
    // Legacy lucide-angular element tags → @lucide/angular <svg lucideXxx>
    html = rewriteLegacyLucideHtmlTags(html);
    // React leftover event / form patterns
    html = repairAngularTemplateHtml(html, source);
    // Getters are not callable
    const getterNames = [...source.matchAll(/\bget\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
    for (const name of getterNames) {
      html = html.replace(new RegExp(`\\b${name}\\(\\)`, 'g'), name);
    }
    // Private fields AND methods → protected when used in templates
    const privateMembers = [
      ...source.matchAll(/\bprivate\s+(?:readonly\s+)?(_?[A-Za-z]\w*)\s*[:=(]/g)
    ].map((m) => m[1]);
    for (const name of [...new Set(privateMembers)]) {
      if (new RegExp(`\\b${name}\\b`).test(html)) {
        source = source.replace(
          new RegExp(`\\bprivate\\s+(readonly\\s+)?${name}\\b`, 'g'),
          (_, readonlyPrefix) => `protected ${readonlyPrefix || ''}${name}`
        );
      }
    }
    // Native attribute bindings
    html = html.replace(/\[minlength\]=/g, '[attr.minlength]=');
    html = html.replace(/\[maxlength\]=/g, '[attr.maxlength]=');
    // Safer select event typing patterns
    html = html.replace(
      /\$event\.target\.value/g,
      '($event.target as HTMLSelectElement).value'
    );
    // Array(...) in templates — expose helper
    if (/\bArray\s*\(/.test(html) && !/\bArray\s*=/.test(source)) {
      source = source.replace(
        /(export\s+class\s+\w+[^{]*\{)/,
        '$1\n  readonly Array = Array;\n'
      );
    }
    // Expose cn / className / HostListener / isOpen bridges
    source = ensureTemplateMembers(source, html);
    // Sync Lucide icon imports from rewritten template
    source = syncLucideImportsFromTemplate(source, html);
    // Import <app-*> children used in template
    const srcRoot = (() => {
      let dir = path.dirname(tsPath);
      while (dir && path.basename(dir) !== 'src' && dir !== path.dirname(dir)) {
        dir = path.dirname(dir);
      }
      return dir && path.basename(dir) === 'src' ? dir : path.join(path.dirname(tsPath), '..', '..');
    })();
    source = syncAppChildComponentImports(source, html, tsPath, srcRoot);
    // Stub missing template members (AI sibling mismatch)
    source = stubMissingTemplateMembers(source, html);
    source = repairFormBuilderInit(source);
    fs.writeFileSync(targetHtml, html, 'utf-8');
  }

  // Ensure default sibling css exists / is valid
  const cssFiles = new Set(
    assets.filter((a) => a.type === 'css').map((a) => a.full)
  );
  if (cssFiles.size === 0) cssFiles.add(cssPath);

  for (const targetCss of cssFiles) {
    if (!fs.existsSync(targetCss)) {
      fs.writeFileSync(targetCss, leakedCss ? `${leakedCss}\n` : `/* ${path.basename(targetCss)} */\n`, 'utf-8');
      continue;
    }
    if (leakedCss) {
      const existing = fs.readFileSync(targetCss, 'utf-8');
      if (!existing.includes(leakedCss.slice(0, Math.min(40, leakedCss.length)))) {
        fs.writeFileSync(targetCss, `${existing.trim()}\n\n${leakedCss}\n`, 'utf-8');
      }
    }
    const css = fs.readFileSync(targetCss, 'utf-8').trim();
    if (!css || (/^[^{]+$/.test(css) && !css.startsWith('/*'))) {
      fs.writeFileSync(targetCss, `/* ${path.basename(targetCss)} */\n`, 'utf-8');
    }
  }

  if (source !== original) {
    source = dedupeImports(source);
    fs.writeFileSync(tsPath, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
  } else {
    const deduped = dedupeImports(source);
    if (deduped !== source) {
      fs.writeFileSync(tsPath, deduped.endsWith('\n') ? deduped : `${deduped}\n`, 'utf-8');
    }
  }
}

function repairAngularAppBootstrap(destPath) {
  const appConfigPath = path.join(destPath, 'src', 'app', 'app.config.ts');
  const appComponentPath = path.join(destPath, 'src', 'app', 'app.component.ts');
  const mainPath = path.join(destPath, 'src', 'main.ts');
  const routesPath = path.join(destPath, 'src', 'app', 'app.routes.ts');

  // Restore a sane app.config.ts if corrupted
  const expectedConfig = `import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(),
    provideRouter(routes),
    provideAnimations()
  ]
};
`;

  if (fs.existsSync(routesPath)) {
    fs.writeFileSync(appConfigPath, expectedConfig, 'utf-8');
  } else {
    // routes file missing — create empty routes and wire them
    ensureDirectoryExists(path.dirname(routesPath));
    fs.writeFileSync(
      routesPath,
      `import { Routes } from '@angular/router';\n\nexport const routes: Routes = [];\n`,
      'utf-8'
    );
    fs.writeFileSync(appConfigPath, expectedConfig, 'utf-8');
  }

  if (fs.existsSync(appComponentPath)) {
    let appTs = fs.readFileSync(appComponentPath, 'utf-8');
    // Strip ErrorHandler / reportLovableError scaffolding that breaks bootstrap
    const isBrokenBootstrap =
      /reportLovableError/.test(appTs) ||
      (/provideHttpClient\s*\(/.test(appTs) && /@Component\s*\(/.test(appTs)) ||
      /extends\s+ErrorHandler/.test(appTs) ||
      (/super\.handleError/.test(appTs) && /@Component\s*\(/.test(appTs));

    if (isBrokenBootstrap) {
      const hasRouterOutlet =
        fs.existsSync(path.join(destPath, 'src', 'app', 'app.component.html')) &&
        /router-outlet/.test(fs.readFileSync(path.join(destPath, 'src', 'app', 'app.component.html'), 'utf-8'));

      appTs = `import { Component } from '@angular/core';
${hasRouterOutlet ? "import { RouterOutlet } from '@angular/router';\n" : ''}
@Component({
  selector: 'app-root',
  standalone: true,
${hasRouterOutlet ? '  imports: [RouterOutlet],\n' : ''}  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {}
`;
      fs.writeFileSync(appComponentPath, appTs, 'utf-8');
    } else {
      repairAngularComponentFile(appComponentPath);
      // Ensure root selector
      let fixed = fs.readFileSync(appComponentPath, 'utf-8');
      if (!/selector\s*:\s*['"]app-root['"]/.test(fixed)) {
        fixed = fixed.replace(/selector\s*:\s*['"][^'"]*['"]/, "selector: 'app-root'");
        fs.writeFileSync(appComponentPath, fixed, 'utf-8');
      }
    }
  }

  if (fs.existsSync(mainPath)) {
    fs.writeFileSync(
      mainPath,
      `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
`,
      'utf-8'
    );
  }
}

function repairAngularRoutes(destPath) {
  const routesPath = path.join(destPath, 'src', 'app', 'app.routes.ts');
  if (!fs.existsSync(routesPath)) return;

  let source = fs.readFileSync(routesPath, 'utf-8');
  const srcRoot = path.join(destPath, 'src');

  // Ensure routes is exported (app.config imports { routes })
  if (/^(?:export\s+)?const\s+routes\s*:/m.test(source) && !/export\s+const\s+routes\s*:/.test(source)) {
    source = source.replace(/^(const\s+routes\s*:)/m, 'export $1');
  }
  if (/export\s+default\s+routes/.test(source) && !/export\s+const\s+routes/.test(source)) {
    source = source.replace(/^(const\s+routes\s*:)/m, 'export $1');
  }

  // Index components by export class name
  const byClass = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts'))) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const m = content.match(/export\s+class\s+(\w+)/);
      if (m) byClass.set(m[1], file);
    } catch {
      /* ignore */
    }
  }

  // Rewrite imports that pull page/shell components from app.component (common AI mistake)
  source = source.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"](\.\/app\.component)['"]\s*;?/g,
    (full, names) => {
      const symbols = names.split(',').map((s) => s.trim()).filter(Boolean);
      const lines = [];
      const leftover = [];
      for (const sym of symbols) {
        const bare = sym.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (bare === 'AppComponent') {
          leftover.push(sym);
          continue;
        }
        const file = byClass.get(bare);
        if (!file) {
          leftover.push(sym);
          continue;
        }
        let rel = path.relative(path.dirname(routesPath), file).replace(/\\/g, '/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        rel = rel.replace(/\.ts$/, '');
        lines.push(`import { ${bare} } from '${rel}';`);
      }
      if (leftover.length) {
        lines.push(`import { ${leftover.join(', ')} } from './app.component';`);
      }
      return lines.join('\n');
    }
  );

  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  const missing = [];
  let match;
  while ((match = importRe.exec(source)) !== null) {
    const importPath = match[2];
    if (!importPath.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(routesPath), importPath);
    const candidates = [`${resolved}.ts`, `${resolved}.tsx`, resolved];
    if (!candidates.some((c) => fs.existsSync(c))) {
      missing.push({ symbols: match[1], from: importPath, full: match[0] });
    }
  }

  for (const item of missing) {
    // Create a minimal stub component so the app still compiles
    const symbols = item.symbols.split(',').map((s) => s.trim()).filter(Boolean);
    const primary = (symbols[0] || 'StubComponent').replace(/^type\s+/, '');
    const resolved = path.resolve(path.dirname(routesPath), item.from);
    const stubTs = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
    ensureDirectoryExists(path.dirname(stubTs));
    if (!fs.existsSync(stubTs)) {
      const base = path.basename(stubTs, '.ts');
      const html = stubTs.replace(/\.ts$/, '.html');
      const css = stubTs.replace(/\.ts$/, '.css');
      fs.writeFileSync(
        stubTs,
        `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-${base.replace(/\.component$/i, '')}',\n  standalone: true,\n  templateUrl: './${base}.html',\n  styleUrl: './${base}.css'\n})\nexport class ${primary} {}\n`,
        'utf-8'
      );
      if (!fs.existsSync(html)) fs.writeFileSync(html, `<p>${primary} placeholder</p>\n`, 'utf-8');
      if (!fs.existsSync(css)) fs.writeFileSync(css, `/* ${base} */\n`, 'utf-8');
      console.warn(`[postprocess] Stubbed missing route module: ${item.from}`);
    }
  }

  if (missing.length > 0) {
    console.warn(`[postprocess] app.routes.ts had ${missing.length} missing module(s); stubs created where possible.`);
  }

  fs.writeFileSync(routesPath, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
}

function addAngularPathAliases(destPath) {
  const tsconfigPath = path.join(destPath, 'tsconfig.json');
  const tsconfigAppPath = path.join(destPath, 'tsconfig.app.json');
  const tsconfig = readJsonSafe(tsconfigPath) || {};
  tsconfig.compilerOptions = tsconfig.compilerOptions || {};
  tsconfig.compilerOptions.baseUrl = './';
  tsconfig.compilerOptions.paths = {
    ...(tsconfig.compilerOptions.paths || {}),
    '@/*': ['src/*']
  };
  writeJson(tsconfigPath, tsconfig);

  if (fs.existsSync(tsconfigAppPath)) {
    const appCfg = readJsonSafe(tsconfigAppPath) || {};
    appCfg.compilerOptions = appCfg.compilerOptions || {};
    appCfg.compilerOptions.baseUrl = './';
    appCfg.compilerOptions.paths = {
      ...(appCfg.compilerOptions.paths || {}),
      '@/*': ['src/*']
    };
    writeJson(tsconfigAppPath, appCfg);
  }
}

function mergePackageDependencies(destPath, sourcePackageJson, targetFramework) {
  const pkgPath = path.join(destPath, 'package.json');
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return;

  pkg.dependencies = pkg.dependencies || {};
  pkg.devDependencies = pkg.devDependencies || {};

  const srcDeps = {
    ...(sourcePackageJson?.dependencies || {}),
    ...(sourcePackageJson?.devDependencies || {})
  };

  /** Shared UI utilities commonly needed after shadcn-style migrations */
  const alwaysUseful = {
    clsx: '^2.1.1',
    'tailwind-merge': '^2.5.0',
    'class-variance-authority': '^0.7.0'
  };

  for (const [name, version] of Object.entries(alwaysUseful)) {
    if (!pkg.dependencies[name]) pkg.dependencies[name] = version;
  }

  // Carry over non-framework runtime deps that are framework-agnostic
  const skip = new Set([
    'react', 'react-dom', 'react-router', 'react-router-dom',
    '@types/react', '@types/react-dom',
    'vite', '@vitejs/plugin-react',
    '@angular/core', '@angular/common', '@angular/compiler', '@angular/platform-browser',
    '@angular/platform-browser-dynamic', '@angular/router', '@angular/forms',
    '@angular/animations', '@angular/cli', '@angular/compiler-cli', '@angular/build',
    'zone.js', 'rxjs', 'tslib',
    // Legacy lucide-angular only peers Angular ≤19 — never carry it into Angular 22 workspaces
    'lucide-angular',
    'lucide-react',
    '@lucide/angular'
  ]);

  for (const [name, version] of Object.entries(srcDeps)) {
    if (skip.has(name)) continue;
    if (name.startsWith('@angular/')) continue;
    if (name.startsWith('@types/') && targetFramework === 'angular') continue;
    if (pkg.dependencies[name] || pkg.devDependencies[name]) continue;

    if (name.startsWith('@radix-ui/') && targetFramework === 'angular') {
      // Radix React primitives don't exist on Angular — skip; AI should use custom components
      continue;
    }

    // Prefer runtime deps for libraries (not build tooling)
    if (
      name.includes('eslint') ||
      name.includes('prettier') ||
      name.includes('vitest') ||
      name.includes('jest') ||
      name.includes('testing-library') ||
      name.startsWith('@vitejs/')
    ) {
      continue;
    }

    pkg.dependencies[name] = version;
  }

  if (targetFramework === 'angular') {
    // Ensure animations package present (templates often need it)
    if (!pkg.dependencies['@angular/animations']) {
      const coreVer = pkg.dependencies['@angular/core'] || '^22.0.8';
      pkg.dependencies['@angular/animations'] = coreVer;
    }

    // Remove legacy lucide-angular (peers only up to Angular 19 → ERESOLVE on Angular 22)
    delete pkg.dependencies['lucide-angular'];
    delete pkg.devDependencies['lucide-angular'];

    const usesLucide =
      srcDeps['lucide-react'] ||
      srcDeps['lucide-angular'] ||
      srcDeps['@lucide/angular'] ||
      walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.ts') || n.endsWith('.html')).some((f) =>
        /lucide-react|lucide-angular|@lucide\/angular/.test(fs.readFileSync(f, 'utf-8'))
      );

    if (usesLucide) {
      // @lucide/angular peers Angular 17+ (compatible with Angular 22 workspaces)
      // Legacy lucide-angular@0.x only peers up to Angular 19 and causes ERESOLVE.
      pkg.dependencies['@lucide/angular'] = '^1.23.0';
    }
  }

  if (targetFramework === 'react') {
    if (srcDeps['react-router-dom'] || walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.tsx') || n.endsWith('.jsx')).some((f) => /react-router-dom/.test(fs.readFileSync(f, 'utf-8')))) {
      pkg.dependencies['react-router-dom'] = srcDeps['react-router-dom'] || '^7.18.1';
    }
    delete pkg.dependencies['lucide-angular'];
    delete pkg.dependencies['@lucide/angular'];
    if (srcDeps['lucide-react'] || srcDeps['lucide-angular'] || srcDeps['@lucide/angular']) {
      pkg.dependencies['lucide-react'] = srcDeps['lucide-react'] || '^0.468.0';
    }
  }

  writeJson(pkgPath, pkg);
}

function copySourceLibs(destPath, sourceFilesMap) {
  if (!sourceFilesMap) return;
  const libTargets = Object.keys(sourceFilesMap).filter((p) => {
    const n = p.replace(/\\/g, '/');
    return (
      /(^|\/)lib\/.*\.(ts|tsx|js|jsx)$/.test(n) ||
      /(^|\/)utils\/.*\.(ts|tsx|js|jsx)$/.test(n) ||
      /(^|\/)hooks\/.*\.(ts|tsx|js|jsx)$/.test(n)
    );
  });

  for (const rel of libTargets) {
    const normalized = rel.replace(/\\/g, '/');
    // Map to src/lib, src/utils, src/hooks
    let destRel = normalized;
    if (!destRel.startsWith('src/')) {
      destRel = `src/${destRel.replace(/^(app\/)?/, '')}`;
    }
    // Convert tsx/jsx utilities to .ts when they have no JSX
    const content = sourceFilesMap[rel];
    const hasJsx = /<[A-Za-z]/.test(content) && (destRel.endsWith('.tsx') || destRel.endsWith('.jsx'));
    if (!hasJsx && (destRel.endsWith('.tsx') || destRel.endsWith('.jsx'))) {
      destRel = destRel.replace(/\.tsx?$/, '.ts').replace(/\.jsx?$/, '.ts');
    }

    let adapted = content
      .replace(/from\s*['"]lucide-react['"]/g, "from '@lucide/angular'")
      .replace(/from\s*['"]lucide-angular['"]/g, "from '@lucide/angular'")
      .replace(/from\s*['"]react['"]/g, "from '@angular/core'") // weak; skip if hooks file
      .replace(/import\s+React\s*,?\s*/g, '');

    // Don't blindly convert React hooks files into Angular — skip pure React hook modules
    if (/useState|useEffect|useMemo|useCallback|useRef/.test(content) && /from\s*['"]react['"]/.test(content)) {
      continue;
    }

    const full = path.join(destPath, destRel);
    if (fs.existsSync(full)) continue; // prefer AI-generated version
    ensureDirectoryExists(path.dirname(full));
    fs.writeFileSync(full, adapted.endsWith('\n') ? adapted : `${adapted}\n`, 'utf-8');
  }
}

function rewriteAtAliasImportsInTree(destPath) {
  const srcRoot = path.join(destPath, 'src');
  const files = walkFiles(srcRoot, (name) =>
    name.endsWith('.ts') || name.endsWith('.html')
  );

  // Index generated Angular components by basename stem for React-style import rewrites
  const componentIndex = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts'))) {
    const stem = path.basename(file, '.component.ts'); // admin-shell
    const pascal = toPascalCase(stem); // AdminShell
    componentIndex.set(stem.toLowerCase(), file);
    componentIndex.set(pascal.toLowerCase(), file);
    componentIndex.set(`${pascal}Component`.toLowerCase(), file);
    // Also index without admin- prefix variants
    if (stem.startsWith('admin-')) {
      componentIndex.set(stem.slice(6).toLowerCase(), file);
      componentIndex.set(toPascalCase(stem.slice(6)).toLowerCase(), file);
    }
  }

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;

    content = content.replace(/from\s*['"]lucide-react['"]/g, "from '@lucide/angular'");
    content = content.replace(/from\s*['"]lucide-angular['"]/g, "from '@lucide/angular'");
    content = renameLucideReactSymbolsToAngular(content);
    content = content.replace(
      /import\s*\{[^}]+\}\s*from\s*['"]@radix-ng\/[^'"]+['"]\s*;?/g,
      (m) => `// Removed unsupported package import: ${m.replace(/\n/g, ' ')}`
    );

    // Rewrite @/components/... React-style imports to relative Angular component paths
    content = content.replace(
      /from\s*['"]@\/components\/([^'"]+)['"]/g,
      (full, rest) => {
        const cleaned = rest.replace(/\.(tsx|ts|jsx|js)$/, '');
        const base = cleaned.split('/').pop() || cleaned;
        const candidates = [
          base,
          base.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
          base.replace(/\.component$/i, ''),
          `admin-${base.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
          `${base}Component`,
          toPascalCase(base)
        ];
        let resolved = null;
        for (const c of candidates) {
          resolved = componentIndex.get(String(c).toLowerCase());
          if (resolved) break;
        }
        if (!resolved) {
          // Stub a missing component so the import can resolve after rewrite
          const stem = base
            .replace(/\.component$/i, '')
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .toLowerCase();
          const className = toPascalCase(stem).endsWith('Component')
            ? toPascalCase(stem)
            : `${toPascalCase(stem)}Component`;
          const stubDir = path.join(srcRoot, 'app', 'components', stem);
          const stubTs = path.join(stubDir, `${stem}.component.ts`);
          if (!fs.existsSync(stubTs)) {
            ensureDirectoryExists(stubDir);
            fs.writeFileSync(
              stubTs,
              `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-${stem}',\n  standalone: true,\n  templateUrl: './${stem}.component.html',\n  styleUrl: './${stem}.component.css'\n})\nexport class ${className} {}\n`,
              'utf-8'
            );
            fs.writeFileSync(
              path.join(stubDir, `${stem}.component.html`),
              `<p>${className} placeholder</p>\n`,
              'utf-8'
            );
            fs.writeFileSync(
              path.join(stubDir, `${stem}.component.css`),
              `/* ${stem} */\n`,
              'utf-8'
            );
            console.warn(`[postprocess] Stubbed missing @/components import: ${rest} → ${stem}.component`);
          }
          resolved = stubTs;
          componentIndex.set(stem.toLowerCase(), stubTs);
          componentIndex.set(className.toLowerCase(), stubTs);
        }
        let rel = path.relative(path.dirname(file), resolved).replace(/\\/g, '/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        rel = rel.replace(/\.ts$/, '');
        return `from '${rel}'`;
      }
    );

    // Also rewrite named imports that still use React component names when possible
    // e.g. import { AdminShell } from '...' already rewritten path; fix symbol if file exports XxxComponent
    content = content.replace(
      /import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*['"]([^'"]+\.component)['"]/g,
      (full, symbol, fromPath) => {
        if (symbol.endsWith('Component')) return full;
        return `import { ${symbol}Component as ${symbol} } from '${fromPath}'`;
      }
    );

    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
  }
}

/**
 * Full Angular workspace repair after AI generation.
 */
export function repairAngularWorkspace(destPath, options = {}) {
  const { sourceFilesMap = null, sourcePackageJson = null } = options;

  addAngularPathAliases(destPath);
  copySourceLibs(destPath, sourceFilesMap);
  ensureCnUtil(destPath);
  mergePackageDependencies(destPath, sourcePackageJson, 'angular');

  const componentFiles = walkFiles(path.join(destPath, 'src'), (name) =>
    name.endsWith('.component.ts')
  );
  for (const file of componentFiles) {
    try {
      repairAngularComponentFile(file);
    } catch (err) {
      console.warn(`[postprocess] Failed repairing ${file}: ${err.message}`);
    }
  }

  // Also repair standalone .ts under components that use @Component without .component.ts suffix
  const otherTs = walkFiles(path.join(destPath, 'src'), (name, full) => {
    if (!name.endsWith('.ts') || name.endsWith('.component.ts') || name.endsWith('.spec.ts')) return false;
    try {
      return /@Component\s*\(/.test(fs.readFileSync(full, 'utf-8'));
    } catch {
      return false;
    }
  });
  for (const file of otherTs) {
    try {
      repairAngularComponentFile(file);
    } catch (err) {
      console.warn(`[postprocess] Failed repairing ${file}: ${err.message}`);
    }
  }

  // Strip Node-only imports from any remaining src files (browser build)
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.ts'))) {
    try {
      let content = fs.readFileSync(file, 'utf-8');
      const original = content;
      content = content.replace(/import\s+process\s+from\s*['"]node:process['"]\s*;?\s*\n?/g, '');
      content = content.replace(/import\s+process\s+from\s*['"]process['"]\s*;?\s*\n?/g, '');
      content = content.replace(/import\s+\*\s+as\s+process\s+from\s*['"](?:node:)?process['"]\s*;?\s*\n?/g, '');
      // config.server.ts style files don't belong in Angular browser apps
      if (/config\.server\.ts$/.test(file.replace(/\\/g, '/')) || /from\s*['"]node:/.test(content)) {
        if (/config\.server\.ts$/.test(file.replace(/\\/g, '/'))) {
          fs.unlinkSync(file);
          console.warn(`[postprocess] Removed Node-only file: ${path.relative(destPath, file)}`);
          continue;
        }
      }
      if (content !== original) {
        fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
      }
    } catch (err) {
      console.warn(`[postprocess] Failed scrubbing ${file}: ${err.message}`);
    }
  }

  repairAngularAppBootstrap(destPath);
  repairAngularRoutes(destPath);
  removeHallucinatedNgModules(destPath);
  fixBrokenRelativeComponentImports(destPath);
  rewriteAtAliasImportsInTree(destPath);

  // Second pass: child imports + lucide sync after path fixes
  for (const file of walkFiles(path.join(destPath, 'src'), (name) => name.endsWith('.component.ts'))) {
    try {
      repairAngularComponentFile(file);
    } catch (err) {
      console.warn(`[postprocess] Second-pass repair failed for ${file}: ${err.message}`);
    }
  }

  // Ensure styles.css exists
  const stylesPath = path.join(destPath, 'src', 'styles.css');
  if (!fs.existsSync(stylesPath)) {
    fs.writeFileSync(stylesPath, '/* Global styles */\n', 'utf-8');
  }
}

/**
 * Standalone Angular 22 apps must not ship a broken AppModule with fake Lucide imports.
 */
function removeHallucinatedNgModules(destPath) {
  const appModulePath = path.join(destPath, 'src', 'app', 'app.module.ts');
  if (fs.existsSync(appModulePath)) {
    fs.unlinkSync(appModulePath);
    console.warn('[postprocess] Removed hallucinated app.module.ts (standalone bootstrap is used).');
  }
  // Also drop any NgModule files that only wrap LucideIcon
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.module.ts'))) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (/@NgModule/.test(content) && /LucideIcon/.test(content) && !/bootstrap\s*:/.test(content)) {
        fs.unlinkSync(file);
        console.warn(`[postprocess] Removed hallucinated module: ${path.relative(destPath, file)}`);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rewrite relative imports that point at missing paths by resolving the symbol to a real component file.
 */
function fixBrokenRelativeComponentImports(destPath) {
  const srcRoot = path.join(destPath, 'src');
  const byClass = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts') || n.endsWith('.ts'))) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      for (const m of content.matchAll(/export\s+class\s+(\w+)/g)) {
        byClass.set(m[1], file);
      }
    } catch {
      /* ignore */
    }
  }

  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.ts'))) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;

    content = content.replace(
      /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]\s*;?/g,
      (full, names, fromPath) => {
        const resolved = path.resolve(path.dirname(file), fromPath);
        const candidates = [`${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts'), resolved];
        if (candidates.some((c) => fs.existsSync(c))) return full;

        const symbols = names.split(',').map((s) => s.trim()).filter(Boolean);
        const lines = [];
        for (const sym of symbols) {
          const bare = sym.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          const target = byClass.get(bare);
          if (!target) {
            lines.push(`import { ${sym} } from '${fromPath}';`);
            continue;
          }
          let rel = path.relative(path.dirname(file), target).replace(/\\/g, '/');
          if (!rel.startsWith('.')) rel = `./${rel}`;
          rel = rel.replace(/\.ts$/, '');
          lines.push(`import { ${bare} } from '${rel}';`);
        }
        return lines.join('\n');
      }
    );

    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
      console.warn(`[postprocess] Rewrote broken relative imports in ${path.relative(destPath, file)}`);
    }
  }
}

function ensureCnUtil(destPath) {
  const utilsPath = path.join(destPath, 'src', 'lib', 'utils.ts');
  if (fs.existsSync(utilsPath)) return;
  ensureDirectoryExists(path.dirname(utilsPath));
  fs.writeFileSync(
    utilsPath,
    `import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`,
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// React repair
// ---------------------------------------------------------------------------

function addReactPathAliases(destPath) {
  const tsconfigPath = path.join(destPath, 'tsconfig.json');
  const tsconfig = readJsonSafe(tsconfigPath) || {};
  tsconfig.compilerOptions = tsconfig.compilerOptions || {};
  tsconfig.compilerOptions.baseUrl = '.';
  tsconfig.compilerOptions.paths = {
    ...(tsconfig.compilerOptions.paths || {}),
    '@/*': ['src/*']
  };
  writeJson(tsconfigPath, tsconfig);

  const vitePath = path.join(destPath, 'vite.config.ts');
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 3000,
    open: true
  }
});
`;
  fs.writeFileSync(vitePath, viteConfig, 'utf-8');
}

function repairReactSourceFiles(destPath) {
  const files = walkFiles(path.join(destPath, 'src'), (name) =>
    name.endsWith('.tsx') || name.endsWith('.ts') || name.endsWith('.jsx') || name.endsWith('.js')
  );

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;

    content = content.replace(/from\s*['"]lucide-angular['"]/g, "from 'lucide-react'");
    content = content.replace(/from\s*['"]@lucide\/angular['"]/g, "from 'lucide-react'");
    content = content.replace(/from\s*['"]@angular\/core['"]/g, "from 'react'");
    // Angular leftover selectors / templateUrl should not remain
    content = content.replace(/templateUrl\s*:\s*['"][^'"]+['"]\s*,?/g, '');
    content = content.replace(/styleUrl\s*:\s*['"][^'"]+['"]\s*,?/g, '');

    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
  }
}

/**
 * Full React workspace repair after AI generation.
 */
export function repairReactWorkspace(destPath, options = {}) {
  const { sourcePackageJson = null } = options;

  addReactPathAliases(destPath);
  mergePackageDependencies(destPath, sourcePackageJson, 'react');
  repairReactSourceFiles(destPath);

  // Ensure App.tsx + main.tsx exist (caller also runs ensureReactRuntimeFiles)
  const appPath = path.join(destPath, 'src', 'App.tsx');
  if (!fs.existsSync(appPath)) {
    const alt = walkFiles(path.join(destPath, 'src'), (n) => /^app\.(tsx|jsx)$/i.test(n))[0];
    if (alt) fs.copyFileSync(alt, appPath);
  }
}

export {
  repairAngularComponentFile,
  ensureImport,
  ensureDecoratorImport,
  stripCssLeakedIntoTs,
  componentClassNameFromFile,
  mergePackageDependencies,
  addAngularPathAliases,
  addReactPathAliases
};
