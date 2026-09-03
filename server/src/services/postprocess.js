import fs from 'fs';
import path from 'path';
import { ensureDirectoryExists } from '../utils/file.js';
import {
  buildInlineLucideSvg,
  rewriteHtmlLucideToInlineSvg,
  stripLucidePackageUsage,
  normalizeLucideSlug,
  resolveLucidePascalName
} from './lucideInlineSvg.js';
import { WEB_ANGULAR_PATH_ALIASES, webAngularNpmDeps } from '../config/webAngular.js';

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

function kebabStemFromPath(filePath) {
  const base = path.posix
    .basename(String(filePath || '').replace(/\\/g, '/'))
    .replace(/\.(component\.)?(ts|tsx|js|jsx|html|scss|css)$/i, '')
    .replace(/\.component$/i, '');
  return (
    base
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || ''
  );
}

/**
 * True when an HTML file is a postprocess/AI stub, not a real UI.
 */
export function isPlaceholderTemplate(filePath, content) {
  if (!/\.html$/i.test(String(filePath || ''))) return false;
  const text = String(content || '').trim();
  if (!text) return true;
  if (text.length < 400 && /placeholder/i.test(text)) return true;
  if (/^<p>\s*\w*Component\s*(placeholder)?\s*<\/p>$/i.test(text)) return true;
  if (/^<div class="[^"]*"><\/div>$/i.test(text) && text.length < 80) return true;
  return false;
}

function findMatchingSourceContent(angularTsPath, destPath, sourceFilesMap) {
  if (!sourceFilesMap) return '';
  const destStem = kebabStemFromPath(angularTsPath);
  if (!destStem) return '';
  let best = '';
  let bestLen = 0;
  for (const [srcRel, content] of Object.entries(sourceFilesMap)) {
    const n = String(srcRel).replace(/\\/g, '/');
    if (!/\.(tsx|jsx|ts|js)$/i.test(n)) continue;
    const srcStem = kebabStemFromPath(n);
    if (
      srcStem === destStem ||
      srcStem === destStem.replace(/^admin-/, '') ||
      `admin-${srcStem}` === destStem
    ) {
      const body = String(content || '');
      if (body.length > bestLen) {
        best = body;
        bestLen = body.length;
      }
    }
  }
  return best;
}

/**
 * Scan a converted workspace for stub/placeholder templates that must not ship.
 */
export function collectConversionDefects(destPath) {
  const placeholders = [];
  const srcRoot = path.join(destPath, 'src');
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.html'))) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (isPlaceholderTemplate(file, content)) {
      placeholders.push(path.relative(destPath, file).replace(/\\/g, '/'));
    }
  }
  return { placeholders };
}

/**
 * Source TSX/JSX UI files that should have a matching Angular component after conversion.
 */
export function collectMissingSourcePages(destPath, sourceFilesMap) {
  if (!sourceFilesMap) return [];
  const destStems = new Set();
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.component.ts'))) {
    const stem = kebabStemFromPath(file);
    if (stem) destStems.add(stem);
  }
  const missing = [];
  for (const [rel, content] of Object.entries(sourceFilesMap)) {
    const n = String(rel).replace(/\\/g, '/');
    if (!/^src\//.test(n)) continue;
    if (!/\.(tsx|jsx)$/i.test(n)) continue;
    if (/\.(spec|test)\./i.test(n)) continue;
    if (/(routeTree\.gen|vite-env\.d|__root)/.test(n)) continue;
    if (/(^|\/)(main|index|server|start)\.(tsx|jsx|ts|js)$/i.test(n)) continue;
    if (/(^|\/)(hooks|lib|utils|types)\//i.test(n)) continue;
    const isPageLike =
      /\/(pages|views|routes|screens)\//i.test(n) ||
      /(shell|layout|admin[-_])/i.test(path.posix.basename(n));
    if (!isPageLike) continue;
    const body = String(content || '');
    if (body && !/</.test(body)) continue;
    const stem = kebabStemFromPath(n);
    if (!stem || stem === 'app' || stem === 'root') continue;
    if (destStems.has(stem) || destStems.has(`admin-${stem}`) || destStems.has(stem.replace(/^admin-/, ''))) {
      continue;
    }
    missing.push(n);
  }
  return missing;
}

function ensureImport(source, symbol, fromModule) {
  const fromRe = fromModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let updated = String(source || '');

  // `import type { Symbol }` is erased — NG1010 Unknown reference in @Component({ imports }).
  const typeImportRe = new RegExp(
    `import\\s+type\\s*\\{([^}]*)\\}\\s*from\\s*['"]${fromRe}['"]\\s*;?`
  );
  if (typeImportRe.test(updated)) {
    updated = updated.replace(typeImportRe, (full, names) => {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
      const has = parts.some(
        (n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() === symbol
      );
      if (!has) return full;
      const remaining = parts.filter(
        (n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() !== symbol
      );
      const lines = [];
      if (remaining.length) {
        lines.push(`import type { ${remaining.join(', ')} } from '${fromModule}';`);
      }
      lines.push(`import { ${symbol} } from '${fromModule}';`);
      return lines.join('\n');
    });
  }

  const existingRe = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${fromRe}['"]\\s*;?`,
    'g'
  );

  let symbolPresent = false;
  updated = updated.replace(existingRe, (full, names) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
    const bareNames = parts.map((n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
    if (bareNames.includes(symbol)) {
      symbolPresent = true;
      // Promote `import { type Symbol }` to a value import
      const next = parts.map((n) => {
        const bare = n.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        return bare === symbol ? n.replace(/^type\s+/, '') : n;
      });
      return `import { ${next.join(', ')} } from '${fromModule}';`;
    }
    if (symbolPresent) return full;
    symbolPresent = true;
    return `import { ${parts.concat(symbol).join(', ')} } from '${fromModule}';`;
  });

  if (symbolPresent) return dedupeImports(updated);

  const line = `import { ${symbol} } from '${fromModule}';`;
  const lastImport = [...updated.matchAll(/^import\s.+from\s*['"][^'"]+['"]\s*;?\s*$/gm)].pop();
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

/** Collapse duplicate import lines and merge named imports from the same module. */
function dedupeImports(source) {
  const lines = source.split('\n');
  const namedByModule = new Map(); // module → { indices: number[], symbols: string[] }
  const keep = lines.map(() => true);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/);
    if (!m) continue;
    const mod = m[2];
    const symbols = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!namedByModule.has(mod)) namedByModule.set(mod, { indices: [], symbols: [] });
    const entry = namedByModule.get(mod);
    entry.indices.push(i);
    for (const sym of symbols) {
      const bare = sym.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (!entry.symbols.some((s) => s.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() === bare)) {
        entry.symbols.push(sym);
      }
    }
  }

  for (const [mod, entry] of namedByModule) {
    if (entry.indices.length === 0) continue;
    const [first, ...rest] = entry.indices;
    lines[first] = `import { ${entry.symbols.join(', ')} } from '${mod}';`;
    for (const idx of rest) keep[idx] = false;
  }

  const seenExact = new Set();
  return lines
    .filter((line, i) => {
      if (!keep[i]) return false;
      const trimmed = line.trim();
      if (!trimmed.startsWith('import ')) return true;
      if (seenExact.has(trimmed)) return false;
      seenExact.add(trimmed);
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

function removeDecoratorImport(source, symbol) {
  if (!/@Component\s*\(/.test(source)) return source;
  return source.replace(
    /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
    (full, start, mid, end) => {
      const items = mid
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((item) => {
          const bare = item.split(/\s+as\s+/)[0].trim();
          return bare !== symbol;
        });
      return `${start}${items.join(', ')}${end}`;
    }
  );
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
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Must detect `@Input() foo!`, `foo = input()`, methods, and fields.
  // The definite-assignment `!` previously caused false misses → duplicate stubs.
  const re = new RegExp(
    [
      `@(?:Input|Output)\\s*\\([^)]*\\)\\s*(?:readonly\\s+)?${esc}\\b`,
      `(?:readonly\\s+)?${esc}\\s*=\\s*(?:input|output|model)\\s*(?:<[^>]*>)?\\s*\\(`,
      `\\b(?:(?:public|protected|private|readonly)\\s+)*${esc}\\s*!\\s*[=:]`,
      `\\b(?:(?:public|protected|private|readonly)\\s+)*${esc}\\s*[=:(]`,
      `\\bget\\s+${esc}\\s*\\(`,
      `\\b${esc}\\s*\\(`
    ].join('|')
  );
  return re.test(source);
}

function findMatchingBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function removeNamedClassMethods(source, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return source;
  const re = new RegExp(
    `(^|\\n)([ \\t]*(?:public|protected|private|override|async\\s+)*${esc}\\s*\\([^;{]*\\)\\s*(?::[^{]+)?\\{)`,
    'g'
  );
  const cuts = [];
  let m;
  while ((m = re.exec(source))) {
    const open = m.index + m[1].length + m[2].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) continue;
    cuts.push({ start: m.index + m[1].length, end: close + 1 });
  }
  if (!cuts.length) return source;
  let out = source;
  for (const cut of cuts.reverse()) {
    out = `${out.slice(0, cut.start)}${out.slice(cut.end)}`;
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Remove heuristic stubs that collide with real @Input/@Output/input()/output() members.
 * Typical failure: stub `onClick(..._args)` + `@Input() onClick!` → TS2300 / TS2717.
 * Also drop real methods that reuse an @Output name (`onClose` Output + `onClose()` method).
 */
function dedupeStubbedClassMembers(source) {
  const names = new Set();
  for (const m of source.matchAll(/@(?:Input|Output)\s*\([^)]*\)\s*(?:readonly\s+)?(\w+)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/(?:readonly\s+)?(\w+)\s*=\s*(?:input|output|model)\s*(?:<[^>]*>)?\s*\(/g)) {
    names.add(m[1]);
  }
  if (!names.size) return source;

  let updated = source;
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    updated = removeNamedClassMethods(updated, name);
    // Drop simple field stubs (not @Input/@Output lines)
    updated = updated.replace(
      new RegExp(
        `^[ \\t]*(?:public|protected|private|readonly\\s+)*${esc}\\s*!?:\\s*[^=;\\n]+?=\\s*(?:null|false|''|""|\\[\\])\\s*;\\s*\\n?`,
        'gm'
      ),
      ''
    );
  }
  return updated;
}

function rewriteBareOutputCallsToEmit(html, source) {
  let out = String(html || '');
  const names = new Set();
  for (const m of String(source || '').matchAll(/@Output\s*\([^)]*\)\s*(?:readonly\s+)?(\w+)/g)) {
    names.add(m[1]);
  }
  for (const m of String(source || '').matchAll(/(?:readonly\s+)?(\w+)\s*=\s*output\s*(?:<[^>]*>)?\s*\(/g)) {
    names.add(m[1]);
  }
  for (const name of names) {
    if (classHasMethod(source, name)) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}(?!\\.emit)\\s*\\(`, 'g'), `${name}.emit(`);
  }
  return out;
}

/**
 * Fix `prop: string = null` / `prop: number = null` (strictNullChecks).
 */
function repairNullAssignedPrimitives(source) {
  return source.replace(
    /(^\s*(?:public|protected|private|readonly\s+)*(?:@Input\(\)\s*)?)(\w+)(\s*!?:\s*)(string|number|boolean)(\s*=\s*null\s*;)/gm,
    '$1$2$3$4 | null$5'
  );
}

/**
 * Map legacy/AI lucide tag slugs to real Lucide icon slugs (kebab-case).
 * AI often emits <lucide-logout> instead of log-out.
 */
function lucideSlugToSymbolAndAttr(rawSlug) {
  const slug = normalizeLucideSlug(rawSlug);
  const pascal = resolveLucidePascalName(slug);
  return {
    slug,
    symbol: `Lucide${pascal}`,
    attr: `lucide${pascal}`
  };
}

/**
 * Rewrite ALL Lucide / React-icon leftovers into plain inline <svg> markup.
 * Never emit @lucide/angular directives.
 * Pass React source as extraSource so leftover <Plus /> tags convert even when
 * the Angular TS file never imported lucide.
 */
function rewriteLegacyLucideHtmlTags(html, source = '', extraSource = '') {
  const combined = extraSource ? `${source}\n${extraSource}` : source;
  return rewriteHtmlLucideToInlineSvg(html, combined);
}

function normalizeLucideSvgAttrs(attrs) {
  return String(attrs || '')
    .replace(/\/\s*$/, '')
    .trim()
    .replace(/\bclassName\s*=/g, 'class=')
    .replace(/\b\[className\]\s*=/g, '[class]=');
}

/**
 * @deprecated — Angular output must not use @lucide/angular. Kept as no-op strip.
 */
function renameLucideReactSymbolsToAngular(source) {
  return stripLucidePackageUsage(source);
}

/**
 * Strip Lucide package usage; icons are inlined as real SVG in templates.
 */
function syncLucideImportsFromTemplate(source, html) {
  void html;
  return stripLucidePackageUsage(source);
}

/**
 * Remove any remaining Lucide module / package imports from the component.
 */
function repairLucideAngularImports(source) {
  return stripLucidePackageUsage(source);
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
    // Heuristic stubs — methods/helpers BEFORE plural-array heuristic (initials ends with s)
    if (/^(is|has|show|hide|can|should|creating|editing|loading|open|disabled)/i.test(name) ||
        name.endsWith('Count') ||
        name === 'q') {
      snippets.push(`  ${name}: any = ${name === 'q' ? "''" : 'false'};`);
    } else if (/^(on|handle|toggle|create|edit|save|cancel|submit|delete|remove|add|close|open|select|scroll|set|count)/i.test(name) ||
               /For$|Date$|Of$/.test(name) ||
               name === 'initials') {
      snippets.push(`  ${name}(..._args: any[]) { return _args[0] ?? null; }`);
    } else if (/List|Items|Users|Options|Rows/i.test(name) ||
               (/s$/.test(name) && !/ss$|us$|is$|status$/i.test(name))) {
      snippets.push(`  ${name}: any[] = [];`);
    } else {
      snippets.push(`  ${name}: any = null;`);
    }
  }

  if (!snippets.length) return source;
  return insertIntoClassBody(source, snippets.join('\n'));
}

function uncapitalizeIdent(name) {
  const s = String(name || '');
  if (!s) return '';
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function isHeuristicStubBody(body, signature = '') {
  const t = String(body || '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (!t) return true;
  if (/^return;?$/.test(t)) return true;
  if (/return\s+_args\b/.test(t)) return true;
  if (/\.\.\._args/.test(signature) && t.length < 80) return true;
  if (/^throw new Error/.test(t)) return true;
  if (/not implemented|TODO|FIXME/i.test(t) && t.length < 80) return true;
  return t.length < 6;
}

function extractNamedMethod(source, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return null;
  const re = new RegExp(
    `(^|\\n)([ \\t]*(?:public|protected|private|override|async\\s+)*${esc}\\s*\\(([^;{]*)\\)\\s*(?::[^{]+)?\\{)`
  );
  const m = re.exec(source);
  if (!m) return null;
  const open = m.index + m[1].length + m[2].length - 1;
  const close = findMatchingBrace(source, open);
  if (close < 0) return null;
  return {
    name,
    signature: m[3] || '',
    body: source.slice(open + 1, close),
    start: m.index + m[1].length,
    end: close + 1
  };
}

function handlerCandidates(name) {
  const n = String(name || '');
  const out = [];
  const handle = n.match(/^handle([A-Z]\w+)$/);
  if (handle) {
    out.push(`on${handle[1]}`, uncapitalizeIdent(handle[1]));
  }
  const on = n.match(/^on([A-Z]\w+)$/);
  if (on) out.push(uncapitalizeIdent(on[1]));
  return out;
}

function fieldFromValueHandler(name) {
  const n = String(name || '');
  let m = n.match(/^(?:on|handle)([A-Z]\w+?)(?:Input|Change)$/);
  if (m) return uncapitalizeIdent(m[1]);
  m = n.match(/^set([A-Z]\w+)$/);
  if (m) return uncapitalizeIdent(m[1]);
  return '';
}

function fieldFromBlurHandler(name) {
  const m = String(name || '').match(/^(?:on|handle)([A-Z]\w+)Blur$/);
  return m ? uncapitalizeIdent(m[1]) : '';
}

/**
 * AI templates often call handleCancel / onTitleInput stubs while the class
 * already has onCancel() and form fields. Retarget bindings and always wire
 * controls with Reactive Forms ([formGroup] + formControlName), never ngModel.
 */
export function repairInferredTemplateHandlers(source, html) {
  let src = String(source || '');
  let out = String(html || '');
  if (!src || !out) return { source: src, html: out };

  const replaceHandlerCall = (from, to) => {
    if (!from || from === to) return;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}\\s*\\(`, 'g'), `${to}(`);
  };

  for (const m of out.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const handler = m[1];
    const method = extractNamedMethod(src, handler);
    const missing = !method && !classHasOutput(src, handler) && !classHasMember(src, handler);
    const stub = method && isHeuristicStubBody(method.body, method.signature);
    if (!missing && !stub) continue;
    for (const candidate of handlerCandidates(handler)) {
      const candMethod = extractNamedMethod(src, candidate);
      if (candMethod && !isHeuristicStubBody(candMethod.body, candMethod.signature)) {
        replaceHandlerCall(handler, candidate);
        break;
      }
      if (classHasOutput(src, candidate)) {
        replaceHandlerCall(handler, `${candidate}.emit`);
        break;
      }
    }
  }

  out = out.replace(
    /\((input|change|ngModelChange|selectionChange|blur)\)="\s*([A-Za-z_]\w*)\s*\((\$event)?\)\s*"/g,
    (full, evt, handler) => {
      const method = extractNamedMethod(src, handler);
      const stub = !method || isHeuristicStubBody(method.body, method.signature);
      if (!stub) return full;
      if (evt === 'blur') {
        const field = fieldFromBlurHandler(handler);
        if (field && (classHasMember(src, `${field}Touched`) || /\bform\b/.test(src))) {
          return `(blur)="form.controls['${field}'].markAsTouched()"`;
        }
      }
      return full;
    }
  );

  const upgradeToFormControl = (attrs, field) => {
    let next = String(attrs || '')
      .replace(/\s*\[value\]="[^"]*"/g, '')
      .replace(/\s*\[\(ngModel\)\]="[^"]*"/g, '')
      .replace(/\s*\[ngModel\]="[^"]*"/g, '')
      .replace(/\s*\(input\)="[^"]*"/g, '')
      .replace(/\s*\(change\)="[^"]*"/g, '')
      .replace(/\s*\(ngModelChange\)="[^"]*"/g, '')
      .replace(/\s*\(selectionChange\)="[^"]*"/g, '')
      .replace(new RegExp(`\\s*name="\\s*${field}\\s*"`, 'g'), '')
      .replace(/\s*formControlName="[^"]*"/g, '');
    next += ` formControlName="${field}"`;
    return next;
  };

  const boundFields = new Set();
  for (const m of out.matchAll(/\[value\]="\s*(\w+)\s*"/g)) boundFields.add(m[1]);
  for (const m of out.matchAll(/\[\(ngModel\)\]="\s*(\w+)\s*"/g)) boundFields.add(m[1]);
  for (const m of out.matchAll(/formControlName="\s*(\w+)\s*"/g)) boundFields.add(m[1]);
  const fields = [...boundFields].filter(
    (name) =>
      name &&
      !/Touched$|Error$|^open$/i.test(name) &&
      (classHasMember(src, name) || /formControlName=/.test(out) || /\[value\]=/.test(out))
  );

  if (/<form\b/i.test(out) && fields.length) {
    const hasForm =
      /\breadonly form\b/.test(src) ||
      (/\bform\s*[!=:]/.test(src) && /FormGroup|FormBuilder|fb\./.test(src));
    if (!hasForm) {
      src = ensureImport(src, 'inject', '@angular/core');
      src = ensureImport(src, 'FormBuilder', '@angular/forms');
      const group = fields
        .map((name) => {
          const initMatch = src.match(
            new RegExp(
              `^[\\t ]*(?:public|protected|private|readonly\\s+)*${name}\\s*(?:!\\s*)?:[^=\\n]*=\\s*([^;]+);`,
              'm'
            )
          );
          let init = (initMatch?.[1] || "''").trim();
          if (init === 'null' || init === 'undefined') init = "''";
          return `    ${name}: [${init}]`;
        })
        .join(',\n');
      const resetBody = fields
        .map((name) => {
          const initMatch = src.match(
            new RegExp(
              `^[\\t ]*(?:public|protected|private|readonly\\s+)*${name}\\s*(?:!\\s*)?:[^=\\n]*=\\s*([^;]+);`,
              'm'
            )
          );
          let init = (initMatch?.[1] || "''").trim();
          if (init === 'null' || init === 'undefined') init = "''";
          return `      ${name}: ${init}`;
        })
        .join(',\n');
      src = insertIntoClassBody(
        src,
        `  private readonly fb = inject(FormBuilder);\n  readonly form = this.fb.nonNullable.group({\n${group}\n  });\n  resetForm(): void {\n    this.form.reset({\n${resetBody}\n    });\n  }`
      );
      for (const name of fields) {
        src = src.replace(
          new RegExp(
            `^[ \\t]*(?:public|protected|private|readonly\\s+)*${name}\\s*(?:!\\s*)?:[^;\\n]+;\\s*\\n?`,
            'gm'
          ),
          ''
        );
        src = src.replace(
          new RegExp(
            `^[ \\t]*(?:public|protected|private|readonly\\s+)*${name}Touched\\s*(?:!\\s*)?:[^;\\n]+;\\s*\\n?`,
            'gm'
          ),
          ''
        );
      }
    } else if (!/\bresetForm\s*\(/.test(src)) {
      const resetBody = fields.map((name) => `      ${name}: ''`).join(',\n');
      src = insertIntoClassBody(
        src,
        `  resetForm(): void {\n    this.form.reset({\n${resetBody}\n    });\n  }`
      );
    }

    out = out.replace(/<form\b([^>]*)>/i, (full, attrs) => {
      let a = String(attrs || '').replace(/\s*\[formGroup\]="[^"]*"/g, '');
      a += ' [formGroup]="form"';
      return `<form${a}>`;
    });

    out = out.replace(
      /<(input|textarea|select)\b([^>]*?)\s*(\/?)>/gi,
      (full, tag, attrs, slash) => {
        const valueField =
          attrs.match(/\[value\]="\s*(\w+)\s*"/)?.[1] ||
          attrs.match(/\[\(ngModel\)\]="\s*(\w+)\s*"/)?.[1] ||
          attrs.match(/formControlName="\s*(\w+)\s*"/)?.[1];
        if (!valueField || !fields.includes(valueField)) return full;
        const close = slash ? ' /' : '';
        return `<${tag}${upgradeToFormControl(attrs, valueField)}${close}>`;
      }
    );
    out = out.replace(/<mat-select\b([^>]*?)>/gi, (full, attrs) => {
      const valueField =
        attrs.match(/\[value\]="\s*(\w+)\s*"/)?.[1] ||
        attrs.match(/\[\(ngModel\)\]="\s*(\w+)\s*"/)?.[1] ||
        attrs.match(/formControlName="\s*(\w+)\s*"/)?.[1];
      if (!valueField || !fields.includes(valueField)) return full;
      return `<mat-select${upgradeToFormControl(attrs, valueField)}>`;
    });
    out = out.replace(
      /\(blur\)="(\w+)Touched\s*=\s*true"/g,
      (_, field) => `(blur)="form.controls['${field}'].markAsTouched()"`
    );

    src = ensureImport(src, 'ReactiveFormsModule', '@angular/forms');
    src = ensureDecoratorImport(src, 'ReactiveFormsModule');
    src = removeNamedImport(src, 'FormsModule', '@angular/forms');
    src = removeDecoratorImport(src, 'FormsModule');
    // Must not match the FormsModule suffix of ReactiveFormsModule
    src = src.replace(/(?<![A-Za-z0-9_]),?\s*FormsModule\b/g, '');
    src = src.replace(/imports\s*:\s*\[\s*,/g, 'imports: [');
    src = src.replace(/,\s*\]/g, ']');
  }

  out = out.replace(/\[\(ngModel\)\]="[^"]*"/g, '');
  out = out.replace(/\[ngModel\]="[^"]*"/g, '');

  out = out.replace(/<form\b([^>]*?)>/gi, (full, attrs) => {
    if (!/\(ngSubmit\)=/.test(attrs)) return full;
    const next = attrs.replace(/\s*\(submit\)="[^"]*"/g, '');
    return `<form${next}>`;
  });

  for (const m of src.matchAll(
    /^[ \t]*(?:public|protected|private|readonly\s+)*(\w+)Error\s*(?:!\s*)?:\s*any\s*=\s*(?:null|false)\s*;\s*$/gm
  )) {
    const base = m[1];
    if (new RegExp(`\\bget\\s+${base}Error\\s*\\(`).test(src)) continue;
    src = src.replace(m[0], '');
    if (/\breadonly form\b|\bform\s*=/.test(src)) {
      src = insertIntoClassBody(
        src,
        `  get ${base}Error(): boolean {\n    const c = this.form.controls['${base}'];\n    return !!(c && c.touched && String(c.value ?? '').trim() === '');\n  }`
      );
    } else if (classHasMember(src, base) && classHasMember(src, `${base}Touched`)) {
      src = insertIntoClassBody(
        src,
        `  get ${base}Error(): boolean {\n    return this.${base}Touched && String(this.${base} ?? '').trim() === '';\n  }`
      );
    }
  }

  if (/\[formGroup\]|formControlName=/.test(out)) {
    src = ensureImport(src, 'ReactiveFormsModule', '@angular/forms');
    src = ensureDecoratorImport(src, 'ReactiveFormsModule');
  }

  for (const m of [...src.matchAll(
    /(?:^|\n)[ \t]*(?:public|protected|private|override|async\s+)*([A-Za-z_]\w*)\s*\(([^;{]*)\)\s*(?::[^{]+)?\{/g
  )]) {
    const name = m[1];
    const method = extractNamedMethod(src, name);
    if (!method || !isHeuristicStubBody(method.body, method.signature)) continue;
    if (new RegExp(`\\b${name}\\s*\\(`).test(out)) continue;
    src = removeNamedClassMethods(src, name);
  }

  return { source: src, html: out };
}

/**
 * Import standalone child components referenced as custom elements in the template.
 * Also rewrites mismatched tags (admin-shell → app-admin-shell) to the real selector.
 * @returns {{ source: string, html: string }}
 */
function syncAppChildComponentImports(source, html, tsPath, srcRoot) {
  const VOID_OR_BUILTIN = new Set([
    'ng-container', 'ng-content', 'ng-template', 'router-outlet', 'router-link'
  ]);
  const tags = [...html.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((t) => !VOID_OR_BUILTIN.has(t) && !t.startsWith('svg:'));

  if (!tags.length) return { source, html };

  const bySelector = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts') || n.endsWith('.page.ts'))) {
    if (path.resolve(file) === path.resolve(tsPath)) continue;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (!/@Component\s*\(/.test(content)) continue;
      const sel = content.match(/selector\s*:\s*['"]([^'"]+)['"]/);
      const cls = content.match(/export\s+class\s+(\w+)/);
      if (sel && cls) bySelector.set(sel[1].toLowerCase(), { file, className: cls[1], selector: sel[1] });
    } catch {
      /* ignore */
    }
  }

  let updated = source;
  let updatedHtml = html;

  const resolveHit = (tag) => {
    if (bySelector.has(tag)) return bySelector.get(tag);
    if (bySelector.has(`app-${tag}`)) return bySelector.get(`app-${tag}`);
    for (const [sel, hit] of bySelector) {
      if (sel.endsWith(`-${tag}`) || sel === tag || sel.endsWith(tag)) return hit;
    }
    return null;
  };

  for (const tag of new Set(tags)) {
    const hit = resolveHit(tag);
    if (!hit) continue;

    // Align template tag with the component's declared selector
    if (hit.selector.toLowerCase() !== tag) {
      const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      updatedHtml = updatedHtml
        .replace(new RegExp(`<${esc}\\b`, 'gi'), `<${hit.selector}`)
        .replace(new RegExp(`</${esc}>`, 'gi'), `</${hit.selector}>`);
    }

    if (
      new RegExp(`\\b${hit.className}\\b`).test(updated) &&
      new RegExp(`imports\\s*:\\s*\\[[^\\]]*\\b${hit.className}\\b`).test(updated)
    ) {
      continue;
    }
    let rel = path.relative(path.dirname(tsPath), hit.file).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    rel = rel.replace(/\.ts$/, '');
    updated = ensureImport(updated, hit.className, rel);
    updated = ensureDecoratorImport(updated, hit.className);
  }
  return { source: updated, html: updatedHtml };
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

const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);

function stripVoidElementEndTags(html) {
  let out = String(html || '');
  for (const tag of HTML_VOID_TAGS) {
    out = out.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '');
  }
  return out;
}

/**
 * Angular forbids `<button ... />` when a matching `</button>` still follows
 * (NG5002 Unexpected closing tag). Common after IconButton → mat-icon-button.
 * Also strips illegal end tags on void elements (`</input>` → NG5002).
 */
export function repairSelfClosingNonVoidTags(html) {
  let out = stripVoidElementEndTags(html);
  const re = /<([A-Za-z][\w-]*)(\s[^>]*?)?\s*\/>/g;
  const replacements = [];
  let m;
  while ((m = re.exec(out))) {
    const tag = m[1];
    const name = tag.toLowerCase();
    const attrs = m[2] || '';
    if (HTML_VOID_TAGS.has(name)) continue;
    const after = out.slice(m.index + m[0].length);
    const lead = (after.match(/^\s*/) || [''])[0].length;
    const next = after.slice(lead);
    const closeRe = new RegExp(`^</${tag}>`, 'i');
    const openRe = new RegExp(`^<${tag}\\b`, 'i');
    if (closeRe.test(next)) {
      replacements.push({
        start: m.index,
        end: m.index + m[0].length,
        text: `<${tag}${attrs}>`
      });
      continue;
    }
    if (openRe.test(next)) {
      if (!name.includes('-') && !name.startsWith('ng')) {
        replacements.push({
          start: m.index,
          end: m.index + m[0].length,
          text: `<${tag}${attrs}></${tag}>`
        });
      }
      continue;
    }
    const closeAt = after.search(new RegExp(`</${tag}>`, 'i'));
    const nextOpenAt = after.search(new RegExp(`<${tag}\\b`, 'i'));
    if (closeAt >= 0 && (nextOpenAt < 0 || closeAt < nextOpenAt)) {
      replacements.push({
        start: m.index,
        end: m.index + m[0].length,
        text: `<${tag}${attrs}>`
      });
    } else if (!name.includes('-') && !name.startsWith('ng')) {
      replacements.push({
        start: m.index,
        end: m.index + m[0].length,
        text: `<${tag}${attrs}></${tag}>`
      });
    }
  }
  for (const r of replacements.reverse()) {
    out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`;
  }
  return out;
}

/**
 * Repair Angular HTML leftovers that commonly break ng serve after React conversions.
 */
function repairAngularTemplateHtml(html, source) {
  let updated = repairSelfClosingNonVoidTags(html);

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

  // TypeScript casts are illegal in Angular templates → $any(...)
  // Only rewrite parenthesized `as` casts (not microsyntax like `obs as value`)
  updated = updated.replace(
    /\(\s*\$event\.target\s+as\s+\w+\s*\)\.(\w+)/g,
    '$any($event.target).$1'
  );
  updated = updated.replace(
    /\(\s*\$event\.target\s+as\s+\w+\s*\)/g,
    '$any($event.target)'
  );
  updated = updated.replace(
    /\(\s*(\$event(?:\.\w+)*)\s+as\s+\w+\s*\)/g,
    '$any($1)'
  );

  // Lucide attr leaked into [class] string: "...foreground' lucideUserCog"
  updated = updated.replace(
    /(\[(?:class|ngClass)\]="[^"]*?)\s+lucide[A-Z][A-Za-z0-9]*(\s*")/g,
    '$1$2'
  );
  updated = updated.replace(
    /(\[(?:class|ngClass)\]='[^']*?)\s+lucide[A-Z][A-Za-z0-9]*(\s*')/g,
    '$1$2'
  );

  // Wrong dynamic binding [lucide]="..." → real inline SVG when resolvable
  updated = updated.replace(
    /<svg([^>]*)\s\[lucide(?:Icon)?\]="([^"]*)"([^>]*)>([\s\S]*?)<\/svg>/gi,
    (_full, pre, expr, post) => {
      const staticOne = expr.match(/^\s*'([A-Za-z0-9-]+)'\s*$/);
      const ternarySame = expr.match(/^\s*[^?]+\?\s*'([A-Za-z0-9-]+)'\s*:\s*'([A-Za-z0-9-]+)'\s*$/);
      if (staticOne) return buildInlineLucideSvg(staticOne[1], `${pre} ${post}`);
      if (ternarySame && ternarySame[1].toLowerCase() === ternarySame[2].toLowerCase()) {
        return buildInlineLucideSvg(ternarySame[1], `${pre} ${post}`);
      }
      // Truly dynamic — fall back to a neutral circle SVG (no lucide package)
      return buildInlineLucideSvg('circle', `${pre} ${post}`);
    }
  );

  // Arrow functions illegal in templates — common .filter(u => u.prop).length
  updated = updated.replace(
    /\{\{\s*([^}]*?)\.filter\s*\(\s*(\w+)\s*=>\s*\!?\s*\2\.(\w+)\s*\)\.length\s*\}\}/g,
    (_full, arr, _v, prop) => `{{ countWhere(${arr.trim()}, '${prop}') }}`
  );
  updated = updated.replace(
    /\{\{\s*([^}]*?)\.length\s*-\s*([^}]*?)\.filter\s*\(\s*(\w+)\s*=>\s*\!?\s*\3\.(\w+)\s*\)\.length\s*\}\}/g,
    (_full, left, right, _v, prop) =>
      `{{ (${left.trim()}.length || 0) - countWhere(${right.trim()}, '${prop}') }}`
  );

  // Any remaining => in bindings → wrap into a no-op safe form by stripping arrow bodies
  // (best-effort; complex cases need class methods)
  updated = updated.replace(
    /(\[[\w.-]+\]|\([\w.-]+\))="([^"]*=>[^"]*)"/g,
    (full, bind, expr) => {
      if (!/=>/.test(expr)) return full;
      // Drop arrow callbacks inside bindings — leave a stub call if possible
      const cleaned = expr.replace(/\([^)]*\)\s*=>\s*[^,;)]+/g, 'true').trim();
      return `${bind}="${cleaned}"`;
    }
  );

  return updated;
}

/**
 * Remove non-declarables (e.g. cn helper) from @Component imports arrays.
 */
function sanitizeStandaloneImports(source) {
  if (!/@Component\s*\(/.test(source)) return source;

  const bannedExact = new Set([
    'cn', 'clsx', 'twMerge', 'cva', 'classNames', 'classnames', 'React', 'Fragment', 'Reactive'
  ]);

  return source.replace(
    /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
    (full, start, mid, end) => {
      const items = mid
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((item) => {
          const bare = item.split(/\s+as\s+/)[0].trim();
          if (bannedExact.has(bare)) return false;
          // Lowercase identifiers are almost never Angular declarables
          if (/^[a-z]/.test(bare) && bare !== 'forwardRef') return false;
          return true;
        });
      // Dedupe
      const uniq = [...new Set(items)];
      return `${start}${uniq.join(', ')}${end}`;
    }
  );
}

/**
 * Infer the npm specifier for a standalone declarable from its name and any
 * existing import (including `import type`). Driven by Angular naming rules,
 * not a per-widget allowlist for a specific migrated app.
 */
const NG_PLATFORM_PACKAGES = {
  CommonModule: '@angular/common',
  NgIf: '@angular/common',
  NgFor: '@angular/common',
  NgForOf: '@angular/common',
  NgClass: '@angular/common',
  NgStyle: '@angular/common',
  NgSwitch: '@angular/common',
  NgTemplateOutlet: '@angular/common',
  AsyncPipe: '@angular/common',
  JsonPipe: '@angular/common',
  DatePipe: '@angular/common',
  FormsModule: '@angular/forms',
  ReactiveFormsModule: '@angular/forms',
  RouterOutlet: '@angular/router',
  RouterLink: '@angular/router',
  RouterLinkActive: '@angular/router'
};

/** Material symbols whose secondary entry is not `MatFoo` → `@angular/material/foo`. */
const MATERIAL_ENTRY_EXCEPTIONS = {
  MatNativeDateModule: '@angular/material/core',
  MatOption: '@angular/material/core',
  MatRipple: '@angular/material/core',
  MatRippleModule: '@angular/material/core',
  MatLine: '@angular/material/core'
};

function pascalToKebab(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function kebabToPascal(kebab) {
  return String(kebab || '')
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function findImportPathForSymbol(source, symbol) {
  const text = String(source || '');
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (names.includes(symbol)) return m[2];
  }
  return null;
}

function inferMaterialPackage(symbol) {
  if (MATERIAL_ENTRY_EXCEPTIONS[symbol]) return MATERIAL_ENTRY_EXCEPTIONS[symbol];
  if (!/^Mat[A-Z]/.test(symbol)) return null;
  let rest = symbol.replace(/^Mat/, '').replace(/Module$/, '');
  if (
    /^(Button|IconButton|FabButton|MiniFabButton|Anchor|Fab|MiniFab)$/.test(rest)
  ) {
    return '@angular/material/button';
  }
  rest = rest.replace(
    /(Container|Content|Title|Actions|Close|Header|Footer|HeaderCell|HeaderRow|FooterCell|FooterRow|Row|Cell|Group|Panel|Item|Trigger|Outlet)$/,
    ''
  );
  if (!rest) return null;
  if (/^(Chip|Chips|ChipSet|ChipList)$/.test(rest)) return '@angular/material/chips';
  if (/^(Tab|Tabs|TabGroup)$/.test(rest)) return '@angular/material/tabs';
  if (/^(Spinner|ProgressSpinner)$/.test(rest)) return '@angular/material/progress-spinner';
  if (/^(Accordion|ExpansionPanel|Expansion)$/.test(rest)) return '@angular/material/expansion';
  if (/^(Label|Hint|Error|Prefix|Suffix|FormField)$/.test(rest)) {
    return '@angular/material/form-field';
  }
  if (rest === 'RadioButton') return '@angular/material/radio';
  const kebab = pascalToKebab(rest);
  return kebab ? `@angular/material/${kebab}` : null;
}

export function inferDeclarablePackage(symbol, source = '') {
  if (!symbol || !/^[A-Z]/.test(symbol)) return null;
  const existing = findImportPathForSymbol(source, symbol);
  if (existing && !existing.startsWith('.') && existing !== '@angular/material') {
    return existing;
  }
  if (NG_PLATFORM_PACKAGES[symbol]) return NG_PLATFORM_PACKAGES[symbol];
  return inferMaterialPackage(symbol);
}

function moduleFromMatFeature(featureKebab) {
  let feature = String(featureKebab || '').toLowerCase();
  if (feature === 'icon-button' || /^(flat|raised|stroked)-button$/.test(feature)) {
    return 'MatButtonModule';
  }
  feature = feature.replace(
    /-(container|content|title|actions|close|header|footer|header-cell|header-row|footer-cell|footer-row|row|cell|group|panel|item|trigger|outlet)$/,
    ''
  );
  if (feature.endsWith('-button') && feature !== 'icon') {
    feature = feature.replace(/-button$/, '');
  }
  if (/^chip/.test(feature)) return 'MatChipsModule';
  if (/^tab/.test(feature)) return 'MatTabsModule';
  if (feature === 'spinner' || feature === 'progress-spinner') return 'MatProgressSpinnerModule';
  if (feature === 'accordion' || feature === 'expansion-panel') return 'MatExpansionModule';
  if (['label', 'hint', 'error', 'prefix', 'suffix'].includes(feature)) return 'MatFormFieldModule';
  if (feature === 'option') return 'MatSelectModule';
  const pascal = kebabToPascal(feature);
  return pascal ? `Mat${pascal}Module` : null;
}

export function declarablesNeededByHtml(html) {
  const h = String(html || '');
  const needed = [];
  const add = (sym) => {
    if (sym && !needed.includes(sym)) needed.push(sym);
  };
  for (const m of h.matchAll(/<mat-([a-z0-9-]+)/gi)) {
    add(moduleFromMatFeature(m[1]));
  }
  if (
    /\bmat-(?:flat-|raised-|stroked-|icon-)?button\b|\bmatButton\b|\bmat-fab\b|\bmat-mini-fab\b/.test(
      h
    )
  ) {
    add('MatButtonModule');
  }
  for (const m of h.matchAll(/\bmat([A-Z][A-Za-z]+)\b/g)) {
    add(`Mat${m[1]}Module`);
  }
  if (/\bngModel\b|\[\(ngModel\)\]/.test(h)) add('FormsModule');
  if (/\[formGroup\]|formControlName|\[formControl\]/.test(h)) add('ReactiveFormsModule');
  return needed;
}

function collectImportedValueNames(source) {
  const names = new Set();
  const text = String(source || '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  for (const m of text.matchAll(/import\s+(?!type\b)(?:[\w*\s,{}]+)\s+from\s*['"][^'"]+['"]/g)) {
    const stmt = m[0];
    const named = stmt.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const raw = part.trim();
        if (!raw || /^type\s+/.test(raw)) continue;
        const bits = raw.split(/\s+as\s+/);
        const ident = (bits[1] || bits[0]).trim();
        if (ident) names.add(ident);
      }
    }
    const def = stmt.match(/^import\s+(\w+)\s+from/);
    if (def) names.add(def[1]);
  }
  return names;
}

function parseDecoratorImportItems(source) {
  const m = String(source || '').match(
    /@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[([^\]]*)\]/
  );
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter((s) => s && !s.startsWith('//') && s !== 'forwardRef');
}

function rewriteMaterialBarrelImports(source) {
  return String(source || '').replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/material['"]\s*;?/g,
    (full, names) => {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return full;
      return parts
        .map((part) => {
          const bare = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          const pkg = inferDeclarablePackage(bare, '');
          if (!pkg || pkg === '@angular/material') {
            return `import { ${part} } from '@angular/material';`;
          }
          return `import { ${bare} } from '${pkg}';`;
        })
        .join('\n');
    }
  );
}

function preferImportedMaterialSymbol(source, moduleName) {
  const imported = collectImportedValueNames(source);
  if (imported.has(moduleName)) return moduleName;
  const standalone = String(moduleName).replace(/Module$/, '');
  if (standalone !== moduleName && imported.has(standalone)) return standalone;
  return moduleName;
}

/**
 * Ensure every declarable used in the template or listed in
 * `@Component({ imports })` has a value import and is present in that array.
 */
function syncNgComponentImports(source, html) {
  if (!/@Component\s*\(/.test(source)) return source;
  let updated = rewriteMaterialBarrelImports(source);
  const imported = () => collectImportedValueNames(updated);
  const local = new Set(
    [...String(updated).matchAll(/\b(?:export\s+)?class\s+(\w+)/g)].map((m) => m[1])
  );

  const fromDecorator = parseDecoratorImportItems(updated).filter(
    (name) => /^[A-Z]/.test(name) && !local.has(name)
  );
  const needed = [...declarablesNeededByHtml(html), ...fromDecorator];

  for (const raw of needed) {
    const symbol = preferImportedMaterialSymbol(updated, raw);
    const pkg = inferDeclarablePackage(symbol, updated) || inferDeclarablePackage(raw, updated);
    if (!pkg) continue;
    if (!imported().has(symbol) && !local.has(symbol)) {
      updated = ensureImport(updated, symbol, pkg);
    }
    updated = ensureDecoratorImport(updated, symbol);
    if (symbol !== raw) {
      updated = updated.replace(
        /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
        (full, start, mid, end) => {
          const items = mid.split(',').map((s) => s.trim()).filter(Boolean);
          const next = items.map((item) => (item === raw ? symbol : item));
          return `${start}${[...new Set(next)].join(', ')}${end}`;
        }
      );
    }
  }

  const stillImported = collectImportedValueNames(updated);
  updated = updated.replace(
    /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
    (full, start, mid, end) => {
      const items = mid
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((item) => {
          const bare = item.split(/\s+as\s+/)[0].trim();
          if (!/^Mat[A-Z]\w+Module$/.test(bare) && !/^Mat[A-Z]\w+$/.test(bare)) return true;
          if (inferDeclarablePackage(bare, updated)) return true;
          return stillImported.has(bare) || local.has(bare);
        });
      return `${start}${[...new Set(items)].join(', ')}${end}`;
    }
  );

  return updated;
}

/**
 * Fix bare `Reactive` left behind when FormsModule was stripped from
 * ReactiveFormsModule (TS2305 / NG1010).
 */
function repairBogusAngularFormsImports(source) {
  let updated = String(source || '');
  const hasBareReactive =
    /import\s*\{[^}]*\bReactive\b[^}]*\}\s*from\s*['"]@angular\/forms['"]/.test(updated) ||
    /imports\s*:\s*\[[^\]]*\bReactive\b/.test(updated);
  if (!hasBareReactive) return updated;

  if (/\bReactiveFormsModule\b/.test(updated)) {
    updated = removeNamedImport(updated, 'Reactive', '@angular/forms');
    updated = removeDecoratorImport(updated, 'Reactive');
  } else {
    updated = updated.replace(
      /import\s*\{([^}]*)\}\s*from\s*['"]@angular\/forms['"]\s*;?/g,
      (full, names) => {
        const parts = names
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((n) => (n === 'Reactive' ? 'ReactiveFormsModule' : n));
        return `import { ${[...new Set(parts)].join(', ')} } from '@angular/forms';`;
      }
    );
    updated = updated.replace(
      /(@Component\s*\(\s*\{[\s\S]*?\bimports\s*:\s*\[)([^\]]*)(\])/,
      (full, start, mid, end) => {
        const items = mid
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((n) => (n === 'Reactive' ? 'ReactiveFormsModule' : n));
        return `${start}${[...new Set(items)].join(', ')}${end}`;
      }
    );
  }
  return updated;
}

/**
 * Strip hallucinated React→Angular leftovers that break the compiler.
 */
function repairHallucinatedAngularApis(source) {
  let updated = source;

  // Fake @angular/core exports
  for (const sym of ['RenderFragment', 'ReactNode', 'JSX', 'PropsWithChildren', 'FC', 'FunctionComponent']) {
    updated = removeNamedImport(updated, sym, '@angular/core');
    updated = removeNamedImport(updated, sym, 'react');
  }

  // Bare `Reactive` is a common corruption of ReactiveFormsModule (FormsModule suffix strip)
  updated = repairBogusAngularFormsImports(updated);

  // Input used as a generic type (React children leftover): actions: Input<X> = () => null
  updated = updated.replace(
    /(^\s*)(?:public\s+|protected\s+|private\s+|readonly\s+)*(\w+)\s*:\s*Input\s*<[^>;]+>\s*=\s*\(\)\s*=>\s*null\s*;/gm,
    '$1@Input() $2: any = null;'
  );
  updated = updated.replace(
    /(^\s*)(?:public\s+|protected\s+|private\s+|readonly\s+)*(\w+)\s*:\s*Input\s*<[^>;]+>\s*;/gm,
    '$1@Input() $2: any;'
  );
  if (/@Input\s*\(/.test(updated)) {
    updated = ensureImport(updated, 'Input', '@angular/core');
  }

  // IconDefinition does not exist — neutralize
  updated = updated.replace(/new\s+IconDefinition\s*\([^)]*\)/g, 'null as any');
  updated = updated.replace(/:\s*IconDefinition\b/g, ': any');
  updated = removeNamedImport(updated, 'IconDefinition', '@lucide/angular');
  updated = removeNamedImport(updated, 'IconDefinition', 'lucide-react');
  updated = removeNamedImport(updated, 'IconDefinition', '@angular/core');

  // Fix prior bad stubs: initials: any[] = [] when template calls initials(...)
  updated = updated.replace(
    /(^\s*)initials\s*:\s*any\s*\[\s*\]\s*=\s*\[\s*\]\s*;/gm,
    '$1initials(..._args: any[]) { return String(_args[0] ?? \'\'); }'
  );

  // Angular Location has path(), not pathname (DOM Location leftover)
  updated = updated.replace(/this\.location\.pathname\b/g, 'this.location.path()');
  updated = updated.replace(/(\w+)\.pathname\.startsWith\(/g, '$1.path().startsWith(');

  // Field init order: icon: this.cog before cog is declared → use null then assign in ctor-less style
  // Soft-fix array literals that reference this.X before X: leave as-is if complex; common nav pattern:
  updated = updated.replace(
    /(^\s*(?:readonly\s+)?nav(?:Items|Links)?\s*=\s*\[[\s\S]*?\];)/m,
    (block) => {
      if (!/icon:\s*this\.\w+/.test(block)) return block;
      return block.replace(/icon:\s*this\.(\w+)/g, "icon: '$1'");
    }
  );

  return updated;
}

/**
 * Ensure countWhere helper exists when templates use it after arrow-fn rewrites.
 */
function ensureCountWhereHelper(source, html) {
  if (!/\bcountWhere\s*\(/.test(html) && !/\bcountWhere\s*\(/.test(source)) return source;
  if (classHasMember(source, 'countWhere')) return source;
  return insertIntoClassBody(
    source,
    `  countWhere(list: any, prop: string): number {
    const arr = typeof list === 'function' ? list() : list;
    return (Array.isArray(arr) ? arr : []).filter((x: any) => !!(x && x[prop])).length;
  }`
  );
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

function repairAngularComponentFile(tsPath, options = {}) {
  const { sourceContent = '' } = options;
  let source = fs.readFileSync(tsPath, 'utf-8');
  const original = source;
  const className = componentClassNameFromFile(tsPath);
  const baseName = path.basename(tsPath, '.ts');
  const htmlPath = tsPath.replace(/\.ts$/, '.html');
  const cssPath = tsPath.replace(/\.ts$/, '.scss');
  const legacyCssPath = tsPath.replace(/\.ts$/, '.css');

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

  // Keep lucide imports until templates are rewritten to inline SVG, then strip packages
  source = repairEmblaImports(source);
  source = repairHallucinatedAngularApis(source);
  source = sanitizeStandaloneImports(source);
  source = rewriteMaterialBarrelImports(source);

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
    source = source.replace(/(@Component\s*\(\s*\{)/, `$1\n  styleUrl: './${baseName}.scss',`);
  }
  // Force any .css styleUrl to .scss
  source = source
    .replace(/styleUrl\s*:\s*['"]([^'"]+)\.css['"]/g, "styleUrl: '$1.scss'")
    .replace(/styleUrls\s*:\s*\[\s*['"]([^'"]+)\.css['"]\s*\]/g, "styleUrls: ['$1.scss']");

  if (fs.existsSync(legacyCssPath) && !fs.existsSync(cssPath)) {
    try { fs.renameSync(legacyCssPath, cssPath); } catch { /* ignore */ }
  }

  const assets = collectReferencedAssetPaths(source, tsPath);
  for (const asset of assets) {
    if (fs.existsSync(asset.full)) continue;
    ensureDirectoryExists(path.dirname(asset.full));
    if (asset.type === 'html') {
      // Do not invent stub templates — missing HTML must fail the conversion.
      console.warn(`[postprocess] Missing template (not stubbing): ${asset.full}`);
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
      console.warn(`[postprocess] Missing HTML template (not stubbing): ${targetHtml}`);
      continue;
    }
    let html = fs.readFileSync(targetHtml, 'utf-8');
    // React leftover event / form patterns
    html = repairAngularTemplateHtml(html, source);
    // ALL lucide / React icon tags → plain inline <svg> (while lucide imports still visible)
    html = rewriteLegacyLucideHtmlTags(html, source, sourceContent);
    // Then drop every lucide package import — no @lucide/angular in output
    source = stripLucidePackageUsage(source);
    // Remaining self-closing capitalized custom elements
    html = html.replace(/<([A-Z][\w.-]*)([^>]*?)\/>/g, '<$1$2></$1>');
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
    // Angular templates forbid `as` casts — use $any()
    html = html.replace(
      /\(\s*\$event\.target\s+as\s+\w+\s*\)\.(\w+)/g,
      '$any($event.target).$1'
    );
    html = html.replace(
      /\$event\.target\.value/g,
      '$any($event.target).value'
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
    // Ensure lucide packages stay removed after template sync
    source = stripLucidePackageUsage(source);
    // Import custom-element children used in template (and align selectors)
    const srcRoot = (() => {
      let dir = path.dirname(tsPath);
      while (dir && path.basename(dir) !== 'src' && dir !== path.dirname(dir)) {
        dir = path.dirname(dir);
      }
      return dir && path.basename(dir) === 'src' ? dir : path.join(path.dirname(tsPath), '..', '..');
    })();
    const synced = syncAppChildComponentImports(source, html, tsPath, srcRoot);
    source = synced.source;
    html = synced.html;
    const inferred = repairInferredTemplateHandlers(source, html);
    source = inferred.source;
    html = inferred.html;
    // Stub missing template members (AI sibling mismatch)
    source = stubMissingTemplateMembers(source, html);
    const inferredAfterStub = repairInferredTemplateHandlers(source, html);
    source = inferredAfterStub.source;
    html = inferredAfterStub.html;
    source = ensureCountWhereHelper(source, html);
    source = repairFormBuilderInit(source);
    source = repairBogusAngularFormsImports(source);
    source = sanitizeStandaloneImports(source);
    source = syncNgComponentImports(source, html);
    source = dedupeImports(source);
    fs.writeFileSync(targetHtml, html, 'utf-8');
  }

  // Prefer real @Input/@Output over heuristic stubs; fix strict-null field inits
  source = dedupeStubbedClassMembers(source);
  source = repairNullAssignedPrimitives(source);
  for (const targetHtml of htmlFiles) {
    if (!fs.existsSync(targetHtml)) continue;
    const html = fs.readFileSync(targetHtml, 'utf-8');
    const next = rewriteBareOutputCallsToEmit(html, source);
    if (next !== html) {
      fs.writeFileSync(targetHtml, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
    }
  }
  source = syncNgComponentImports(source, readAllTemplates(source, tsPath));
  source = dedupeImports(source);

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

function repairAngularAppBootstrap(destPath, sourceFilesMap = null) {
  const appConfigPath = path.join(destPath, 'src', 'app', 'app.config.ts');
  const appComponentPath = path.join(destPath, 'src', 'app', 'app.component.ts');
  const mainPath = path.join(destPath, 'src', 'main.ts');
  const routesPath = path.join(destPath, 'src', 'app', 'app.routes.ts');

  // Restore a sane app.config.ts ONLY when missing. The web_angular template
  // ships a complete config (interceptors + NGXS + toastr) that must survive.
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

  if (!fs.existsSync(appConfigPath)) {
    ensureDirectoryExists(path.dirname(appConfigPath));
    fs.writeFileSync(appConfigPath, expectedConfig, 'utf-8');
    console.warn('[postprocess] Wrote missing app.config.ts');
  }

  if (!fs.existsSync(routesPath)) {
    // routes file missing — create empty routes so the app still compiles
    ensureDirectoryExists(path.dirname(routesPath));
    fs.writeFileSync(
      routesPath,
      `import { Routes } from '@angular/router';\n\nexport const routes: Routes = [];\n`,
      'utf-8'
    );
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
  styleUrl: './app.component.scss'
})
export class AppComponent {}
`;
      fs.writeFileSync(appComponentPath, appTs, 'utf-8');
    } else {
      repairAngularComponentFile(appComponentPath, {
        sourceContent: findMatchingSourceContent(appComponentPath, destPath, sourceFilesMap)
      });
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
    // Never write placeholder pages. Drop the unresolved import and any route
    // that referenced it so the workspace does not pretend the page exists.
    source = source.replace(item.full, '');
    const symbols = item.symbols
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const sym of symbols) {
      const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      source = source.replace(
        new RegExp(`\\{[^{}]*\\bcomponent\\s*:\\s*${esc}\\b[^{}]*\\}\\s*,?`, 'g'),
        ''
      );
    }
    console.warn(`[postprocess] Removed unresolved route import (no stub): ${item.from}`);
  }

  if (missing.length > 0) {
    console.warn(
      `[postprocess] app.routes.ts had ${missing.length} missing module(s); imports dropped instead of placeholder stubs.`
    );
  }

  fs.writeFileSync(routesPath, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
}

function addAngularPathAliases(destPath) {
  const tsconfigPath = path.join(destPath, 'tsconfig.json');
  const tsconfigAppPath = path.join(destPath, 'tsconfig.app.json');
  // web_angular template aliases (plus @/ as a convenience for cn() helpers)
  const pathAliases = { ...WEB_ANGULAR_PATH_ALIASES };
  const tsconfig = readJsonSafe(tsconfigPath) || {};
  tsconfig.compilerOptions = tsconfig.compilerOptions || {};
  tsconfig.compilerOptions.baseUrl = './';
  // Classic "node" resolution cannot read Angular package "exports" (e.g. @angular/common/http)
  if (tsconfig.compilerOptions.moduleResolution === 'node') {
    tsconfig.compilerOptions.moduleResolution = 'bundler';
  }
  const libs = tsconfig.compilerOptions.lib || [];
  if (!libs.includes('dom.iterable')) {
    tsconfig.compilerOptions.lib = [...new Set([...libs, 'ES2022', 'dom', 'dom.iterable'])];
  }
  // Normalize existing path targets now that baseUrl is './' (e.g. "app/*" → "src/app/*")
  const existingPaths = tsconfig.compilerOptions.paths || {};
  const normalizedPaths = {};
  for (const [key, targets] of Object.entries(existingPaths)) {
    normalizedPaths[key] = (targets || []).map((t) =>
      /^(src\/|\.\/|\.\.\/|\/)/.test(t) ? t : `src/${t}`
    );
  }
  tsconfig.compilerOptions.paths = { ...normalizedPaths, ...pathAliases };
  const coreVer = String(readJsonSafe(path.join(destPath, 'package.json'))?.dependencies?.['@angular/core'] || '');
  const angularMajor = Number.parseInt(coreVer.replace(/^[^\d]*/, ''), 10);
  if (!Number.isNaN(angularMajor) && angularMajor < 22) {
    delete tsconfig.compilerOptions.ignoreDeprecations;
  } else if (angularMajor >= 22) {
    tsconfig.compilerOptions.ignoreDeprecations = '6.0';
  }
  writeJson(tsconfigPath, tsconfig);

  if (fs.existsSync(tsconfigAppPath)) {
    const appCfg = readJsonSafe(tsconfigAppPath) || {};
    appCfg.compilerOptions = appCfg.compilerOptions || {};
    appCfg.compilerOptions.baseUrl = './';
    const appPaths = appCfg.compilerOptions.paths || {};
    const appNormalized = {};
    for (const [key, targets] of Object.entries(appPaths)) {
      appNormalized[key] = (targets || []).map((t) =>
        /^(src\/|\.\/|\.\.\/|\/)/.test(t) ? t : `src/${t}`
      );
    }
    appCfg.compilerOptions.paths = { ...appNormalized, ...pathAliases };
    writeJson(tsconfigAppPath, appCfg);
  }
}

/**
 * Packages that belong to the React/Vite/TanStack/Lovable toolchain.
 * Copying these into an Angular workspace makes npm i fail (peer vite conflicts,
 * private @lovable.dev scopes, nitro betas).
 */
function isReactEcosystemPackage(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n === 'react' || n === 'react-dom' || n === 'react-native') return true;
  if (n.startsWith('react-') || n.endsWith('-react') || n.includes('/react-')) return true;
  if (n.startsWith('@types/react')) return true;
  if (n.startsWith('@tanstack/')) return true;
  if (n.startsWith('@lovable') || n.includes('lovable')) return true;
  if (n === 'vite' || n.startsWith('vite-') || n.startsWith('@vitejs/')) return true;
  if (n === '@tailwindcss/vite' || n.startsWith('@tailwindcss/vite')) return true;
  if (n === 'nitro' || n.startsWith('nitro') || n === 'nitropack') return true;
  if (n.startsWith('@hookform/')) return true;
  if (n.startsWith('@radix-ui/')) return true;
  if (n.startsWith('@mui/') || n.startsWith('@emotion/')) return true;
  if (n === 'cmdk' || n === 'vaul' || n === 'sonner' || n === 'input-otp' || n === 'next') return true;
  return false;
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

  // Tailwind + SCSS toolchain for every migrated app
  if (!pkg.devDependencies.tailwindcss) pkg.devDependencies.tailwindcss = '^3.4.17';
  if (!pkg.devDependencies.postcss) pkg.devDependencies.postcss = '^8.4.49';
  if (!pkg.devDependencies.autoprefixer) pkg.devDependencies.autoprefixer = '^10.4.20';
  if (!pkg.devDependencies.sass) pkg.devDependencies.sass = '^1.83.0';

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
    '@lucide/angular',
    // Tailwind v4-only CSS packages break Angular Sass (@theme / @utility / @property)
    'tw-animate-css',
    'tailwindcss-animate',
    '@types/jasmine', 'jasmine-core', 'karma', 'karma-chrome-launcher',
    'karma-coverage', 'karma-jasmine', 'karma-jasmine-html-reporter'
  ]);

  for (const [name, version] of Object.entries(srcDeps)) {
    if (skip.has(name)) continue;
    if (name.startsWith('@angular/')) continue;
    if (name.startsWith('@ngxs/')) continue;
    if (name.startsWith('@types/') && targetFramework === 'angular') continue;
    if (targetFramework === 'angular' && isReactEcosystemPackage(name)) continue;
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

    // Do not inject Material/NGXS/toastr kit packages — converted source owns deps.

    for (const name of Object.keys(pkg.dependencies)) {
      if (isReactEcosystemPackage(name)) delete pkg.dependencies[name];
    }
    for (const name of Object.keys(pkg.devDependencies)) {
      if (isReactEcosystemPackage(name)) delete pkg.devDependencies[name];
    }

    // Remove ALL lucide packages from Angular output — icons are plain inline SVG
    delete pkg.dependencies['lucide-angular'];
    delete pkg.devDependencies['lucide-angular'];
    delete pkg.dependencies['@lucide/angular'];
    delete pkg.devDependencies['@lucide/angular'];
    delete pkg.dependencies['lucide-react'];
    delete pkg.devDependencies['lucide-react'];
    delete pkg.dependencies.lucide;
    delete pkg.devDependencies.lucide;
  }

    if (targetFramework === 'react') {
    if (srcDeps['react-router-dom'] || walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.tsx') || n.endsWith('.jsx')).some((f) => /react-router-dom/.test(fs.readFileSync(f, 'utf-8')))) {
      pkg.dependencies['react-router-dom'] = srcDeps['react-router-dom'] || '^7.18.1';
    }
    delete pkg.dependencies['lucide-angular'];
    delete pkg.dependencies['@lucide/angular'];
    delete pkg.dependencies['@ngxs/store'];
    delete pkg.dependencies['@ngxs/logger-plugin'];
    for (const name of Object.keys(pkg.dependencies)) {
      if (name.startsWith('@angular/') || name.startsWith('@ngxs/')) delete pkg.dependencies[name];
    }
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
      .replace(/from\s*['"]lucide-react['"]/g, "from '__REMOVED_LUCIDE__'")
      .replace(/from\s*['"]lucide-angular['"]/g, "from '__REMOVED_LUCIDE__'")
      .replace(/from\s*['"]@lucide\/angular['"]/g, "from '__REMOVED_LUCIDE__'")
      .replace(/from\s*['"]react['"]/g, "from '@angular/core'") // weak; skip if hooks file
      .replace(/import\s+React\s*,?\s*/g, '');

    // Don't copy files that still depend on lucide packages — icons are inlined in templates
    if (/__REMOVED_LUCIDE__/.test(adapted)) {
      continue;
    }

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

    content = stripLucidePackageUsage(content);
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
          console.warn(`[postprocess] Unresolved @/components import (not stubbing): ${rest}`);
          return full;
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
/** Event-style outputs only — not callback Inputs like onClick used as `[onClick]="fn"`. */
const PROMOTE_TO_OUTPUT = new Set([
  'onSave', 'onCancel', 'onSubmit', 'onClose', 'onConfirm', 'onSelect',
  'onChange', 'onDelete', 'onEdit', 'onCreate', 'onUpdate', 'onRemove'
]);

const SKIP_AUTO_INPUT = new Set([
  'class', 'style', 'ngClass', 'ngStyle', 'ngIf', 'ngFor', 'ngSwitch', 'ngModel',
  'formGroup', 'formControl', 'formControlName', 'routerLink', 'routerLinkActive',
  'cdkDrag', 'cdkDropList', 'matTooltip', 'matMenuTriggerFor'
]);

/**
 * Ensure child components declare `@Input()` for parent property bindings like `[description]`.
 */
function ensureInputsFromParentPropertyBindings(destPath) {
  const srcRoot = path.join(destPath, 'src');
  const bySelector = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts'))) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const sel = content.match(/selector\s*:\s*['"]([^'"]+)['"]/);
      if (sel) bySelector.set(sel[1].toLowerCase(), file);
    } catch {
      /* ignore */
    }
  }

  /** @type {Map<string, Set<string>>} */
  const needed = new Map();
  for (const htmlFile of walkFiles(srcRoot, (n) => n.endsWith('.html'))) {
    let html;
    try {
      html = fs.readFileSync(htmlFile, 'utf-8');
    } catch {
      continue;
    }
    for (const m of html.matchAll(
      /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b([^>]*)>/gi
    )) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] || '';
      const file = bySelector.get(tag);
      if (!file) continue;
      for (const am of attrs.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]\s*=/g)) {
        const inputName = am[1];
        if (SKIP_AUTO_INPUT.has(inputName) || inputName.startsWith('attr.')) continue;
        if (!needed.has(file)) needed.set(file, new Set());
        needed.get(file).add(inputName);
      }
    }
  }

  for (const [file, names] of needed) {
    let source = fs.readFileSync(file, 'utf-8');
    const original = source;
    for (const name of names) {
      if (classHasMember(source, name)) continue;
      source = ensureImport(source, 'Input', '@angular/core');
      source = insertIntoClassBody(source, `  @Input() ${name}: any = null;`);
    }
    if (source !== original) {
      source = repairNullAssignedPrimitives(source);
      fs.writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
    }
  }
}

function classHasOutput(source, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return false;
  return (
    new RegExp(`@Output\\s*\\([^)]*\\)\\s*(?:readonly\\s+)?${esc}\\b`).test(source) ||
    new RegExp(`\\b${esc}\\s*=\\s*output\\s*(?:<[^>]*>)?\\s*\\(`).test(source)
  );
}

function classHasMethod(source, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return false;
  return new RegExp(
    `(?:^|\\n)[ \\t]*(?:public|protected|private|override|async\\s+)*${esc}\\s*\\([^;{]*\\)\\s*(?::[^{]+)?\\{`,
    'm'
  ).test(source);
}

function outputNameWithoutOnPrefix(name) {
  const n = String(name || '');
  if (!/^on[A-Z]/.test(n)) return '';
  const rest = n.slice(2);
  return rest ? rest.charAt(0).toLowerCase() + rest.slice(1) : '';
}

function outputNameWithOnPrefix(name) {
  const n = String(name || '');
  if (!n || /^on[A-Z]/.test(n)) return '';
  return `on${n.charAt(0).toUpperCase()}${n.slice(1)}`;
}

const BARE_OUTPUT_ALIASES = new Set(
  [...PROMOTE_TO_OUTPUT].map((n) => outputNameWithoutOnPrefix(n)).filter(Boolean)
);

function nearestOpenTagName(html, index) {
  const before = String(html || '').slice(0, index);
  const lt = before.lastIndexOf('<');
  if (lt < 0) return '';
  const chunk = String(html).slice(lt, index);
  if (chunk.includes('>')) return '';
  const m = chunk.match(/^<([A-Za-z][\w-]*)/);
  return m ? m[1] : '';
}

function resolveChildComponentFile(tag, bySelector, byClass) {
  const raw = String(tag || '');
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (bySelector.has(lower)) return bySelector.get(lower);
  if (byClass.has(raw)) return byClass.get(raw);
  if (byClass.has(`${raw}Component`)) return byClass.get(`${raw}Component`);
  const kebab = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
  if (bySelector.has(kebab)) return bySelector.get(kebab);
  const withApp = kebab.startsWith('app-') ? kebab : `app-${kebab}`;
  if (bySelector.has(withApp)) return bySelector.get(withApp);
  return null;
}

function indexAngularComponents(srcRoot) {
  const bySelector = new Map();
  const byClass = new Map();
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.component.ts'))) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const sel = content.match(/selector\s*:\s*['"]([^'"]+)['"]/);
    if (sel) bySelector.set(sel[1].toLowerCase(), file);
    const cls = content.match(/export\s+class\s+(\w+)/);
    if (cls) {
      byClass.set(cls[1], file);
      byClass.set(cls[1].replace(/Component$/, ''), file);
    }
  }
  return { bySelector, byClass };
}

/**
 * Align parent `(save)` / `(onSave)` with whatever `@Output()` the child actually declares.
 * A mismatched name is treated as a native host event, so `$event` becomes `Event` (TS2345).
 * Do not invent a second `@Output() onSave` that collides with a wrapper method, and
 * do not rewrite `(click)="onRemove(task)"` into `onRemove.emit(task)` when `onRemove` is a method.
 */
function ensureOutputsFromParentEventBindings(destPath) {
  const srcRoot = path.join(destPath, 'src');
  const { bySelector, byClass } = indexAngularComponents(srcRoot);

  const remapParentEventName = (full, name, eq, offset, html) => {
    const tag = nearestOpenTagName(html, offset);
    const childFile = resolveChildComponentFile(tag, bySelector, byClass);
    if (!childFile) return full;
    let childSrc = '';
    try {
      childSrc = fs.readFileSync(childFile, 'utf-8');
    } catch {
      return full;
    }
    if (classHasOutput(childSrc, name)) return full;
    const alias = outputNameWithoutOnPrefix(name);
    if (alias && classHasOutput(childSrc, alias)) return `(${alias})${eq}`;
    const onName = outputNameWithOnPrefix(name);
    if (onName && classHasOutput(childSrc, onName)) return `(${onName})${eq}`;
    return full;
  };

  for (const htmlFile of walkFiles(srcRoot, (n) => n.endsWith('.html'))) {
    let html;
    try {
      html = fs.readFileSync(htmlFile, 'utf-8');
    } catch {
      continue;
    }
    const next = html.replace(/\(([A-Za-z][A-Za-z0-9]*)\)(\s*=)/g, (full, name, eq, offset) => {
      if (PROMOTE_TO_OUTPUT.has(name) || BARE_OUTPUT_ALIASES.has(name)) {
        return remapParentEventName(full, name, eq, offset, html);
      }
      return full;
    });
    if (next !== html) {
      fs.writeFileSync(htmlFile, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
    }
  }

  /** @type {Map<string, Set<string>>} */
  const needed = new Map();
  for (const htmlFile of walkFiles(srcRoot, (n) => n.endsWith('.html'))) {
    let html;
    try {
      html = fs.readFileSync(htmlFile, 'utf-8');
    } catch {
      continue;
    }
    for (const m of html.matchAll(/\(([A-Za-z][A-Za-z0-9]*)\)\s*=/g)) {
      const outName = m[1];
      if (!PROMOTE_TO_OUTPUT.has(outName) && !BARE_OUTPUT_ALIASES.has(outName)) continue;
      const tag = nearestOpenTagName(html, m.index || 0);
      const file = resolveChildComponentFile(tag, bySelector, byClass);
      if (!file) continue;
      let childSrc = '';
      try {
        childSrc = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const alias = outputNameWithoutOnPrefix(outName);
      const onName = outputNameWithOnPrefix(outName);
      if (
        classHasOutput(childSrc, outName) ||
        (alias && classHasOutput(childSrc, alias)) ||
        (onName && classHasOutput(childSrc, onName))
      ) {
        continue;
      }
      if (!needed.has(file)) needed.set(file, new Set());
      needed.get(file).add(outName);
    }
  }

  for (const [file, names] of needed) {
    let source = fs.readFileSync(file, 'utf-8');
    const original = source;
    for (const name of names) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (classHasOutput(source, name)) continue;

      source = source.replace(
        new RegExp(`^[ \\t]*@Input\\s*\\([^)]*\\)\\s*${esc}\\s*!?:[^;\\n]*;\\s*\\n?`, 'gm'),
        ''
      );
      source = source.replace(
        new RegExp(`^[ \\t]*${esc}\\(\\.\.\._args:[\\s\\S]*?\\}\\s*\\n?`, 'gm'),
        ''
      );
      source = source.replace(
        new RegExp(
          `^[ \\t]*(?:public|protected|private|readonly\\s+)*${esc}\\s*!?:\\s*[^=;\\n]+=\\s*[^;\\n]+;\\s*\\n?`,
          'gm'
        ),
        ''
      );

      if (classHasMethod(source, name)) {
        source = removeNamedClassMethods(source, name);
      }
      source = ensureImport(source, 'Output', '@angular/core');
      source = ensureImport(source, 'EventEmitter', '@angular/core');
      source = insertIntoClassBody(source, `  @Output() ${name} = new EventEmitter<any>();`);

      const htmlPath = file.replace(/\.ts$/, '.html');
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, 'utf-8');
        const nextHtml = html.replace(
          new RegExp(`\\b${esc}(?!\\.emit)\\s*\\(`, 'g'),
          `${name}.emit(`
        );
        if (nextHtml !== html) {
          fs.writeFileSync(htmlPath, nextHtml.endsWith('\n') ? nextHtml : `${nextHtml}\n`, 'utf-8');
        }
      }
    }
    if (source !== original) {
      fs.writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
    }
  }
}

/**
 * `(click)="onRemove.emit(task)"` fails when `onRemove` is a wrapper method, not an EventEmitter.
 */
function repairCallbackEmitInTemplates(destPath) {
  const srcRoot = path.join(destPath, 'src');
  for (const tsFile of walkFiles(srcRoot, (n) => n.endsWith('.component.ts'))) {
    const htmlPath = tsFile.replace(/\.ts$/, '.html');
    if (!fs.existsSync(htmlPath)) continue;
    let source = '';
    let html = '';
    try {
      source = fs.readFileSync(tsFile, 'utf-8');
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      continue;
    }
    const next = html.replace(/\b([A-Za-z_]\w*)\.emit\s*\(/g, (full, name) => {
      if (classHasOutput(source, name) && !classHasMethod(source, name)) return full;
      if (classHasMethod(source, name)) return `${name}(`;
      const alias = outputNameWithoutOnPrefix(name);
      if (alias && classHasOutput(source, alias)) return `${alias}.emit(`;
      return full;
    });
    if (next !== html) {
      fs.writeFileSync(htmlPath, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
    }
  }
}

function wrapDomEventPayloads(destPath, buildErrors) {
  const text = String(buildErrors || '');
  if (!/Argument of type 'Event'|TS2345/.test(text)) return 0;
  const mentioned = new Set();
  for (const m of text.matchAll(/([\w./\\-]+\.component\.html)/g)) {
    mentioned.add(m[1].replace(/\\/g, '/').replace(/^\.?\//, ''));
  }
  let changed = 0;
  const srcRoot = path.join(destPath, 'src');
  const { bySelector, byClass } = indexAngularComponents(srcRoot);
  const targets = mentioned.size
    ? [...mentioned].map((rel) => path.join(destPath, rel)).filter((f) => fs.existsSync(f))
    : walkFiles(srcRoot, (n) => n.endsWith('.html'));
  for (const htmlFile of targets) {
    let html;
    try {
      html = fs.readFileSync(htmlFile, 'utf-8');
    } catch {
      continue;
    }
    const next = html.replace(
      /\((\w+)\)="(\w+)\(\$event\)"/g,
      (full, ev, handler, offset) => {
        if (/\$any\(\s*\$event\s*\)/.test(full)) return full;
        const tag = nearestOpenTagName(html, offset);
        const childFile = resolveChildComponentFile(tag, bySelector, byClass);
        if (childFile) {
          try {
            const childSrc = fs.readFileSync(childFile, 'utf-8');
            if (
              classHasOutput(childSrc, ev) ||
              classHasOutput(childSrc, outputNameWithoutOnPrefix(ev)) ||
              classHasOutput(childSrc, outputNameWithOnPrefix(ev))
            ) {
              return full;
            }
          } catch {
            /* fall through */
          }
        }
        if (!/^on[A-Z]\w+$/.test(ev) && !BARE_OUTPUT_ALIASES.has(ev)) return full;
        return `(${ev})="${handler}($any($event))"`;
      }
    );
    if (next !== html) {
      fs.writeFileSync(htmlFile, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
      changed += 1;
    }
  }
  return changed;
}

function workspaceUsesAngularMaterial(destPath, sourcePackageJson = null, sourceFilesMap = null) {
  const stack = detectSourceStack(sourceFilesMap || {}, sourcePackageJson);
  if (stack.material) return true;
  const srcRoot = path.join(destPath, 'src');
  if (!fs.existsSync(srcRoot)) return false;
  for (const file of walkFiles(
    srcRoot,
    (n) => n.endsWith('.ts') || n.endsWith('.html') || n.endsWith('.scss')
  )) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (
      /@angular\/material/.test(content) ||
      /<(mat-[\w-]+)\b/.test(content) ||
      /\bmat-[a-z][\w-]*\b/.test(content)
    ) {
      return true;
    }
  }
  return false;
}

function ensureMaterialTheme(destPath) {
  const theme = '@angular/material/prebuilt-themes/azure-blue.css';
  const angularJsonPath = path.join(destPath, 'angular.json');
  if (fs.existsSync(angularJsonPath)) {
    try {
      const aj = JSON.parse(fs.readFileSync(angularJsonPath, 'utf-8'));
      const project = aj?.projects && Object.values(aj.projects)[0];
      if (project?.architect?.build?.options) {
        const styles = Array.isArray(project.architect.build.options.styles)
          ? [...project.architect.build.options.styles]
          : [];
        if (!styles.some((s) => String(s).includes('@angular/material/prebuilt-themes'))) {
          styles.unshift(theme);
          project.architect.build.options.styles = styles;
          fs.writeFileSync(angularJsonPath, `${JSON.stringify(aj, null, 2)}\n`, 'utf-8');
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * React MUI (and generated mat-* templates) need @angular/material in the
 * converted workspace. The AI is forbidden from writing package.json, so the
 * migrator must add the packages or NG1010 / Cannot find module never clears.
 * Returns how many packages were added.
 */
export function ensureAngularMaterialPackages(destPath, sourcePackageJson = null, sourceFilesMap = null) {
  if (!workspaceUsesAngularMaterial(destPath, sourcePackageJson, sourceFilesMap)) return 0;
  const pkgPath = path.join(destPath, 'package.json');
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return 0;
  pkg.dependencies = pkg.dependencies || {};
  const core = pkg.dependencies['@angular/core'] || '22.0.8';
  const kit = webAngularNpmDeps(core);
  let added = 0;
  for (const name of ['@angular/material', '@angular/cdk']) {
    if (!pkg.dependencies[name]) {
      pkg.dependencies[name] = kit.dependencies[name];
      added += 1;
    }
  }
  if (!pkg.dependencies['@angular/animations'] && kit.dependencies['@angular/cdk']) {
    pkg.dependencies['@angular/animations'] = core;
  }
  if (added) writeJson(pkgPath, pkg);
  ensureMaterialTheme(destPath);
  ensureMaterialIconsLink(destPath);
  return added;
}

function ensureNgSymbolsFromBuildErrors(source, buildErrors) {
  let updated = String(source || '');
  const text = String(buildErrors || '').replace(/\u001b\[[0-9;]*m/g, '');
  const inDecorator = new Set(parseDecoratorImportItems(updated));
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
    const symbol = m[1];
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    if (!inDecorator.has(symbol) && !/^Mat[A-Z]/.test(symbol)) continue;
    const pkg = inferDeclarablePackage(symbol, updated);
    if (!pkg) continue;
    updated = ensureImport(updated, symbol, pkg);
    updated = ensureDecoratorImport(updated, symbol);
  }
  return updated;
}

export function repairAngularWorkspace(destPath, options = {}) {
  const { sourceFilesMap = null, sourcePackageJson = null } = options;

  addAngularPathAliases(destPath);
  copySourceLibs(destPath, sourceFilesMap);
  ensureCnUtil(destPath);
  mergePackageDependencies(destPath, sourcePackageJson, 'angular');
  ensureAngularMaterialPackages(destPath, sourcePackageJson, sourceFilesMap);

  const componentFiles = walkFiles(path.join(destPath, 'src'), (name) =>
    name.endsWith('.component.ts')
  );
  for (const file of componentFiles) {
    try {
      repairAngularComponentFile(file, {
        sourceContent: findMatchingSourceContent(file, destPath, sourceFilesMap)
      });
    } catch (err) {
      console.warn(`[postprocess] Failed repairing ${file}: ${err.message}`);
    }
  }

  try {
    ensureInputsFromParentPropertyBindings(destPath);
    ensureOutputsFromParentEventBindings(destPath);
    repairCallbackEmitInTemplates(destPath);
  } catch (err) {
    console.warn(`[postprocess] Input/Output binding repair failed: ${err.message}`);
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
      repairAngularComponentFile(file, {
        sourceContent: findMatchingSourceContent(file, destPath, sourceFilesMap)
      });
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

  repairAngularAppBootstrap(destPath, sourceFilesMap);
  repairAngularRoutes(destPath);
  removeHallucinatedNgModules(destPath);
  fixBrokenRelativeComponentImports(destPath);
  rewriteAtAliasImportsInTree(destPath);
  enforceTailwindScssWorkspace(destPath);

  // Second pass: child imports + lucide sync after path fixes
  for (const file of walkFiles(path.join(destPath, 'src'), (name) => name.endsWith('.component.ts'))) {
    try {
      repairAngularComponentFile(file, {
        sourceContent: findMatchingSourceContent(file, destPath, sourceFilesMap)
      });
    } catch (err) {
      console.warn(`[postprocess] Second-pass repair failed for ${file}: ${err.message}`);
    }
  }
}

/**
 * Inside `if (this.foo) { ... this.foo.bar ... }`, capture a local so nested
 * callbacks satisfy TS2531 (TypeScript does not narrow `this.prop` there).
 */
function narrowNullableThisAccessInSource(src) {
  const re = /if\s*\(\s*this\.(\w+)\s*\)\s*\{/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const openBrace = m.index + m[0].length - 1;
    let depth = 0;
    let i = openBrace;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i >= src.length) break;
    const block = src.slice(openBrace + 1, i);
    out += src.slice(last, m.index);
    if (
      new RegExp(`this\\.${name}\\.`).test(block) &&
      !new RegExp(`const\\s+\\w+\\s*=\\s*this\\.${name}\\b`).test(block)
    ) {
      const local = `current${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      const rewritten = block.replace(new RegExp(`this\\.${name}\\b`, 'g'), local);
      out += `if (this.${name}) {\n    const ${local} = this.${name};${rewritten}}`;
    } else {
      out += src.slice(m.index, i + 1);
    }
    last = i + 1;
    re.lastIndex = last;
  }
  out += src.slice(last);
  return out;
}

/**
 * Fix common Angular TS2322 / TS2531 from React→Angular conversion:
 * - INITIAL_* arrays with status string literals widened to string (annotate as Entity[])
 * - this.nullable.prop used inside callbacks after if (this.nullable) (capture local)
 */
export function repairAngularStrictNullAndStatusTypes(destPath, buildErrors = '') {
  const text = String(buildErrors || '');
  const srcRoot = path.join(destPath, 'src');
  const mentioned = new Set();
  for (const m of text.matchAll(/((?:src\/)?[\w./\\-]+\.component\.ts)/g)) {
    mentioned.add(m[1].replace(/\\/g, '/').replace(/^\.?\//, ''));
  }
  const files =
    mentioned.size > 0
      ? [...mentioned].map((rel) => path.join(destPath, rel)).filter((f) => fs.existsSync(f))
      : walkFiles(srcRoot, (n) => n.endsWith('.component.ts') || n.endsWith('.page.ts'));

  let changed = 0;
  for (const file of files) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;

    // Prefer primary model type (Item), not ItemDraft / ItemStatus
    const importMatch = content.match(
      /import\s+\{([^}]+)\}\s+from\s+['"][^'"]*models\/[^'"]+['"]/
    );
    const candidates = String(importMatch?.[1] || '')
      .split(',')
      .map((s) => s.replace(/\btype\s+/g, '').trim())
      .filter((s) => /^[A-Z][A-Za-z0-9]*$/.test(s));
    const fromAssign = content.match(
      /:\s*([A-Z][A-Za-z0-9]*)\s*\[\s*\]\s*=\s*\[\s*\.\.\.\s*(?:INITIAL_|DEFAULT_|SEED_|MOCK_)\w+/
    )?.[1];
    const entityName =
      (fromAssign && candidates.includes(fromAssign) ? fromAssign : null) ||
      candidates.find((s) => !/Status$|Draft$|Labels$|Options$/i.test(s)) ||
      candidates[0];

    if (entityName) {
      content = content.replace(
        new RegExp(
          `const\\s+(INITIAL_\\w+|DEFAULT_\\w+|SEED_\\w+|MOCK_\\w+)\\s*=\\s*(\\[[\\s\\S]*?\\]);`,
          'g'
        ),
        (full, name, arr) => {
          if (new RegExp(`^const\\s+${name}\\s*:`).test(full)) return full;
          if (new RegExp(`const\\s+${name}\\s*:\\s*${entityName}\\[\\]`).test(content)) return full;
          const usedAsEntity =
            new RegExp(`${entityName}\\[\\]\\s*=\\s*\\[\\s*\\.\\.\\.\\s*${name}\\s*\\]`).test(
              content
            ) || new RegExp(`=\\s*\\[\\s*\\.\\.\\.\\s*${name}\\s*\\]`).test(content);
          if (!/status\s*:/.test(arr) && !usedAsEntity) return full;
          return `const ${name}: ${entityName}[] = ${arr};`;
        }
      );
    }

    content = narrowNullableThisAccessInSource(content);

    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
      changed += 1;
    }
  }
  if (changed > 0) {
    console.log(`[postprocess] Repaired strict-null/status typing in ${changed} Angular file(s)`);
  }
  return changed;
}

/**
 * Mechanical Angular compile repairs for NG1010 (unknown @Component imports)
 * and missing Material modules referenced by the template.
 */
export function fixAngularCompileErrors(destPath, buildErrors) {
  const text = String(buildErrors || '').replace(/\u001b\[[0-9;]*m/g, '');
  const eventIssues =
    /TS2345/.test(text) ||
    /Argument of type 'Event'/.test(text) ||
    /Property 'emit' does not exist/.test(text);
  const typeIssues =
    /TS2322/.test(text) ||
    /TS2531/.test(text) ||
    /Object is possibly 'null'/.test(text) ||
    /is not assignable to type '\w+'/.test(text) ||
    /Type 'string' is not assignable to type/.test(text);
  const needs =
    /NG1010/.test(text) ||
    /NG5002/.test(text) ||
    /TS2300/.test(text) ||
    /TS2305/.test(text) ||
    /Duplicate identifier/.test(text) ||
    /Void elements do not have end tags/.test(text) ||
    /Unexpected closing tag/.test(text) ||
    /Unknown reference/.test(text) ||
    /is not a known element/.test(text) ||
    /is not a known attribute/.test(text) ||
    /Cannot find name 'Mat/.test(text) ||
    /has no exported member/.test(text);
  if (!needs && !eventIssues && !typeIssues) return 0;

  const srcRoot = path.join(destPath, 'src');
  const snapshot = () => {
    const map = new Map();
    for (const file of walkFiles(srcRoot, (n) => n.endsWith('.ts') || n.endsWith('.html'))) {
      try {
        map.set(file, fs.readFileSync(file, 'utf-8'));
      } catch {
        /* ignore */
      }
    }
    return map;
  };
  const beforeMap = snapshot();

  if (eventIssues) {
    try {
      ensureOutputsFromParentEventBindings(destPath);
      repairCallbackEmitInTemplates(destPath);
    } catch (err) {
      console.warn(`[postprocess] Output/emit repair failed: ${err.message}`);
    }
  }

  if (needs) {
    const mentioned = new Set();
    for (const m of text.matchAll(/([\w./\\-]+\.component\.ts)/g)) {
      mentioned.add(m[1].replace(/\\/g, '/').replace(/^\.?\//, ''));
    }

    const targets = [];
    for (const rel of mentioned) {
      const full = path.join(destPath, rel);
      if (fs.existsSync(full)) targets.push(full);
    }
    if (targets.length === 0) {
      targets.push(
        ...walkFiles(srcRoot, (n) => n.endsWith('.component.ts') || n.endsWith('.page.ts'))
      );
    }

    for (const file of [...new Set(targets)]) {
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, 'utf-8');
      try {
        repairAngularComponentFile(file, {});
      } catch (err) {
        console.warn(`[postprocess] Angular compile repair failed for ${file}: ${err.message}`);
        continue;
      }
      let after = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : before;
      const forced = ensureNgSymbolsFromBuildErrors(after, text);
      if (forced !== after) {
        fs.writeFileSync(file, forced.endsWith('\n') ? forced : `${forced}\n`, 'utf-8');
      }
    }
  }

  if (eventIssues) {
    wrapDomEventPayloads(destPath, text);
  }

  if (typeIssues) {
    try {
      repairAngularStrictNullAndStatusTypes(destPath, text);
    } catch (err) {
      console.warn(`[postprocess] Strict-null/status repair failed: ${err.message}`);
    }
  }

  const afterMap = snapshot();
  let changed = 0;
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const k of keys) {
    if (beforeMap.get(k) !== afterMap.get(k)) changed += 1;
  }
  return changed;
}

/**
 * Ensure Tailwind + SCSS conventions across the migrated Angular workspace.
 */
function enforceTailwindScssWorkspace(destPath) {
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.ts'))) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;
    content = content
      .replace(/styleUrl\s*:\s*['"]([^'"]+)\.css['"]/g, "styleUrl: '$1.scss'")
      .replace(/styleUrls\s*:\s*\[\s*['"]([^'"]+)\.css['"]\s*\]/g, "styleUrls: ['$1.scss']");
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
  }

  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.css'))) {
    const scssPath = file.replace(/\.css$/, '.scss');
    if (!fs.existsSync(scssPath)) {
      try { fs.renameSync(file, scssPath); } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }

  const angularJsonPath = path.join(destPath, 'angular.json');
  if (fs.existsSync(angularJsonPath)) {
    try {
      const aj = JSON.parse(fs.readFileSync(angularJsonPath, 'utf-8'));
      const project = aj?.projects && Object.values(aj.projects)[0];
      if (project?.architect?.build?.options) {
        // Preserve existing style entries (material prebuilt theme, toastr.css, …)
        const styles = Array.isArray(project.architect.build.options.styles)
          ? [...project.architect.build.options.styles]
          : [];
        if (!styles.some((s) => /src\/styles\.scss$/.test(String(s)))) styles.push('src/styles.scss');
        project.architect.build.options.styles = styles;
        project.architect.build.options.inlineStyleLanguage = 'scss';
      }
      if (project?.architect?.test?.options) {
        const tstyles = Array.isArray(project.architect.test.options.styles)
          ? [...project.architect.test.options.styles]
          : [];
        if (!tstyles.some((s) => /src\/styles\.scss$/.test(String(s)))) tstyles.push('src/styles.scss');
        project.architect.test.options.styles = tstyles;
      }
      project.schematics = project.schematics || {};
      project.schematics['@schematics/angular:component'] = {
        ...(project.schematics['@schematics/angular:component'] || {}),
        style: 'scss',
        standalone: true
      };
      fs.writeFileSync(angularJsonPath, `${JSON.stringify(aj, null, 2)}\n`, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  // The web_angular template already ships a full tailwind.config.js (and Angular
  // auto-detects Tailwind v3). Only scaffold both configs when both are missing.
  if (!fs.existsSync(path.join(destPath, 'tailwind.config.js'))) {
    fs.writeFileSync(
      path.join(destPath, 'tailwind.config.js'),
      `/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  content: ['./src/**/*.{html,ts,scss}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n`,
      'utf-8'
    );
    if (!fs.existsSync(path.join(destPath, 'postcss.config.js'))) {
      fs.writeFileSync(
        path.join(destPath, 'postcss.config.js'),
        `module.exports = {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`,
        'utf-8'
      );
    }
  }

  const stylesPath = path.join(destPath, 'src', 'styles.scss');
  if (!fs.existsSync(stylesPath)) {
    fs.writeFileSync(
      stylesPath,
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
      'utf-8'
    );
  } else {
    const styles = fs.readFileSync(stylesPath, 'utf-8');
    if (!/@tailwind\s+base/.test(styles)) {
      fs.writeFileSync(
        stylesPath,
        `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n${styles}`,
        'utf-8'
      );
    }
  }
  const legacyStyles = path.join(destPath, 'src', 'styles.css');
  if (fs.existsSync(legacyStyles)) {
    try { fs.unlinkSync(legacyStyles); } catch { /* ignore */ }
  }

  // Strip Tailwind-v4 / animate CSS imports that break Dart Sass in Angular
  stripForbiddenStylePackageImports(destPath);

  // Drop broken packages from package.json if AI/source carried them over
  const pkgPath = path.join(destPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      for (const section of ['dependencies', 'devDependencies']) {
        if (!pkg[section]) continue;
        delete pkg[section]['tw-animate-css'];
        delete pkg[section]['tailwindcss-animate'];
      }
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove @import/@use of packages whose CSS uses Tailwind v4 at-rules
 * (@theme, @utility, @property) that Dart Sass cannot parse.
 */
function stripForbiddenStylePackageImports(destPath) {
  const forbidden = [
    'tw-animate-css',
    'tailwindcss-animate',
    'tw-animate'
  ];
  const importRe = new RegExp(
    `^\\s*@(?:import|use)\\s+['"](?:~)?(?:${forbidden.join('|')})(?:/[^'"]*)?['"].*;?\\s*$`,
    'gim'
  );
  const cssUrlRe = new RegExp(
    `^\\s*@(?:import|use)\\s+['"][^'"]*(?:${forbidden.join('|')})[^'"]*['"].*;?\\s*$`,
    'gim'
  );

  for (const file of walkFiles(path.join(destPath, 'src'), (n) =>
    n.endsWith('.scss') || n.endsWith('.sass') || n.endsWith('.css')
  )) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;
    content = content.replace(importRe, '/* stripped incompatible animate CSS import */');
    content = content.replace(cssUrlRe, '/* stripped incompatible animate CSS import */');
    // Also strip inline @theme / @utility blocks that may have been pasted into scss
    if (/@theme\b|@utility\b/.test(content) && !/@tailwind\b/.test(content)) {
      content = content
        .replace(/@theme\b[\s\S]*?(?=@|\Z)/g, '/* stripped @theme (Tailwind v4) */\n')
        .replace(/@utility\b[\s\S]*?(?=@|\Z)/g, '/* stripped @utility (Tailwind v4) */\n');
    }
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
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

const REACT_KNOWN_PACKAGES = {
  '@mui/material': '^6.4.8',
  '@mui/icons-material': '^6.4.8',
  '@emotion/react': '^11.14.0',
  '@emotion/styled': '^11.14.0',
  zustand: '^5.0.3',
  'react-router-dom': '^7.18.1',
  'react-hook-form': '^7.54.2',
  'lucide-react': '^0.468.0',
  '@reduxjs/toolkit': '^2.5.0',
  'react-redux': '^9.2.0'
};

const MUI_JSX_NAMES = [
  'AppBar', 'Toolbar', 'Box', 'Drawer', 'Icon', 'Dialog', 'DialogTitle',
  'DialogContent', 'DialogActions', 'FormControl', 'InputLabel', 'FormHelperText',
  'Select', 'MenuItem', 'Button', 'IconButton', 'TextField', 'Card', 'CardHeader',
  'CardContent', 'CardActions', 'CircularProgress', 'Divider'
];

/**
 * Detect NGXS / Angular Material in the uploaded source so React conversion
 * can map them automatically.
 */
export function detectSourceStack(filesMap = {}, sourcePackageJson = null) {
  const pkgBlob = JSON.stringify(sourcePackageJson || {});
  const fileBlob = Object.values(filesMap || {}).join('\n');
  const blob = `${pkgBlob}\n${fileBlob}`;
  return {
    material:
      /@angular\/material/.test(blob) ||
      /@mui\/(material|icons-material)/.test(blob) ||
      /\bMat(Button|Icon|Sidenav|Dialog|Toolbar|FormField)/.test(blob),
    ngxs: /@ngxs\/store/.test(blob) || /\b(StateContext|provideStore|@State)\b/.test(blob),
    lucide: /lucide-angular|@lucide\/angular|lucide-react/.test(blob)
  };
}

/**
 * True when generated source looks truncated (unbalanced braces / trailing ellipsis).
 */
export function isTruncatedSource(content) {
  const text = String(content || '');
  if (!text.trim()) return true;
  if (/\n\s*\.\.\.\s*$/.test(text) && text.length < 400) return true;
  if (/\/\/\s*(TODO|rest of|implement later)\b/i.test(text) && text.length < 600) return true;
  let curly = 0;
  let paren = 0;
  let square = 0;
  let inStr = null;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') curly += 1;
    else if (ch === '}') curly -= 1;
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '[') square += 1;
    else if (ch === ']') square -= 1;
    if (curly < 0 || paren < 0 || square < 0) return true;
  }
  if (inStr) return true;
  return curly !== 0 || paren !== 0 || square !== 0;
}

function packageNameFromSpecifier(spec) {
  const s = String(spec || '');
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('@/')) return '';
  if (s.startsWith('@')) {
    const parts = s.split('/');
    return parts.slice(0, 2).join('/');
  }
  return s.split('/')[0];
}

function collectBareImportPackages(destPath) {
  const specs = new Set();
  const srcRoot = path.join(destPath, 'src');
  for (const file of walkFiles(srcRoot, (n) =>
    n.endsWith('.ts') || n.endsWith('.tsx') || n.endsWith('.js') || n.endsWith('.jsx')
  )) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const pkg = packageNameFromSpecifier(m[1]);
      if (pkg) specs.add(pkg);
    }
  }
  return specs;
}

function findMatchingDelimiter(text, openIdx) {
  const open = text[openIdx];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return -1;
  let depth = 0;
  let inStr = null;
  let escape = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hookNameFromStateClass(name) {
  const base = String(name || '').replace(/State$/, '');
  return `use${base || 'App'}Store`;
}

function rewriteNgxsActionBody(body) {
  return String(body || '')
    .replace(/\bctx\.patchState\(/g, 'set(')
    .replace(/\bctx\.setState\(/g, 'set(')
    .replace(/\bctx\.getState\(\)/g, 'get()')
    .replace(/\bctx\.dispatch\(/g, 'get(); /* dispatch */(');
}

function methodParamsFromNgxsAction(params, body) {
  const usesPayload = /\baction\.payload\b/.test(body);
  const usesId = /\baction\.id\b/.test(body);
  if (usesPayload && !usesId) return { params: 'payload', body: body.replace(/\baction\.payload\b/g, 'payload') };
  if (usesId && !usesPayload) return { params: 'id', body: body.replace(/\baction\.id\b/g, 'id') };
  if (/\baction\b/.test(body)) return { params: 'action', body };
  const extra = String(params || '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/\bctx\b/.test(p));
  if (extra.length === 0) return { params: '', body };
  return { params: extra.map((p) => p.split(':')[0].replace(/^(public|private|readonly)\s+/, '').trim()).join(', '), body };
}

/**
 * Convert a leftover NGXS @State class into a zustand create() store.
 */
export function rewriteNgxsStateToZustand(content) {
  const text = String(content || '');
  if (!/@State\s*(?:<[^>]+>)?\s*\(/.test(text) && !/@Action\s*\(/.test(text)) return text;
  if (/from\s+['"]zustand['"]/.test(text) && /\bcreate\s*\(/.test(text)) return text;

  const classMatch = text.match(/export\s+class\s+(\w+)/);
  if (!classMatch) return text;
  const className = classMatch[1];
  const hookName = hookNameFromStateClass(className);
  const classIdx = text.indexOf(classMatch[0]);
  let decoStart = classIdx;
  const stateDeco = text.lastIndexOf('@State', classIdx);
  if (stateDeco >= 0) decoStart = stateDeco;
  const injDeco = text.lastIndexOf('@Injectable', classIdx);
  if (injDeco >= 0 && injDeco < decoStart) decoStart = injDeco;

  let fields = '';
  const defaultsKey = text.indexOf('defaults', decoStart >= 0 ? decoStart : 0);
  if (defaultsKey >= 0 && defaultsKey < classIdx) {
    const after = text.slice(defaultsKey);
    const ident = after.match(/^defaults\s*:\s*([A-Za-z_][\w]*)/);
    const braceRel = after.search(/defaults\s*:\s*\{/);
    if (braceRel >= 0) {
      const braceAbs = defaultsKey + after.slice(braceRel).indexOf('{');
      const objEnd = findMatchingDelimiter(text, braceAbs);
      if (objEnd > braceAbs) fields = text.slice(braceAbs + 1, objEnd).trim();
    } else if (ident) {
      fields = `...${ident[1]}`;
    }
  }

  const actions = [];
  const actionRe = /@Action\s*\(\s*(\w+)\s*\)/g;
  let am;
  while ((am = actionRe.exec(text))) {
    const after = text.slice(am.index + am[0].length);
    const sig = after.match(/^\s*(\w+)\s*\(([^)]*)\)\s*(?::\s*[^\{]+)?\s*\{/);
    if (!sig) continue;
    const methodName = sig[1];
    const openBrace = am.index + am[0].length + sig[0].length - 1;
    const closeBrace = findMatchingDelimiter(text, openBrace);
    if (closeBrace < 0) continue;
    const rawBody = text.slice(openBrace + 1, closeBrace);
    const rewritten = rewriteNgxsActionBody(rawBody);
    const shaped = methodParamsFromNgxsAction(sig[2], rewritten);
    actions.push({ methodName, ...shaped });
  }

  let head = text.slice(0, decoStart).trimEnd();
  head = head.replace(/import\s+[^;]*from\s+['"]@ngxs\/[^'"]+['"]\s*;?\s*/g, '');
  head = head.replace(/import\s+[^;]*from\s+['"]@angular\/[^'"]+['"]\s*;?\s*/g, '');
  head = head.replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]*actions['"]\s*;?\s*/g, '');
  if (!/from\s+['"]zustand['"]/.test(head)) {
    head = `import { create } from 'zustand';\n${head}`.replace(/\n{3,}/g, '\n\n');
  }

  const methodBlock = actions
    .map((a) => `  ${a.methodName}: (${a.params}) => {${a.body}  }`)
    .join(',\n');
  const parts = [];
  if (fields) parts.push(fields.replace(/,?\s*$/, ''));
  if (methodBlock) parts.push(methodBlock);
  return `${head}\n\nexport const ${hookName} = create((set, get) => ({\n${parts.join(',\n')}\n}));\n`;
}

function rewriteNgxsActionFile(content) {
  const text = String(content || '');
  if (!/static\s+readonly\s+type\s*=/.test(text)) return text;
  if (/from\s+['"]zustand['"]/.test(text) || /@State\s*\(/.test(text)) return text;
  return text.replace(
    /export\s+class\s+(\w+)\s*\{[\s\S]*?constructor\s*\(([^)]*)\)\s*\{\s*\}[\s\S]*?\}/g,
    (_, name, ctor) => {
      const typed = String(ctor || '').match(/:\s*([\w<>,\s\[\]|&]+)/);
      const payloadType = typed ? typed[1].trim() : 'unknown';
      return `export type ${name} = ${payloadType};`;
    }
  );
}

function inferZustandHook(content) {
  const select = String(content || '').match(/\b([A-Z]\w*State)\./);
  if (select) return hookNameFromStateClass(select[1]);
  const imported = String(content || '').match(/import\s+\{[^}]*\b([A-Z]\w*State)\b/);
  if (imported) return hookNameFromStateClass(imported[1]);
  return 'useAppStore';
}

function rewriteNgxsDispatchAndSelect(content) {
  let c = String(content || '');
  const fallbackHook = inferZustandHook(c);

  c = c.replace(
    /(?:this\.)?store\.dispatch\(\s*new\s+(\w+)\s*\(([\s\S]*?)\)\s*\)/g,
    (_, action, args) => {
      const method = `${action.charAt(0).toLowerCase()}${action.slice(1)}`;
      return `${fallbackHook}.getState().${method}(${args})`;
    }
  );
  c = c.replace(
    /(?:(?:readonly|public|private)\s+)?(?:readonly\s+)?(\w+)\$?\s*=\s*(?:this\.)?store\.select\(\s*(\w+)\.(\w+)\s*\)/g,
    (_, name, stateClass, field) =>
      `const ${String(name).replace(/\$$/, '')} = ${hookNameFromStateClass(stateClass)}((s) => s.${field})`
  );
  c = c.replace(
    /(?:this\.)?store\.selectSnapshot\(\s*(\w+)\.(\w+)\s*\)/g,
    (_, stateClass, field) => `${hookNameFromStateClass(stateClass)}.getState().${field}`
  );
  c = c.replace(
    /(?:this\.)?store\.select\(\s*(\w+)\.(\w+)\s*\)/g,
    (_, stateClass, field) => `${hookNameFromStateClass(stateClass)}((s) => s.${field})`
  );
  c = c.replace(
    /@Select\(\s*(\w+)\.(\w+)\s*\)\s*(?:readonly\s+)?(\w+)\$?\s*;?/g,
    (_, stateClass, field, name) =>
      `const ${String(name).replace(/\$$/, '')} = ${hookNameFromStateClass(stateClass)}((s) => s.${field});`
  );
  c = c.replace(
    /^[ \t]*(?:private|public|protected|readonly)\s+(?:readonly\s+)?(?:store\s*=\s*)?inject\(\s*Store\s*\)\s*;?[ \t]*\n/gm,
    ''
  );
  c = c.replace(/^[ \t]*(?:const|let)\s+\w+\s*=\s*inject\(\s*Store\s*\)\s*;?[ \t]*\n/gm, '');
  c = c.replace(/\bprovideStore\s*\((?:[^)(]|\([^)(]*\))*\)\s*,?/g, '');
  return c;
}

function rewriteAngularControlFlow(content) {
  const text = String(content || '');
  if (!/@if\s*\(|@for\s*\(|@else\b/.test(text)) return text;

  let i = 0;
  let out = '';
  let inStr = null;
  let escape = false;
  const stack = [];

  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (text.startsWith('@if', i) && /^@if\s*\(/.test(text.slice(i))) {
      const parenStart = text.indexOf('(', i);
      const parenEnd = findMatchingDelimiter(text, parenStart);
      if (parenEnd < 0) {
        out += ch;
        i += 1;
        continue;
      }
      let cond = text.slice(parenStart + 1, parenEnd).trim();
      const asMatch = cond.match(/;\s*as\s+(\w+)\s*$/);
      const alias = asMatch?.[1];
      if (asMatch) cond = cond.slice(0, asMatch.index).trim();
      cond = cond.replace(/\|\s*async/g, '').trim();
      i = parenEnd + 1;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === '{') i += 1;
      if (alias) {
        out += `{(() => { const ${alias} = ${cond}; return ${alias} ? (`;
        stack.push({ close: ') : null})()}', depth: 1, hasElse: false });
      } else {
        out += `{${cond} ? (`;
        stack.push({ close: ') : null)}', depth: 1, hasElse: false });
      }
      continue;
    }

    if (text.startsWith('@for', i) && /^@for\s*\(/.test(text.slice(i))) {
      const parenStart = text.indexOf('(', i);
      const parenEnd = findMatchingDelimiter(text, parenStart);
      if (parenEnd < 0) {
        out += ch;
        i += 1;
        continue;
      }
      const inner = text.slice(parenStart + 1, parenEnd);
      const loop = inner.match(/(\w+)\s+of\s+([^;]+)/);
      i = parenEnd + 1;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] === '{') i += 1;
      if (loop) {
        out += `{${loop[2].trim()}.map((${loop[1]}) => (`;
        stack.push({ close: '))}', depth: 1 });
      }
      continue;
    }

    if (ch === '}' && stack.length) {
      const rest = text.slice(i);
      if (/^\}\s*@else\s*\{/.test(rest)) {
        const top = stack[stack.length - 1];
        if (top) {
          top.hasElse = true;
          top.close = top.close.includes('})()}') ? '))})()}' : ')}';
        }
        out += ') : (';
        i += rest.match(/^\}\s*@else\s*\{/)[0].length;
        stack[stack.length - 1].depth = 1;
        continue;
      }
      const top = stack[stack.length - 1];
      if (top.depth <= 1) {
        out += top.close;
        stack.pop();
        i += 1;
        continue;
      }
      top.depth -= 1;
      out += '}';
      i += 1;
      continue;
    }

    if (ch === '{' && stack.length) {
      stack[stack.length - 1].depth += 1;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function repairBrokenJsxObjectLiterals(content) {
  return String(content || '').replace(
    /(\s)([A-Za-z_][\w]*)=\{(\w+\s*:\s*[^}]+)\}/g,
    '$1$2={{ $3 }}'
  );
}

function rewriteAngularJsxBindings(content) {
  let c = String(content || '');
  // Angular {{ expr }} in template text — NOT React prop={{ object }} (MUI PaperProps, sx, style, etc.)
  c = c.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr, offset, full) => {
    const before = full.slice(Math.max(0, offset - 32), offset);
    if (/=\s*$/.test(before)) return match;
    return `{${expr}}`;
  });
  c = repairBrokenJsxObjectLiterals(c);
  c = c.replace(/\bformControlName=["']([^"']+)["']/g, 'name="$1"');
  c = c.replace(/\[(\w+)\]="([^"]*)"/g, (_, prop, val) => {
    if (prop === 'formGroup') return '';
    const mapped = { opened: 'open', ngClass: 'className', class: 'className', ngStyle: 'style' }[prop] || prop;
    return `${mapped}={${val}}`;
  });
  const eventMap = {
    click: 'onClick',
    submit: 'onSubmit',
    change: 'onChange',
    input: 'onChange',
    openedChange: 'onClose',
    close: 'onClose',
    save: 'onSave',
    cancel: 'onCancel',
    edit: 'onEdit',
    remove: 'onRemove',
    delete: 'onDelete',
    ngSubmit: 'onSubmit'
  };
  c = c.replace(/\((\w+)\)="([^"]*)"/g, (_, ev, handler) => {
    const name = eventMap[ev] || `on${ev.charAt(0).toUpperCase()}${ev.slice(1)}`;
    const h = handler.replace(/\$event/g, 'event').trim();
    if (/^[\w.]+$/.test(h)) return `${name}={${h}}`;
    if (/^[\w.]+\(\)$/.test(h)) return `${name}={${h.slice(0, -2)}}`;
    return `${name}={() => ${h}}`;
  });
  c = c.replace(/(<[^>/][^>]*?)\sclass=/g, '$1 className=');
  c = c.replace(/\s\*ngIf="[^"]*"/g, '');
  c = c.replace(/\s\*ngFor="[^"]*"/g, '');
  c = c.replace(/\bcolor=["']warn["']/g, 'color="error"');
  return c;
}

function rewriteAppSelectorTags(content) {
  const imported = new Map();
  for (const m of String(content || '').matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      imported.set(name.toLowerCase(), name);
      imported.set(name.replace(/Component$/, '').toLowerCase(), name);
    }
  }
  const pascalFor = (kebab) => {
    const pascal = toPascalCase(kebab);
    return imported.get(pascal.toLowerCase()) || imported.get(kebab.replace(/-/g, '')) || pascal;
  };
  return String(content || '')
    .replace(/<app-([a-z0-9-]+)/gi, (_, k) => `<${pascalFor(k.toLowerCase())}`)
    .replace(/<\/app-([a-z0-9-]+)/gi, (_, k) => `</${pascalFor(k.toLowerCase())}`);
}

function rewriteMatTagsToMui(content) {
  let c = String(content || '');
  c = c.replace(
    /<(button|a)([^>]*?)\bmat-icon-button\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    '<IconButton$2$3>$4</IconButton>'
  );
  c = c.replace(
    /<(button|a)([^>]*?)\bmat-(?:flat|raised)-button\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    '<Button variant="contained"$2$3>$4</Button>'
  );
  c = c.replace(
    /<(button|a)([^>]*?)\bmat-stroked-button\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    '<Button variant="outlined"$2$3>$4</Button>'
  );
  c = c.replace(
    /<(button|a)([^>]*?)\bmat-button\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    '<Button$2$3>$4</Button>'
  );
  c = c.replace(/<mat-toolbar\b([^>]*)>/gi, '<AppBar position="static"$1><Toolbar>');
  c = c.replace(/<\/mat-toolbar>/gi, '</Toolbar></AppBar>');
  c = c.replace(/<mat-sidenav-container\b([^>]*)>/gi, '<Box sx={{ display: "flex", minHeight: "100vh" }}$1>');
  c = c.replace(/<\/mat-sidenav-container>/gi, '</Box>');
  c = c.replace(/<mat-sidenav-content\b([^>]*)>/gi, '<Box component="main" sx={{ flex: 1 }}$1>');
  c = c.replace(/<\/mat-sidenav-content>/gi, '</Box>');
  c = c.replace(/<mat-sidenav\b([^>]*)>/gi, (_, attrs) => {
    let a = attrs || '';
    a = a.replace(/\bposition=["']end["']/i, 'anchor="right"');
    a = a.replace(/\bposition=["']start["']/i, 'anchor="left"');
    a = a.replace(/\bmode=["']over["']/i, 'variant="temporary"');
    a = a.replace(/\bmode=["']side["']/i, 'variant="persistent"');
    a = a.replace(/\bopened=/g, 'open=');
    a = a.replace(/\[opened\]=/g, 'open=');
    return `<Drawer${a}>`;
  });
  c = c.replace(/<\/mat-sidenav>/gi, '</Drawer>');
  c = c.replace(/<mat-icon\b([^>]*)>/gi, '<Icon$1>');
  c = c.replace(/<\/mat-icon>/gi, '</Icon>');
  c = c.replace(/<mat-dialog-content\b([^>]*)>/gi, '<DialogContent$1>');
  c = c.replace(/<\/mat-dialog-content>/gi, '</DialogContent>');
  c = c.replace(/<mat-dialog-actions\b([^>]*)>/gi, '<DialogActions$1>');
  c = c.replace(/<\/mat-dialog-actions>/gi, '</DialogActions>');
  c = c.replace(/<h2\s+mat-dialog-title\b([^>]*)>([\s\S]*?)<\/h2>/gi, '<DialogTitle$1>$2</DialogTitle>');
  c = c.replace(/<mat-form-field\b([^>]*)>/gi, (_, attrs) => {
    const a = String(attrs || '').replace(/\sappearance=["'][^"']*["']/g, '');
    return `<FormControl fullWidth margin="normal"${a}>`;
  });
  c = c.replace(/<\/mat-form-field>/gi, '</FormControl>');
  c = c.replace(/<mat-label\b([^>]*)>/gi, '<InputLabel$1>');
  c = c.replace(/<\/mat-label>/gi, '</InputLabel>');
  c = c.replace(/<mat-error\b([^>]*)>/gi, '<FormHelperText error$1>');
  c = c.replace(/<\/mat-error>/gi, '</FormHelperText>');
  c = c.replace(/<mat-select\b([^>]*)>/gi, '<Select$1>');
  c = c.replace(/<\/mat-select>/gi, '</Select>');
  c = c.replace(/<mat-option\b([^>]*)>/gi, '<MenuItem$1>');
  c = c.replace(/<\/mat-option>/gi, '</MenuItem>');
  c = c.replace(/<mat-card-content\b([^>]*)>/gi, '<CardContent$1>');
  c = c.replace(/<\/mat-card-content>/gi, '</CardContent>');
  c = c.replace(/<mat-card-actions\b([^>]*)>/gi, '<CardActions$1>');
  c = c.replace(/<\/mat-card-actions>/gi, '</CardActions>');
  c = c.replace(/<mat-card-header\b([^>]*)>/gi, '<CardHeader$1>');
  c = c.replace(/<\/mat-card-header>/gi, '</CardHeader>');
  c = c.replace(/<mat-card\b([^>]*)>/gi, '<Card$1>');
  c = c.replace(/<\/mat-card>/gi, '</Card>');
  c = c.replace(/<mat-(?:progress-)?spinner\b[^>]*\/?>/gi, '<CircularProgress />');
  c = c.replace(/<mat-divider\b[^>]*\/?>/gi, '<Divider />');
  c = c.replace(/\smatInput\b/g, '');
  c = c.replace(/\smat-dialog-title\b/g, '');
  return c;
}

function camelFromDialogComponent(name) {
  const base = String(name || '').replace(/Component$/, '');
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}`;
}

function extractObjectField(objSrc, field) {
  const text = String(objSrc || '');
  const m = text.match(new RegExp(`\\b${field}\\s*:`));
  if (!m) return null;
  const start = m.index + m[0].length;
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const ch = text[i];
  if (ch === '{' || ch === '[' || ch === '(') {
    const end = findMatchingDelimiter(text, i);
    return end >= 0 ? text.slice(i, end + 1).trim() : null;
  }
  const ident = text.slice(i).match(/^[\w.$]+/);
  return ident ? ident[0] : null;
}

function rewriteAngularInjects(content) {
  let c = String(content || '');
  c = c.replace(
    /^[ \t]*(?:private|public|protected|readonly)\s+(?:readonly\s+)*(?:\w+\s*=\s*)?inject\(\s*(?:MatDialog|Store|Router)\s*\)\s*;?[ \t]*\n/gm,
    ''
  );
  c = c.replace(/^[ \t]*(?:const|let)\s+\w+\s*=\s*inject\(\s*\w+\s*\)\s*;?[ \t]*\n/gm, '');
  c = c.replace(/\binject\(\s*(?:MatDialog|Store|Router)\s*\)/g, 'undefined');
  return c;
}

function stripThisInFunctionComponents(content) {
  const text = String(content || '');
  if (!/export\s+(?:default\s+)?function\s+|=\s*\([^)]*\)\s*=>/.test(text)) return text;
  if (/export\s+class\s+/.test(text) && !/export\s+(?:default\s+)?function\s+/.test(text)) return text;
  return text.replace(/\bthis\./g, '');
}

function ensureReactHookImports(content) {
  const hooks = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef'].filter((h) =>
    new RegExp(`\\b${h}\\s*\\(`).test(content)
  );
  if (hooks.length === 0) return content;
  let c = content;
  for (const h of hooks) {
    if (new RegExp(`import\\s+[^;]*\\b${h}\\b`).test(c)) continue;
    c = ensureImport(c, h, 'react');
  }
  return c;
}

function findComponentBodyOpen(content) {
  const patterns = [
    /export\s+default\s+function\s+\w+\s*\([^)]*\)\s*\{/,
    /export\s+function\s+\w+\s*\([^)]*\)\s*\{/,
    /(?:export\s+(?:default\s+)?)?(?:const|let)\s+\w+\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*\{/
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m) return m.index + m[0].length;
  }
  return -1;
}

function insertAfterComponentBrace(content, snippet) {
  const marker = snippet.replace(/\s+/g, ' ').slice(0, 48);
  if (content.replace(/\s+/g, ' ').includes(marker.trim())) return content;
  const at = findComponentBodyOpen(content);
  if (at < 0) return content;
  return `${content.slice(0, at)}\n  ${snippet}\n${content.slice(at)}`;
}

function insertBeforeReturnClose(content, jsx) {
  const key = jsx.match(/<(\w+)/)?.[1];
  if (key && new RegExp(`<${key}\\b[^>]*\\bopen=`).test(content)) return content;
  const matches = [...content.matchAll(/return\s*\(/g)];
  if (matches.length === 0) return content;
  const last = matches[matches.length - 1];
  const parenStart = last.index + last[0].length - 1;
  const parenEnd = findMatchingDelimiter(content, parenStart);
  if (parenEnd < 0) return content;
  return `${content.slice(0, parenEnd)}\n      ${jsx}\n    ${content.slice(parenEnd)}`;
}

function convertDialogClassToFunction(content) {
  const classMatch = content.match(/export\s+class\s+(\w+)\s*\{/);
  if (!classMatch) return content;
  const name = classMatch[1];
  const braceStart = content.indexOf('{', classMatch.index + classMatch[0].length - 1);
  const braceEnd = findMatchingDelimiter(content, braceStart);
  if (braceEnd < 0) return content;
  let body = content.slice(braceStart + 1, braceEnd);
  body = body.replace(/constructor\s*\((?:[^)(]|\([^)(]*\))*\)\s*\{\s*\}/g, '');
  body = body.replace(/(?:public|private|protected|readonly)\s+(?:readonly\s+)?/g, '');
  body = body.replace(
    /(\n\s*)(\w+)\s*\(([^)]*)\)\s*(?::\s*[\w<>,\s\[\]|&]+)?\s*\{/g,
    '$1const $2 = ($3) => {'
  );
  const head = content.slice(0, classMatch.index);
  const tail = content.slice(braceEnd + 1);
  return `${head}export function ${name}({ open = false, onClose = () => {}, data } = {}) {\n${body}\n}\n${tail}`;
}

function wrapReturnWithDialog(content) {
  const idx = content.search(/return\s*\(/);
  if (idx < 0) return content;
  const parenStart = content.indexOf('(', idx);
  const parenEnd = findMatchingDelimiter(content, parenStart);
  if (parenEnd < 0) return content;
  const inner = content.slice(parenStart + 1, parenEnd);
  if (/<Dialog\b/.test(inner)) return content;
  const wrapped = `(\n    <Dialog open={Boolean(open)} onClose={() => onClose(false)}>\n      ${inner.trim()}\n    </Dialog>\n  )`;
  return content.slice(0, parenStart) + wrapped + content.slice(parenEnd + 1);
}

function ensureDialogComponentProps(content) {
  if (/function\s+\w+\s*\(\s*\{\s*open\b/.test(content)) return content;
  let c = content;
  c = c.replace(
    /export\s+(?:default\s+)?function\s+(\w+)\s*\(\s*\)/,
    'export function $1({ open = false, onClose = () => {}, data } = {})'
  );
  c = c.replace(
    /export\s+(?:default\s+)?function\s+(\w+)\s*\(\s*\{\s*([^}]*)\}\s*(?:=\s*\{\s*\})?\s*\)/,
    (_, name, props) => {
      const parts = String(props)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const names = new Set(parts.map((p) => p.split(/[:=]/)[0].trim()));
      if (!names.has('open')) parts.unshift('open = false');
      if (!names.has('onClose')) parts.push('onClose = () => {}');
      if (!names.has('data')) parts.push('data');
      return `export function ${name}({ ${parts.join(', ')} } = {})`;
    }
  );
  return c;
}

/**
 * MatDialog child: dialogRef / MAT_DIALOG_DATA → { open, onClose, data } + MUI Dialog.
 */
export function rewriteMatDialogComponent(content) {
  let c = String(content || '');
  const looksLikeDialog =
    /MatDialogRef|MAT_DIALOG_DATA|dialogRef\.close|<DialogTitle\b|<DialogContent\b|<DialogActions\b/.test(c);
  if (!looksLikeDialog) return c;
  if (/<Dialog\b/.test(c) && /\bonClose\b/.test(c) && !/dialogRef/.test(c) && !/MAT_DIALOG/.test(c)) {
    return c;
  }

  if (/export\s+class\s+\w+/.test(c)) {
    c = convertDialogClassToFunction(c);
  }
  c = c.replace(/(?:this\.)?dialogRef\.close\s*\(/g, 'onClose(');
  c = ensureDialogComponentProps(c);
  if ((/<DialogTitle\b/.test(c) || /<DialogContent\b/.test(c) || /<DialogActions\b/.test(c)) && !/<Dialog\b/.test(c)) {
    c = wrapReturnWithDialog(c);
  }
  return c;
}

/**
 * MatDialog.open(...).afterClosed() → useState + render the dialog component.
 */
export function rewriteMatDialogOpen(content) {
  let c = String(content || '');
  if (!/\.open\s*\(/.test(c)) return c;

  const injected = [];
  let searchFrom = 0;
  while (true) {
    const dot = c.indexOf('.open(', searchFrom);
    if (dot < 0) break;
    const recvStart = Math.max(0, dot - 48);
    const receiver = c.slice(recvStart, dot);
    if (!/dialog/i.test(receiver)) {
      searchFrom = dot + 5;
      continue;
    }
    const openParen = dot + 5;
    const closeParen = findMatchingDelimiter(c, openParen);
    if (closeParen < 0) break;
    const args = c.slice(openParen + 1, closeParen);
    const commaAt = (() => {
      let depth = 0;
      let inStr = null;
      let escape = false;
      for (let i = 0; i < args.length; i += 1) {
        const ch = args[i];
        if (inStr) {
          if (escape) {
            escape = false;
            continue;
          }
          if (ch === '\\') {
            escape = true;
            continue;
          }
          if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inStr = ch;
          continue;
        }
        if (ch === '(' || ch === '{' || ch === '[') depth += 1;
        else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
        else if (ch === ',' && depth === 0) return i;
      }
      return -1;
    })();
    const compName = (commaAt >= 0 ? args.slice(0, commaAt) : args).trim();
    if (!/^[A-Z]\w*$/.test(compName)) {
      searchFrom = closeParen + 1;
      continue;
    }
    const opts = commaAt >= 0 ? args.slice(commaAt + 1).trim() : '{}';
    const dataExpr = extractObjectField(opts, 'data') || 'undefined';

    let stmtStart = dot;
    while (stmtStart > 0 && /[\w.]/.test(c[stmtStart - 1])) stmtStart -= 1;
    const beforeEq = c.slice(0, stmtStart);
    const decl = beforeEq.match(/(?:const|let|var)\s+\w+\s*=\s*$/);
    if (decl) stmtStart = beforeEq.length - decl[0].length;

    const assignMatch = c.slice(Math.max(0, stmtStart - 80), dot + 6).match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:this\.)?\w+\.open\($/);
    let stmtEnd = closeParen + 1;
    const after = c.slice(closeParen + 1);
    const chained = after.match(/^\s*\.afterClosed\s*\(\s*\)\s*\.subscribe\s*\(/);
    let callback = '';
    if (chained) {
      const subParen = closeParen + 1 + chained[0].length - 1;
      const subEnd = findMatchingDelimiter(c, subParen);
      if (subEnd >= 0) {
        const rawCb = c.slice(subParen + 1, subEnd).trim();
        const arrow = rawCb.match(/^(?:\(?\s*(\w+)\s*\)?)\s*=>\s*(\{[\s\S]*\}|[\s\S]+)$/);
        callback = arrow ? rawCb : rawCb;
        stmtEnd = subEnd + 1;
        if (c[stmtEnd] === ';') stmtEnd += 1;
      }
    } else if (assignMatch) {
      const refName = assignMatch[1];
      const rest = c.slice(stmtEnd);
      const sub = rest.match(new RegExp(`^\\s*;?\\s*${refName}\\.afterClosed\\s*\\(\\s*\\)\\s*\\.subscribe\\s*\\(`));
      if (sub) {
        const subParen = stmtEnd + sub[0].length - 1;
        const subEnd = findMatchingDelimiter(c, subParen);
        if (subEnd >= 0) {
          callback = c.slice(subParen + 1, subEnd).trim();
          stmtEnd = subEnd + 1;
          if (c[stmtEnd] === ';') stmtEnd += 1;
        }
      }
    } else if (/^\s*;/.test(after)) {
      stmtEnd = closeParen + 1;
      if (c[stmtEnd] === ';') stmtEnd += 1;
    }

    const stateName = `${camelFromDialogComponent(compName)}State`;
    const setter = `set${stateName.charAt(0).toUpperCase()}${stateName.slice(1)}`;
    let onCloseBody = `() => ${setter}({ open: false, data: null })`;
    if (callback) {
      const arrow = callback.match(/^(?:\(?\s*(\w+)\s*\)?)\s*=>\s*(\{[\s\S]*\}|[\s\S]+)$/);
      if (arrow) {
        const param = arrow[1];
        let body = arrow[2].trim();
        if (body.startsWith('{')) {
          body = body.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
        } else {
          body = `void (${body});`;
        }
        onCloseBody = `(${param}) => {\n      ${setter}({ open: false, data: null });\n      ${body}\n    }`;
      } else {
        onCloseBody = `(result) => {\n      ${setter}({ open: false, data: null });\n      (${callback})(result);\n    }`;
      }
    }

    const replacement = `${setter}({\n      open: true,\n      data: ${dataExpr},\n      onClose: ${onCloseBody}\n    })`;
    c = `${c.slice(0, stmtStart)}${replacement}${c.slice(stmtEnd)}`;
    injected.push({ compName, stateName, setter });
    searchFrom = stmtStart + replacement.length;
  }

  if (injected.length === 0) return c;

  const unique = [];
  const seen = new Set();
  for (const item of injected) {
    if (seen.has(item.compName)) continue;
    seen.add(item.compName);
    unique.push(item);
  }
  for (const item of unique) {
    c = insertAfterComponentBrace(
      c,
      `const [${item.stateName}, ${item.setter}] = useState({ open: false, data: null, onClose: undefined });`
    );
    c = insertBeforeReturnClose(
      c,
      `<${item.compName} open={Boolean(${item.stateName}.open)} data={${item.stateName}.data} onClose={${item.stateName}.onClose || (() => ${item.setter}({ open: false, data: null }))} />`
    );
  }
  return c;
}

function parseTscErrors(buildErrors) {
  const byFile = new Map();
  const patterns = [
    /([^\s(:]+\.(?:tsx|ts|jsx|js))\((\d+),(\d+)\):\s*error TS(\d+):\s*([^\n]+)/g,
    /([^\s:]+\.(?:tsx|ts|jsx|js)):(\d+):(\d+)\s*-\s*error TS(\d+):\s*([^\n]+)/g
  ];
  const text = String(buildErrors || '');
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const rel = m[1].replace(/\\/g, '/').replace(/^\.?\//, '');
      const rec = { code: m[4], message: m[5] };
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(rec);
    }
  }
  return byFile;
}

function indexWorkspaceExports(destPath) {
  const map = new Map();
  const srcRoot = path.join(destPath, 'src');
  for (const file of walkFiles(srcRoot, (n) =>
    n.endsWith('.ts') || n.endsWith('.tsx') || n.endsWith('.js') || n.endsWith('.jsx')
  )) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/export\s+(?:default\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/g)) {
      if (!map.has(m[1])) map.set(m[1], file);
    }
    for (const m of content.matchAll(/export\s+\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && !map.has(name)) map.set(name, file);
      }
    }
  }
  return map;
}

const DROP_TYPE_NAMES = new Set([
  'inject', 'Injectable', 'Component', 'NgModule', 'ViewChild', 'Output', 'Input',
  'HostListener', 'ElementRef', 'ChangeDetectorRef', 'NgZone', 'AsyncPipe',
  'CommonModule', 'Store', 'MatDialog', 'MatDialogRef', 'StateContext', 'Actions',
  'Selector', 'State', 'OnInit', 'AfterViewInit', 'OnDestroy'
]);

function toKebabCase(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function srcRootFromFile(fromFile) {
  const norm = fromFile.replace(/\\/g, '/');
  const idx = norm.indexOf('/src/');
  if (idx >= 0) return norm.slice(0, idx + 4);
  return path.join(path.dirname(fromFile), '..');
}

function moduleRelFrom(fromFile, file) {
  let rel = path.relative(path.dirname(fromFile), file).replace(/\\/g, '/');
  rel = rel.replace(/\.(tsx|ts|jsx|js)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function stemMatchesWanted(stem, basename) {
  const a = String(stem || '').toLowerCase();
  const b = String(basename || '').toLowerCase();
  if (!a || !b) return 0;
  if (a === b || toKebabCase(stem) === toKebabCase(basename)) return 1;
  if (a === `${b}.model` || a.replace(/\.model$/, '') === b) return 2;
  return 0;
}

function findModuleByBasename(fromFile, basename) {
  const srcRoot = srcRootFromFile(fromFile);
  if (!fs.existsSync(srcRoot)) return null;
  let fallback = null;
  for (const file of walkFiles(srcRoot, (n) => /\.(tsx|ts|jsx|js)$/i.test(n))) {
    const stem = path.basename(file, path.extname(file));
    const score = stemMatchesWanted(stem, basename);
    if (score === 1) return moduleRelFrom(fromFile, file);
    if (score === 2 && !fallback) fallback = moduleRelFrom(fromFile, file);
  }
  return fallback;
}

function resolveRelativeModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.dirname(fromFile);
  const normalized = spec.replace(/\\/g, '/');
  const exts = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
  for (const ext of exts) {
    const candidate = path.normalize(path.join(fromDir, `${normalized}${ext}`));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      let rel = path.relative(fromDir, candidate).replace(/\\/g, '/');
      rel = rel.replace(/\.(tsx|ts|jsx|js)$/, '');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return rel;
    }
  }
  const wanted = path.basename(normalized);
  const targetDir = path.normalize(path.join(fromDir, path.dirname(normalized)));
  if (fs.existsSync(targetDir)) {
    for (const entry of fs.readdirSync(targetDir)) {
      if (!/\.(tsx|ts|jsx|js)$/i.test(entry)) continue;
      const stem = entry.replace(/\.(tsx|ts|jsx|js)$/i, '');
      if (
        stem === wanted ||
        stem.toLowerCase() === wanted.toLowerCase() ||
        toKebabCase(stem) === wanted ||
        toKebabCase(stem) === toKebabCase(wanted)
      ) {
        let rel = path.posix.join(path.dirname(normalized), stem);
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return rel;
      }
    }
  }
  return findModuleByBasename(fromFile, wanted);
}

function readModuleExportInfo(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const named = new Set();
  for (const m of content.matchAll(/export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g)) {
    named.add(m[1]);
  }
  for (const m of content.matchAll(/export\s+\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) named.add(name);
    }
  }
  const defFn = content.match(/export\s+default\s+function\s+(\w+)/);
  const defClass = content.match(/export\s+default\s+class\s+(\w+)/);
  const hasDefault = /export\s+default\b/.test(content);
  return {
    named,
    defaultName: defFn?.[1] || defClass?.[1] || null,
    hasDefault
  };
}

function resolveModuleFile(fromFile, spec) {
  const rel = resolveRelativeModule(fromFile, spec);
  if (!rel) return null;
  const fromDir = path.dirname(fromFile);
  for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
    const full = path.join(fromDir, `${rel}${ext}`);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function parseImportedBindingNames(binding) {
  const names = [];
  const raw = String(binding || '').trim();
  if (!raw || raw.startsWith('*')) return names;
  const inner = raw.startsWith('{') ? raw.slice(1, -1) : raw;
  for (const part of inner.split(',')) {
    let name = part.trim();
    if (!name) continue;
    name = name.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

function localSpecFromAlias(fromFile, spec) {
  const raw = String(spec || '').replace(/\\/g, '/');
  if (raw.startsWith('.')) return raw;
  if (raw.startsWith('@/')) {
    const abs = path.join(srcRootFromFile(fromFile), raw.slice(2));
    return moduleRelFrom(fromFile, abs);
  }
  return null;
}

function resolvePhantomDomainImport(fromFile, spec, binding, modelTypes) {
  const norm = localSpecFromAlias(fromFile, spec) || String(spec || '').replace(/\\/g, '/');
  const names = parseImportedBindingNames(binding);
  if (modelTypes instanceof Map) {
    for (const name of names) {
      const file = modelTypes.get(name);
      if (file && fs.existsSync(file)) return moduleRelFrom(fromFile, file);
    }
  }

  const hallucinatedFolder = /\/(services|types|interfaces|typings|models)\b/i.test(norm);
  if (!hallucinatedFolder && !/[\w-]+\.service$/i.test(norm)) return null;

  const candidates = [
    norm.replace(/services\/([\w-]+)\.service$/i, 'models/$1.model'),
    norm.replace(/\/(?:types|interfaces|typings)\/([^/]+)$/i, '/models/$1.model'),
    norm.replace(/\/models\/([^/.]+)$/i, '/models/$1.model')
  ];
  for (const cand of candidates) {
    if (cand === norm) continue;
    const resolved = resolveRelativeModule(fromFile, cand);
    if (resolved && resolveModuleFile(fromFile, resolved)) return resolved;
  }

  const wanted = path.basename(norm).replace(/\.(tsx|ts)$/i, '');
  const byName = /^(types|index)$/i.test(wanted)
    ? null
    : findModuleByBasename(fromFile, wanted);
  if (byName && resolveModuleFile(fromFile, byName)) return byName;

  const srcRoot = srcRootFromFile(fromFile);
  const modelsDir = path.join(srcRoot, 'models');
  if (fs.existsSync(modelsDir)) {
    for (const file of walkFiles(modelsDir, (n) => /\.(tsx|ts)$/i.test(n))) {
      return moduleRelFrom(fromFile, file);
    }
  }
  return null;
}

function resolveHookStoreModule(fromFile, spec, hookName) {
  let resolved = resolveRelativeModule(fromFile, spec);
  if (resolved && resolveModuleFile(fromFile, resolved)) return resolved;

  if (hookName?.startsWith('use') && hookName.endsWith('Store')) {
    const altSpec = spec.replace(/[^/]+$/, hookName);
    resolved = resolveRelativeModule(fromFile, altSpec);
    if (resolved && resolveModuleFile(fromFile, resolved)) return resolved;

    const srcRoot = srcRootFromFile(fromFile);
    const storeDir = path.join(srcRoot, 'store');
    if (fs.existsSync(storeDir)) {
      for (const file of walkFiles(storeDir, (n) => /\.(tsx|ts)$/i.test(n))) {
        const fileContent = fs.readFileSync(file, 'utf-8');
        if (!new RegExp(`export const ${hookName}\\s*=`).test(fileContent)) continue;
        let rel = path.relative(path.dirname(fromFile), file).replace(/\\/g, '/');
        rel = rel.replace(/\.(tsx|ts)$/, '');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return rel;
      }
    }
    const byName = findModuleByBasename(fromFile, hookName);
    if (byName && resolveModuleFile(fromFile, byName)) return byName;
  }
  return null;
}

function fixReactModuleImportsInFile(filePath, modelTypes) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;
  content = content.replace(
    /import\s*\(\s*['"](\.[^'"]+|@\/[^'"]+)['"]\s*\)/g,
    (full, spec) => {
      const localSpec = localSpecFromAlias(filePath, spec) || spec;
      let resolvedSpec = resolveRelativeModule(filePath, localSpec);
      if (!resolvedSpec || !resolveModuleFile(filePath, resolvedSpec)) {
        const hookMatch = spec.match(/(use\w+Store)/);
        if (hookMatch) resolvedSpec = resolveHookStoreModule(filePath, localSpec, hookMatch[1]);
      }
      if (!resolvedSpec || resolvedSpec === spec) return full;
      return full.replace(spec, resolvedSpec);
    }
  );
  content = content.replace(
    /import\s+(?:type\s+)?(\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](\.[^'"]+|@\/[^'"]+)['"]\s*;?/g,
    (full, binding, spec) => {
      const localSpec = localSpecFromAlias(filePath, spec) || spec;
      let resolvedSpec = resolveRelativeModule(filePath, localSpec);
      if (!resolvedSpec || !resolveModuleFile(filePath, resolvedSpec)) {
        const hookMatch =
          binding.match(/\{\s*(use\w+Store)\s*\}/) ||
          binding.match(/^(use\w+Store)$/);
        if (hookMatch) {
          resolvedSpec = resolveHookStoreModule(filePath, localSpec, hookMatch[1]);
        } else {
          resolvedSpec = resolvePhantomDomainImport(filePath, localSpec, binding, modelTypes);
        }
      }
      if (!resolvedSpec) return full;
      const targetFile = resolveModuleFile(filePath, resolvedSpec);
      if (!targetFile) return full.replace(spec, resolvedSpec);
      const info = readModuleExportInfo(targetFile);
      const typePrefix = /^import\s+type\s+/.test(full) ? 'import type ' : 'import ';
      const fixedFrom = `from '${resolvedSpec}'`;

      if (/^\{/.test(binding)) {
        const names = binding
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (names.length === 1) {
          const name = names[0].replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (info.hasDefault && info.defaultName === name && !info.named.has(name)) {
            return `${typePrefix}${name} ${fixedFrom};`;
          }
        }
        return full.replace(spec, resolvedSpec);
      }

      if (info.named.has(binding) && !info.hasDefault) {
        return `${typePrefix}{ ${binding} } ${fixedFrom};`;
      }
      return full.replace(spec, resolvedSpec);
    }
  );
  if (content !== original) {
    fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    return 1;
  }
  return 0;
}

/**
 * Fix wrong relative paths (kebab vs PascalCase) and default/named import mismatches.
 */
export function fixReactModuleImports(destPath) {
  const modelTypes = collectModelTypeExports(destPath);
  let changed = 0;
  for (const file of walkFiles(path.join(destPath, 'src'), (n) =>
    n.endsWith('.ts') || n.endsWith('.tsx') || n.endsWith('.jsx') || n.endsWith('.js')
  )) {
    changed += fixReactModuleImportsInFile(file, modelTypes);
  }
  if (changed > 0) {
    console.log(`[postprocess] Fixed module imports in ${changed} React file(s)`);
  }
  return changed;
}

function collectModelTypeExports(destPath) {
  const modelTypes = new Map();
  for (const file of walkFiles(path.join(destPath, 'src'), (name, full) =>
    /(^|\/)models?\//.test(full.replace(/\\/g, '/')) || /\.model\.(ts|tsx)$/i.test(name)
  )) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const m of content.matchAll(/export\s+(?:interface|type|const|enum)\s+(\w+)/g)) {
      modelTypes.set(m[1], file);
    }
  }
  return modelTypes;
}

function stripExportedTypeBlock(content, typeName) {
  let c = content;
  c = c.replace(
    new RegExp(`export\\s+interface\\s+${typeName}\\s*(?:extends\\s+[^{]+)?\\{[\\s\\S]*?\\}\\s*\\n?`, 'g'),
    ''
  );
  c = c.replace(new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*[^;]+;\\s*\\n?`, 'g'), '');
  return c;
}

/**
 * Store files must not re-declare model types — import from src/models instead.
 */
export function dedupeStoreModelTypes(destPath) {
  const modelTypes = collectModelTypeExports(destPath);
  if (modelTypes.size === 0) return 0;
  let changed = 0;
  for (const file of walkFiles(path.join(destPath, 'src'), (name, full) =>
    /(^|\/)store\//.test(full.replace(/\\/g, '/')) && /\.(ts|tsx)$/.test(name)
  )) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;
    const toImport = new Set();
    for (const [typeName, modelFile] of modelTypes) {
      if (!new RegExp(`export\\s+(?:interface|type)\\s+${typeName}\\b`).test(content)) continue;
      content = stripExportedTypeBlock(content, typeName);
      toImport.add(typeName);
      const draftName = `${typeName}Draft`;
      if (modelTypes.has(draftName)) toImport.add(draftName);
    }
    if (toImport.size > 0) {
      for (const sym of [...toImport]) {
        if (!new RegExp(`\\b${sym}\\b`).test(content)) toImport.delete(sym);
      }
      for (const sym of toImport) {
        const modelFile = modelTypes.get(sym);
        if (!modelFile) continue;
        content = ensureImport(content, sym, relativeModulePath(file, modelFile));
      }
    }
    content = content.replace(/\n{3,}/g, '\n\n');
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
      changed += 1;
    }
  }
  if (changed > 0) {
    console.log(`[postprocess] Deduped model types in ${changed} store file(s)`);
  }
  return changed;
}

function readTaskInterfaceShape(destPath) {
  const src = path.join(destPath, 'src');
  const candidates = [
    ...walkFiles(src, (name) => /\.model\.(ts|tsx)$/i.test(name)),
    ...walkFiles(path.join(src, 'models'), (name) => /\.(ts|tsx)$/i.test(name))
  ];
  const seen = new Set();
  for (const file of candidates) {
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const content = fs.readFileSync(file, 'utf-8');
    const iface = content.match(/export interface (\w+)\s*\{([\s\S]*?)\}/);
    if (!iface) continue;
    const typeName = iface[1];
    const fields = new Set([...iface[2].matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]));
    const statusMatch =
      content.match(new RegExp(`export type (${typeName}Status)\\s*=\\s*([^;]+);`)) ||
      content.match(/export type (\w+Status)\s*=\s*([^;]+);/);
    const statusTypeName = statusMatch?.[1] || '';
    const statusType = statusMatch?.[2] || '';
    return {
      file,
      typeName,
      statusTypeName,
      fields,
      hasStatus: fields.has('status'),
      hasCompleted: fields.has('completed'),
      statusType,
      usesHyphenStatus: statusType.includes("'in-progress'") && !statusType.includes('in_progress'),
      modelImportHint: path.basename(file).replace(/\.(tsx|ts)$/i, ''),
      draftName: new RegExp(`export type ${typeName}Draft\\b`).test(content) ? `${typeName}Draft` : null
    };
  }
  return null;
}

const INVENTED_TASK_FIELDS = [
  'completed',
  'priority',
  'dueDate',
  'due',
  'assignee',
  'tags',
  'category'
];

function stripUnknownTaskFieldsInFile(content, shape) {
  if (!shape?.fields) return content;
  let c = String(content || '');
  const unknown = INVENTED_TASK_FIELDS.filter((f) => !shape.fields.has(f));
  if (unknown.length === 0) {
    return c.replace(/;\s*\|[^;\n]+;/g, ';');
  }

  for (const field of unknown) {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    c = c.replace(new RegExp(`^\\s*const \\[${field}, set${cap}\\][^\\n]+\\n`, 'gm'), '');
    c = c.replace(new RegExp(`\\s*set${cap}\\([^)]*\\);\\n`, 'g'), '');
    c = c.replace(new RegExp(`^\\s*${field}\\??\\s*:[^;\\n]+;\\s*\\n`, 'gm'), '');
    c = c.replace(new RegExp(`,?\\s*${field}\\??\\s*:\\s*[^,}\\n]+`, 'g'), '');
    c = c.replace(new RegExp(`\\s*<th[^>]*>\\s*${cap}\\s*</th>\\s*`, 'gi'), '');
    c = c.replace(
      new RegExp(
        `\\s*<td[^>]*>\\s*<span[\\s\\S]*?\\{\\w+\\.${field}\\}[\\s\\S]*?</span>\\s*</td>\\s*`,
        'g'
      ),
      ''
    );
    c = c.replace(
      new RegExp(
        `\\n\\s*<div>\\s*\\n\\s*<label[^>]*>\\s*\\n\\s*${cap}[\\s\\S]*?</select>\\s*\\n\\s*</div>`,
        'g'
      ),
      ''
    );
    // Drop member access as a whole (`task.priority` → `task`), never leave `task.`.
    c = c.replace(new RegExp(`\\.${field}\\b`, 'g'), '');
    c = c.replace(new RegExp(`(?:,\\s*)?(?<!\\.)\\b${field}\\b(?=\\s*[,}])`, 'g'), '');
  }
  c = c.replace(/;\s*\|[^;\n]+;/g, ';');
  c = c.replace(/\{\s*(\w+)\.\s*\}/g, '{$1}');
  c = c.replace(/(\w+)\.\s*(?=[,};)])/g, '$1');
  c = c.replace(/\{\s*,/g, '{');
  c = c.replace(/,\s*(\n\s*\})/g, '$1');
  return c;
}

function sourceAppIsRouterShell(sourceFilesMap) {
  if (!sourceFilesMap || typeof sourceFilesMap !== 'object') return false;
  let ts = '';
  let html = '';
  for (const [rel, content] of Object.entries(sourceFilesMap)) {
    const n = String(rel).replace(/\\/g, '/');
    if (/(^|\/)app\.component\.ts$/i.test(n)) ts = String(content || '');
    if (/(^|\/)app\.component\.html$/i.test(n)) html = String(content || '');
  }
  const htmlBody = html.replace(/<!--[\s\S]*?-->/g, '').trim();
  const htmlIsOutlet =
    /<router-outlet\b/i.test(htmlBody) &&
    !/<[a-z][\w-]*/i.test(htmlBody.replace(/<router-outlet\b[^>]*\/?>/gi, ''));
  const classEmpty = /export class AppComponent\s*\{\s*\}/.test(ts);
  return htmlIsOutlet || (/RouterOutlet/.test(ts) && classEmpty);
}

function appHasBrokenSyntax(existing) {
  return (
    /;\s*\|/.test(existing) ||
    /\{\s*\w+\.\s*\}/.test(existing) ||
    /\w+\.\s*[,};)]/.test(existing) ||
    !/\breturn\b/.test(existing)
  );
}

function appAlreadyThinRouter(existing, pageIdent) {
  const lines = existing.split('\n').length;
  const importsPage = new RegExp(`from\\s+['"][^'"]*${pageIdent}['"]`).test(existing);
  const rendersPage = new RegExp(`<${pageIdent}\\b`).test(existing);
  return (
    lines <= 40 &&
    importsPage &&
    rendersPage &&
    /react-router-dom/.test(existing) &&
    !/(?:export\s+)?(?:interface|type)\s+Task\b/.test(existing) &&
    !appHasBrokenSyntax(existing)
  );
}

/**
 * Angular AppComponent is a router outlet. If a page exists, App.tsx must mount it —
 * never keep a hallucinated second domain model or a broken interface in App.
 */
export function ensureReactAppShell(destPath, sourceFilesMap = null, options = {}) {
  const src = path.join(destPath, 'src');
  const pagesDir = path.join(src, 'pages');
  if (!fs.existsSync(pagesDir)) return 0;
  const pageFiles = walkFiles(pagesDir, (n) => n.endsWith('.tsx'));
  if (pageFiles.length === 0) return 0;

  const preferred = pageFiles[0];
  const appPath = path.join(src, 'App.tsx');
  const existing = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf-8') : '';
  const info = readModuleExportInfo(preferred);
  const fallbackName = path.basename(preferred, path.extname(preferred));
  const ident =
    info.defaultName || [...info.named][0] || fallbackName;

  const force = options.force === true;
  const mountsPage =
    new RegExp(`from\\s+['"][^'"]*${ident}['"]`).test(existing) &&
    new RegExp(`<${ident}\\b`).test(existing);
  const iface = existing.match(/(?:export\s+)?(?:interface|type)\s+(\w+)\s*\{/);
  const hallucinated =
    (iface && !/Props$/.test(iface[1])) ||
    existing.split('\n').length > 80;
  if (!force && appAlreadyThinRouter(existing, ident)) return 0;
  if (
    !force &&
    !sourceAppIsRouterShell(sourceFilesMap) &&
    mountsPage &&
    !appHasBrokenSyntax(existing) &&
    !hallucinated
  ) {
    return 0;
  }

  const rel = relativeModulePath(appPath, preferred);
  const importLine = info.hasDefault
    ? `import ${ident} from '${rel}';`
    : `import { ${ident} } from '${rel}';`;
  const shell = `import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
${importLine}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<${ident} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
`;
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
  fs.writeFileSync(appPath, shell, 'utf-8');
  console.log(`[postprocess] Wrote App.tsx shell mounting ${path.relative(src, preferred)}`);
  return 1;
}

function alignTaskStatusLiteralsInFile(content, shape) {
  const lits = [...String(shape?.statusType || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (lits.length === 0) return content;
  let c = String(content || '');
  for (const lit of lits) {
    const underscored = lit.replace(/-/g, '_');
    if (underscored !== lit) {
      c = c.replace(new RegExp(underscored.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), lit);
    }
  }
  const statusName = shape.statusTypeName;
  const modelHint = String(shape.modelImportHint || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionsStatus = statusName && new RegExp(`\\b${statusName}\\b`).test(c);
  const mentionsModel = modelHint && new RegExp(`from ['"][^'"]*${modelHint}['"]`).test(c);
  if (statusName && (mentionsStatus || mentionsModel)) {
    const union = lits.map((l) => `'${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).join('\\s*\\|\\s*');
    c = c.replace(new RegExp(`useState<\\s*${union}\\s*>`, 'g'), `useState<${statusName}>`);
    if (new RegExp(`useState<${statusName}>`).test(c) && !new RegExp(`import[^;]*\\b${statusName}\\b`).test(c)) {
      const modelRe = modelHint || '[^\'"]+';
      c = c.replace(
        new RegExp(`(import\\s+\\{[^}]*)(}\\s+from\\s+['"][^'"]*${modelRe}['"])`),
        (full, head, tail) =>
          new RegExp(`\\b${statusName}\\b`).test(head) ? full : `${head}, ${statusName}${tail}`
      );
    }
  }
  return c;
}

/** Normalize status literals (in_progress → in-progress) to match the copied source model. */
export function alignTaskStatusLiterals(destPath) {
  const shape = readTaskInterfaceShape(destPath);
  if (!shape?.statusType) return 0;
  let changed = 0;
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.tsx') || n.endsWith('.ts'))) {
    let content = fs.readFileSync(file, 'utf-8');
    const fixed = alignTaskStatusLiteralsInFile(content, shape);
    if (fixed !== content) {
      fs.writeFileSync(file, fixed.endsWith('\n') ? fixed : `${fixed}\n`, 'utf-8');
      changed += 1;
    }
  }
  if (changed > 0) {
    console.log(`[postprocess] Aligned status literals in ${changed} file(s)`);
  }
  return changed;
}

function hookFileBase(hookName) {
  const rest = String(hookName || '').replace(/^use/, '');
  if (!rest) return 'appStore';
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

function buildScaffoldStoreContent({ modelImport, typeName, draftName, hookName }) {
  const typed = Boolean(typeName && modelImport);
  const draft = draftName || typeName;
  const stateName = typed ? `${typeName}StoreState` : 'StoreState';
  const addName = typed ? `add${typeName}` : 'add';
  const updateName = typed ? `update${typeName}` : 'update';
  const deleteName = typed ? `delete${typeName}` : 'remove';
  const idExpr =
    'typeof crypto !== \'undefined\' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()';
  if (!typed) {
    return `import { create } from 'zustand';

export const ${hookName} = create((set) => ({
  items: [],
  add: (draft) => {
    const row = { ...draft, id: ${idExpr} };
    set((state) => ({ items: [...state.items, row] }));
  },
  update: (row) => {
    set((state) => ({
      items: state.items.map((item) => (item.id === row.id ? row : item))
    }));
  },
  remove: (id) => {
    set((state) => ({
      items: state.items.filter((item) => item.id !== id)
    }));
  }
}));
`;
  }
  const draftImport = draft && draft !== typeName ? `, ${draft}` : '';
  return `import { create } from 'zustand';
import { ${typeName}${draftImport} } from '${modelImport}';

export interface ${stateName} {
  items: ${typeName}[];
  ${addName}: (draft: ${draft}) => void;
  ${updateName}: (row: ${typeName}) => void;
  ${deleteName}: (id: string) => void;
}

export const ${hookName} = create<${stateName}>((set) => ({
  items: [],

  ${addName}: (draft: ${draft}) => {
    const row: ${typeName} = {
      ...draft,
      id: ${idExpr}
    };
    set((state) => ({ items: [...state.items, row] }));
  },

  ${updateName}: (row: ${typeName}) => {
    set((state) => ({
      items: state.items.map((item) => (item.id === row.id ? row : item))
    }));
  },

  ${deleteName}: (id: string) => {
    set((state) => ({
      items: state.items.filter((item) => item.id !== id)
    }));
  }
}));
`;
}

/** Create a missing zustand store when a barrel re-exports a non-existent module. */
export function ensureZustandStoreScaffold(destPath) {
  if (findZustandStoreFiles(destPath).length > 0) return 0;
  const srcRoot = path.join(destPath, 'src');
  const sources = walkFiles(srcRoot, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
    .map((f) => fs.readFileSync(f, 'utf-8'))
    .join('\n');
  const hookMatch = sources.match(/\b(use[A-Z]\w*Store)\b/);
  if (!hookMatch) return 0;
  const hookName = hookMatch[1];
  const fileBase = hookFileBase(hookName);
  const storePath = path.join(srcRoot, 'store', `${fileBase}.ts`);
  const barrelPath = path.join(srcRoot, 'store', `${hookName}.ts`);
  const shape = readTaskInterfaceShape(destPath);
  const modelImport = shape?.file
    ? path.relative(path.dirname(storePath), shape.file).replace(/\\/g, '/').replace(/\.(tsx|ts)$/i, '')
    : null;
  if (!fs.existsSync(storePath)) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      buildScaffoldStoreContent({
        modelImport: modelImport && !modelImport.startsWith('.') ? `./${modelImport}` : modelImport,
        typeName: shape?.typeName || null,
        draftName: shape?.draftName || null,
        hookName
      }),
      'utf-8'
    );
    console.log(`[postprocess] Scaffolded missing zustand store: src/store/${fileBase}.ts`);
  }

  const barrelLine = `export { ${hookName} } from './${fileBase}';\n`;
  if (fs.existsSync(barrelPath)) {
    const barrel = fs.readFileSync(barrelPath, 'utf-8');
    if (
      !new RegExp(`^export\\s+\\{\\s*${hookName}\\s*\\}\\s+from\\s+['"]\\./${fileBase}['"]`).test(
        barrel.trim()
      ) &&
      /^export\s+\{/.test(barrel.trim()) &&
      !new RegExp(`export const ${hookName}`).test(barrel)
    ) {
      fs.writeFileSync(barrelPath, barrelLine, 'utf-8');
    }
  } else {
    fs.mkdirSync(path.dirname(barrelPath), { recursive: true });
    fs.writeFileSync(barrelPath, barrelLine, 'utf-8');
  }
  return 1;
}

/**
 * Overwrite dest models from the Angular source, and write a zustand store
 * from source NGXS @State when the converted app has no real create() export.
 */
export function pinSourceDomainArtifacts(destPath, sourceFilesMap) {
  if (!sourceFilesMap || typeof sourceFilesMap !== 'object') return 0;
  let changed = 0;
  const modelsDir = path.join(destPath, 'src', 'models');

  for (const [rel, content] of Object.entries(sourceFilesMap)) {
    const norm = String(rel).replace(/\\/g, '/');
    if (!/(^|\/)models\/.+\.ts$/i.test(norm) && !/\.model\.ts$/i.test(norm)) continue;
    if (typeof content !== 'string' || !content.trim()) continue;
    fs.mkdirSync(modelsDir, { recursive: true });
    const dest = path.join(modelsDir, path.basename(norm));
    const body = content.endsWith('\n') ? content : `${content}\n`;
    fs.writeFileSync(dest, body, 'utf-8');
    changed += 1;
    console.log(`[postprocess] Pinned source model: src/models/${path.basename(norm)}`);
  }

  if (findZustandStoreFiles(destPath).length === 0) {
    for (const [rel, content] of Object.entries(sourceFilesMap)) {
      const norm = String(rel).replace(/\\/g, '/');
      if (!/\.state\.ts$/i.test(norm) || !/@State/.test(String(content || ''))) continue;
      const converted = rewriteNgxsStateToZustand(content);
      const hookMatch = converted.match(/export const (use\w+Store)\s*=\s*create/);
      if (!hookMatch) continue;
      const hookName = hookMatch[1];
      const fileBase = hookFileBase(hookName);
      const storePath = path.join(destPath, 'src', 'store', `${fileBase}.ts`);
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const out = converted.replace(
        /from\s+['"][^'"]*models\/([^'"]+)['"]/g,
        "from '../models/$1'"
      );
      fs.writeFileSync(storePath, out.endsWith('\n') ? out : `${out}\n`, 'utf-8');
      fs.writeFileSync(
        path.join(destPath, 'src', 'store', `${hookName}.ts`),
        `export { ${hookName} } from './${fileBase}';\n`,
        'utf-8'
      );
      changed += 1;
      console.log('[postprocess] Wrote zustand store from source NGXS state');
      break;
    }
  }
  return changed;
}

function fixTaskModelFieldMismatchesInFile(content, shape) {
  if (!shape) return content;
  let c = String(content || '');
  c = stripUnknownTaskFieldsInFile(c, shape);
  if (!shape.hasStatus || shape.hasCompleted) return c;
  const typeName = shape.typeName || '';
  if (!typeName || !new RegExp(`(?:import\\s+[^;]*\\b${typeName}\\b|:\\s*${typeName}\\b|${typeName}\\[\\])`).test(c)) {
    return c;
  }

  const doneLit =
    [...String(shape.statusType || '').matchAll(/'([^']+)'/g)]
      .map((m) => m[1])
      .find((l) => /done|complete/i.test(l)) || 'done';

  c = c.replace(/,?\s*completed\s*:\s*(?:true|false|null|undefined)\s*(?=,|\n|\})/g, '');
  c = c.replace(/(\w+)\.completed\b/g, `($1.status === '${doneLit}')`);
  c = c.replace(/\bcompleted\s*=\{([^}]+)\.completed\}/g, `data-status={$1.status === '${doneLit}'}`);
  c = c.replace(/\{\s*,/g, '{');
  c = c.replace(/,\s*(\n\s*\})/g, '$1');
  return c;
}

/** Drop invented fields when the canonical source model uses a different shape. */
export function fixTaskModelFieldMismatches(destPath) {
  const shape = readTaskInterfaceShape(destPath);
  if (!shape) return 0;
  let changed = 0;
  for (const file of walkFiles(path.join(destPath, 'src'), (n) =>
    n.endsWith('.tsx') || n.endsWith('.ts')
  )) {
    if (shape.file && path.resolve(file) === path.resolve(shape.file)) continue;
    let content = fs.readFileSync(file, 'utf-8');
    const fixed = fixTaskModelFieldMismatchesInFile(content, shape);
    if (fixed !== content) {
      fs.writeFileSync(file, fixed.endsWith('\n') ? fixed : `${fixed}\n`, 'utf-8');
      changed += 1;
    }
  }
  if (changed > 0) {
    console.log(`[postprocess] Aligned model fields in ${changed} file(s)`);
  }
  return changed;
}

/**
 * Remove orphaned NGXS shard files (task.state.ts / task.actions.ts) when unused.
 */
export function removeUnusedStoreShards(destPath) {
  const srcRoot = path.join(destPath, 'src');
  const sources = walkFiles(srcRoot, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
    .map((f) => fs.readFileSync(f, 'utf-8'))
    .join('\n');
  let removed = 0;
  for (const file of walkFiles(path.join(srcRoot, 'store'), (n, full) => {
    const rel = full.replace(/\\/g, '/');
    // NGXS shards live under store/<module>/<module>.state.ts — not top-level store/*.ts
    return /\/store\/[^/]+\/[^/]+\.(state|actions)\.ts$/i.test(rel);
  })) {
    const relImport = path
      .relative(srcRoot, file)
      .replace(/\\/g, '/')
      .replace(/\.ts$/, '');
    const patterns = [
      relImport,
      path.basename(file, '.ts'),
      path.basename(file, '.state.ts'),
      path.basename(file, '.actions.ts')
    ];
    const referenced = patterns.some((p) => new RegExp(`['"][^'"]*${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(sources));
    if (!referenced) {
      try {
        fs.unlinkSync(file);
        removed += 1;
        console.log(`[postprocess] Removed unused store shard: ${path.relative(destPath, file)}`);
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

function stripUnusedReactDefaultImport(content) {
  const usesReact = /React\.[A-Za-z]|<React[\s./]|\bReact\.FC\b/.test(content);
  if (usesReact) return content;
  let c = String(content || '');
  if (/import\s+React\s+from\s+['"]react['"]/.test(c)) {
    c = c.replace(/import\s+React\s+from\s+['"]react['"]\s*;?\s*\n?/, '');
  }
  if (/import\s+React\s*,\s*\{/.test(c)) {
    c = c.replace(/import\s+React\s*,\s*(\{[^}]+\})\s+from\s+['"]react['"]\s*;?/, 'import $1 from \'react\';');
  }
  return c;
}

function pruneUnusedNamedImports(content) {
  return String(content || '').replace(
    /import\s+\{([^}]+)\}\s+from\s+(['"][^'"]+['"])\s*;?/g,
    (full, names, fromPart) => {
      const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
      const without = content.replace(full, '');
      const kept = parts.filter((part) => {
        const name = part.split(/\s+as\s+/).pop()?.trim();
        if (!name || name === 'type') return true;
        return new RegExp(`\\b${name}\\b`).test(without);
      });
      if (kept.length === 0) return '';
      if (kept.length === parts.length) return full;
      return `import { ${kept.join(', ')} } from ${fromPart};`;
    }
  );
}

function removeAngularLeftoverReactFiles(destPath) {
  const candidates = walkFiles(path.join(destPath, 'src'), (n) =>
    /^app\.config\.(ts|tsx)$/.test(n) || /^main\.ts$/.test(n)
  );
  let removed = 0;
  for (const file of candidates) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const isAngular =
      /ApplicationConfig|provideZoneChangeDetection|provideRouter|@angular\/|bootstrapApplication/.test(content);
    if (!isAngular) continue;
    try {
      fs.unlinkSync(file);
      removed += 1;
      console.log(`[postprocess] Removed Angular leftover: ${path.relative(destPath, file)}`);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function stripAngularTestDepsFromReactPackage(destPath) {
  const pkgPath = path.join(destPath, 'package.json');
  const pkg = readJsonSafe(pkgPath);
  if (!pkg?.dependencies) return 0;
  const drop = [
    '@types/jasmine', 'jasmine-core', 'karma', 'karma-chrome-launcher',
    'karma-coverage', 'karma-jasmine', 'karma-jasmine-html-reporter'
  ];
  let removed = 0;
  for (const name of drop) {
    if (pkg.dependencies[name]) {
      delete pkg.dependencies[name];
      removed += 1;
    }
    if (pkg.devDependencies?.[name]) {
      delete pkg.devDependencies[name];
      removed += 1;
    }
  }
  if (removed) writeJson(pkgPath, pkg);
  return removed;
}

/**
 * Fix leftover Angular identifiers, missing React hooks, and missing local imports
 * from tsc output — no AI required.
 */
export function fixReactTypeErrors(destPath, buildErrors) {
  const errorText = String(buildErrors || '');
  let changedFiles = 0;
  if (/Types of property/.test(errorText) && /\/models\//.test(errorText) && /\/store\//.test(errorText)) {
    changedFiles += dedupeStoreModelTypes(destPath);
  }
  if (/Cannot find module/.test(errorText) || /Did you mean to use 'import/.test(errorText)) {
    changedFiles += fixReactModuleImports(destPath);
  }
  if (/Individual declarations in merged declaration 'use\w+Store'/.test(errorText)) {
    changedFiles += consolidateDuplicateZustandStores(destPath);
  }
  if (
    /Property 'open' is missing/.test(errorText) ||
    /Property 'open' does not exist/.test(errorText) ||
    /Property 'onClose' does not exist/.test(errorText) ||
    /Property 'onConfirm' does not exist/.test(errorText) ||
    /TS2741/.test(errorText) ||
    /TS2322/.test(errorText)
  ) {
    changedFiles += syncComponentCallSiteProps(destPath);
  }
  if (
    /\bstate\.\w+\b/.test(errorText) ||
    /Property '\w+' does not exist/.test(errorText) ||
    /Cannot redeclare block-scoped variable/.test(errorText) ||
    /TS7006.*state/.test(errorText) ||
    /TS2451/.test(errorText)
  ) {
    changedFiles += fixZustandSelectorFields(destPath);
    changedFiles += fixZustandHookUsage(destPath);
  }
  if (/Cannot find module.*[Ss]tore/.test(errorText)) {
    changedFiles += fixReactModuleImports(destPath);
    changedFiles += fixZustandHookUsage(destPath);
  }
  if (
    /TS2353/.test(errorText) ||
    /TS2339/.test(errorText) ||
    /Object literal may only specify known properties/.test(errorText)
  ) {
    changedFiles += fixTaskModelFieldMismatches(destPath);
  }
  if (/is not assignable to type '\w+Status'/.test(errorText) || /TS2322/.test(errorText)) {
    changedFiles += alignTaskStatusLiterals(destPath);
  }
  if (/Cannot find module.*service/.test(errorText) || /\.service/.test(errorText)) {
    changedFiles += fixReactModuleImports(destPath);
  }
  if (/Cannot find module.*\w+Store/.test(errorText) || /'\.\/\w+Store'/.test(errorText)) {
    changedFiles += ensureZustandStoreScaffold(destPath);
    changedFiles += fixReactModuleImports(destPath);
    changedFiles += fixZustandHookUsage(destPath);
  }
  if (
    /App\.tsx/.test(errorText) &&
    /TS1003|TS1005|TS1109|TS1128|TS1131|TS1161|Identifier expected|Expression expected|Property or signature expected/.test(
      errorText
    )
  ) {
    changedFiles += ensureReactAppShell(destPath, null, { force: true });
  } else if (
    /TS1131|TS1109|TS1128|TS1005|TS1003/.test(errorText) ||
    /Property or signature expected|Identifier expected/.test(errorText)
  ) {
    changedFiles += ensureReactAppShell(destPath);
  }
  if (/TS6133.*React/.test(errorText)) {
    for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.tsx') || n.endsWith('.ts'))) {
      let content = fs.readFileSync(file, 'utf-8');
      const patched = stripUnusedReactDefaultImport(content);
      if (patched !== content) {
        fs.writeFileSync(file, patched.endsWith('\n') ? patched : `${patched}\n`, 'utf-8');
        changedFiles += 1;
      }
    }
  }

  const byFile = parseTscErrors(buildErrors);
  if (byFile.size === 0) return changedFiles;
  const exportIndex = indexWorkspaceExports(destPath);
  const hookNames = new Set(['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer', 'useId']);

  for (const [rel, errors] of byFile) {
    const full = path.isAbsolute(rel) ? rel : path.join(destPath, rel.replace(/^.*?\/src\//, 'src/'));
    const candidates = [
      full,
      path.join(destPath, rel),
      path.join(destPath, rel.replace(/^.*?(src\/)/, '$1'))
    ];
    const filePath = candidates.find((p) => fs.existsSync(p));
    if (!filePath) continue;
    let content = fs.readFileSync(filePath, 'utf-8');
    const original = content;
    const hasJsxParseError = errors.some((e) =>
      ['1381', '1382', '17002', '1005', '1109', '1128', '2657'].includes(String(e.code))
    );
    if (hasJsxParseError) {
      content = repairBrokenJsxObjectLiterals(content);
    }

    const missingHooks = [];
    for (const err of errors) {
      const nameMatch = err.message.match(/Cannot find name '(\w+)'/);
      const memberMatch = err.message.match(/has no exported member '(\w+)'/);
      const modMatch = err.message.match(/Module ['"]([^'"]+)['"] has no exported member/);
      if (err.code === '2304' && nameMatch) {
        const name = nameMatch[1];
        if (hookNames.has(name)) missingHooks.push(name);
        else if (DROP_TYPE_NAMES.has(name)) {
          content = content.replace(new RegExp(`\\b${name}\\b`, 'g'), (hit, offset) => {
            const slice = content.slice(Math.max(0, offset - 20), offset);
            if (/import\s+[^;]*$/.test(slice) || /from\s+['"][^'"]*$/.test(slice)) return hit;
            if (name === 'inject') return 'undefined';
            return hit;
          });
          if (name === 'inject') {
            content = content.replace(/^[ \t]*(?:const|let|var|[a-z].*=\s*)inject\([^)]*\)\s*;?[ \t]*\n/gm, '');
            content = content.replace(/\binject\([^)]*\)/g, 'undefined');
          }
        } else if (exportIndex.has(name)) {
          const from = relativeModulePath(filePath, exportIndex.get(name));
          content = ensureImport(content, name, from);
        }
      }
      if ((err.code === '2305' || err.code === '2614') && memberMatch) {
        const member = memberMatch[1];
        const spec = modMatch?.[1] || '';
        if (spec.startsWith('.')) {
          const fixedSpec = resolveRelativeModule(filePath, spec);
          const target = fixedSpec ? resolveModuleFile(filePath, fixedSpec) : null;
          if (target) {
            const info = readModuleExportInfo(target);
            if (info.hasDefault && info.defaultName === member) {
              content = content.replace(
                new RegExp(`import\\s+\\{\\s*${member}\\s*\\}\\s+from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
                `import ${member} from '${fixedSpec}'`
              );
              continue;
            }
          }
        }
        if (spec) content = removeNamedImport(content, member, spec);
        else {
          content = content.replace(
            new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]+['"]`, 'g'),
            (fullImp, names) => {
              if (!names.includes(member)) return fullImp;
              return fullImp.replace(new RegExp(`\\b${member}\\b\\s*,?\\s*`), '').replace(/,\s*\}/, ' }');
            }
          );
        }
      }
    }
    for (const h of missingHooks) content = ensureImport(content, h, 'react');
    if (/\bthis\./.test(content) && /export\s+(?:default\s+)?function\s+/.test(content)) {
      content = content.replace(/\bthis\./g, '');
    }
    content = content.replace(/: Observable<([^>]+)>/g, ': $1');
    content = rewriteReactAngularLeftovers(content);
    content = stripUnusedReactDefaultImport(content);

    if (content !== original) {
      fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
      changedFiles += 1;
    }
  }
  return changedFiles;
}

function ensureMuiNamedImports(content) {
  const used = MUI_JSX_NAMES.filter((name) => new RegExp(`<${name}\\b`).test(content));
  if (used.length === 0) return content;
  if (/from\s+['"]@mui\/material['"]/.test(content)) {
    return content.replace(
      /import\s+\{([^}]*)\}\s+from\s+['"]@mui\/material['"]/,
      (full, inner) => {
        const have = new Set(
          String(inner)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        used.forEach((n) => have.add(n));
        return `import { ${[...have].join(', ')} } from '@mui/material'`;
      }
    );
  }
  return `import { ${used.join(', ')} } from '@mui/material';\n${content}`;
}

/**
 * Rewrite leftover Angular / NGXS / Material APIs in a React source file.
 */
export function rewriteReactAngularLeftovers(content) {
  let c = String(content || '');
  c = c.replace(/from\s+['"]lucide-angular['"]/g, "from 'lucide-react'");
  c = c.replace(/from\s+['"]@lucide\/angular['"]/g, "from 'lucide-react'");
  c = rewriteNgxsStateToZustand(c);
  c = rewriteNgxsDispatchAndSelect(c);
  c = rewriteNgxsActionFile(c);
  c = rewriteMatDialogOpen(c);
  c = rewriteAngularInjects(c);
  c = stripThisInFunctionComponents(c);
  c = c.replace(/from\s+(['"])([^'"]+)\.component(?:\.js)?\1/g, 'from $1$2$1');
  c = rewriteAppSelectorTags(c);
  c = rewriteAngularControlFlow(c);
  c = rewriteMatTagsToMui(c);
  c = rewriteAngularJsxBindings(c);
  c = rewriteMatDialogComponent(c);
  c = c.replace(/import\s+[^;]*from\s+['"]@angular\/[^'"]+['"]\s*;?\s*/g, '');
  c = c.replace(/import\s+[^;]*from\s+['"]@ngxs\/[^'"]+['"]\s*;?\s*/g, '');
  c = ensureMuiNamedImports(c);
  c = ensureReactHookImports(c);
  c = c.replace(/templateUrl\s*:\s*['"][^'"]+['"]\s*,?/g, '');
  c = c.replace(/styleUrl(?:s)?\s*:\s*(?:['"][^'"]+['"]|\[[^\]]+\])\s*,?/g, '');
  return c;
}

function ensureReactPackagesFromImports(destPath, sourceStack = {}) {
  const pkgPath = path.join(destPath, 'package.json');
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return 0;
  pkg.dependencies = pkg.dependencies || {};

  let added = 0;
  const imported = collectBareImportPackages(destPath);
  if (sourceStack.material) {
    imported.add('@mui/material');
    imported.add('@emotion/react');
    imported.add('@emotion/styled');
  }
  if (sourceStack.ngxs) imported.add('zustand');
  if (sourceStack.lucide) imported.add('lucide-react');

  for (const spec of imported) {
    if (spec.startsWith('@angular/') || spec.startsWith('@ngxs/')) {
      delete pkg.dependencies[spec];
      continue;
    }
    const version = REACT_KNOWN_PACKAGES[spec];
    if (!version) continue;
    if (!pkg.dependencies[spec] && !pkg.devDependencies?.[spec]) {
      pkg.dependencies[spec] = version;
      added += 1;
    }
  }

  // MUI always needs emotion peers
  if (pkg.dependencies['@mui/material']) {
    if (!pkg.dependencies['@emotion/react']) pkg.dependencies['@emotion/react'] = REACT_KNOWN_PACKAGES['@emotion/react'];
    if (!pkg.dependencies['@emotion/styled']) pkg.dependencies['@emotion/styled'] = REACT_KNOWN_PACKAGES['@emotion/styled'];
  }

  writeJson(pkgPath, pkg);
  return added;
}

function ensureMaterialIconsLink(destPath) {
  const candidates = [
    path.join(destPath, 'src', 'index.html'),
    path.join(destPath, 'index.html')
  ];
  const indexPath = candidates.find((p) => fs.existsSync(p));
  if (!indexPath) return;
  let html = fs.readFileSync(indexPath, 'utf-8');
  if (/fonts\.googleapis\.com\/icon\?family=Material\+Icons/.test(html)) return;
  if (!html.includes('</head>')) return;
  html = html.replace(
    '</head>',
    '  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">\n</head>'
  );
  fs.writeFileSync(indexPath, html, 'utf-8');
}

/**
 * Pull missing npm packages out of tsc/vite "Cannot find module" errors.
 * Returns how many packages were added.
 */
export function addPackagesFromBuildErrors(destPath, buildErrors) {
  const pkgPath = path.join(destPath, 'package.json');
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return 0;
  pkg.dependencies = pkg.dependencies || {};
  let added = 0;
  const text = String(buildErrors || '');
  for (const m of text.matchAll(/Cannot find module ['"]([^'"]+)['"]/g)) {
    const pkgName = packageNameFromSpecifier(m[1]);
    if (!pkgName || pkgName.startsWith('@ngxs/')) continue;
    if (pkgName === '@angular/material' || pkgName === '@angular/cdk') {
      if (pkg.dependencies['@angular/core'] || pkg.devDependencies?.['@angular/core']) {
        added += ensureAngularMaterialPackages(destPath);
        const latest = readJsonSafe(pkgPath);
        if (latest?.dependencies) {
          pkg.dependencies = { ...pkg.dependencies, ...latest.dependencies };
        }
      }
      continue;
    }
    if (pkgName.startsWith('@angular/')) continue;
    const version = REACT_KNOWN_PACKAGES[pkgName];
    if (!version) continue;
    if (pkgName === 'react' || pkgName === 'react-dom' || pkgName === 'vite') continue;
    if (!pkg.dependencies[pkgName] && !pkg.devDependencies?.[pkgName]) {
      pkg.dependencies[pkgName] = version;
      added += 1;
    }
  }
  if (added) writeJson(pkgPath, pkg);
  return added;
}

export function fileContainsJsx(content) {
  const text = String(content || '');
  if (!text) return false;
  if (/return\s*\(\s*</.test(text)) return true;
  if (/<>[\s\S]*<\/>/.test(text)) return true;
  // PascalCase tags, but not TypeScript generics (Promise<User>, StateContext<Model>)
  if (/(?<![A-Za-z0-9_])<[A-Z][A-Za-z0-9.]*(\s|\/|>)/.test(text)) return true;
  if (
    /<\/?(?:div|span|button|form|main|section|header|footer|nav|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|input|label|select|option|textarea|img|svg|path|a|fragment)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (/\bclassName\s*=/.test(text) && /(?<![A-Za-z0-9_])<\w/.test(text)) return true;
  return false;
}

/**
 * Rename src .ts files that contain JSX to .tsx (and drop the .ts sibling).
 * Returns how many files were renamed or removed.
 */
export function renameJsxTsFilesToTsx(destPath) {
  const srcRoot = path.join(destPath, 'src');
  if (!fs.existsSync(srcRoot)) return 0;

  let renamed = 0;
  const files = walkFiles(
    srcRoot,
    (name) =>
      (name.endsWith('.ts') || name.endsWith('.js')) &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.spec.js')
  );

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (!fileContainsJsx(content)) continue;

    const destFile = file.endsWith('.js')
      ? file.replace(/\.js$/, '.jsx')
      : file.replace(/\.ts$/, '.tsx');
    try {
      if (fs.existsSync(destFile)) {
        fs.unlinkSync(file);
      } else {
        fs.renameSync(file, destFile);
      }
      renamed += 1;
    } catch {
      /* ignore */
    }
  }

  return renamed;
}

function relativeModulePath(fromFile, toFile) {
  let rel = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
  rel = rel.replace(/\.(tsx|ts|jsx|js)$/i, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function hoistReactSrcApp(destPath) {
  const srcRoot = path.join(destPath, 'src');
  const srcApp = path.join(srcRoot, 'app');
  if (!fs.existsSync(srcApp)) return 0;
  let moved = 0;
  for (const file of walkFiles(srcApp, () => true)) {
    const rel = path.relative(srcApp, file);
    const dest = path.join(srcRoot, rel);
    try {
      if (fs.existsSync(dest)) {
        const destSize = fs.statSync(dest).size;
        const srcSize = fs.statSync(file).size;
        if (srcSize > destSize + 40) {
          fs.copyFileSync(file, dest);
          moved += 1;
        }
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(file, dest);
      moved += 1;
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(srcApp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (moved > 0) {
    console.log(`[postprocess] Hoisted ${moved} file(s) from src/app/ into src/`);
  }
  return moved;
}

function ensureZustandHookImports(contents) {
  const hookExports = [];
  for (const [file, content] of contents) {
    for (const m of String(content).matchAll(/export const (use\w+Store)\s*=/g)) {
      hookExports.push({ hook: m[1], file });
    }
  }
  if (hookExports.length === 0) return;

  for (const [file, content] of contents) {
    let c = content;
    const selfExported = new Set(
      [...String(content).matchAll(/export const (use\w+Store)\s*=/g)].map((m) => m[1])
    );
    for (const { hook, file: expFile } of hookExports) {
      if (file === expFile) continue;
      if (selfExported.has(hook)) continue;
      if (!new RegExp(`\\b${hook}\\b`).test(c)) continue;
      if (new RegExp(`import\\s+[^;]*\\b${hook}\\b`).test(c)) continue;
      const rel = relativeModulePath(file, expFile);
      c = `import { ${hook} } from '${rel}';\n${c}`;
    }
    contents.set(file, c);
  }
}

function findZustandStoreFiles(destPath) {
  const stores = [];
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.ts') || n.endsWith('.tsx'))) {
    const content = fs.readFileSync(file, 'utf-8');
    const hookMatch = content.match(/export const (use\w+Store)\s*=\s*create/);
    if (!hookMatch) continue;
    stores.push({
      file,
      hook: hookMatch[1],
      content,
      importsSameHook: new RegExp(`import\\s+\\{\\s*${hookMatch[1]}\\s*\\}\\s+from`).test(content)
    });
  }
  return stores;
}

function scoreZustandStoreFile(entry) {
  let score = 0;
  const rel = entry.file.replace(/\\/g, '/');
  if (/\.store\.ts$/.test(rel)) score += 10;
  if (/Store\.ts$/.test(rel) && !/\.state\.ts$/.test(rel)) score += 8;
  if (!entry.importsSameHook) score += 6;
  if (/\w+Draft|interface \w+Model/.test(entry.content)) score += 3;
  if (/\.state\.ts$/.test(rel)) score -= 4;
  return score;
}

function stripSelfHookImports(content, hook) {
  return String(content || '').replace(
    new RegExp(`import\\s+\\{\\s*${hook}\\s*\\}\\s+from\\s+['"][^'"]+['"]\\s*;?\\s*\\n`, 'g'),
    ''
  );
}

/**
 * One zustand hook per name — drop circular task.state.ts / task.store.ts duplicates.
 */
export function consolidateDuplicateZustandStores(destPath) {
  const stores = findZustandStoreFiles(destPath);
  const byHook = new Map();
  for (const entry of stores) {
    if (!byHook.has(entry.hook)) byHook.set(entry.hook, []);
    byHook.get(entry.hook).push(entry);
  }

  let changed = 0;
  for (const [hook, entries] of byHook) {
    if (entries.length === 1) {
      const only = entries[0];
      const cleaned = stripSelfHookImports(only.content, hook);
      if (cleaned !== only.content) {
        fs.writeFileSync(only.file, cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`, 'utf-8');
        changed += 1;
      }
      continue;
    }

    entries.sort((a, b) => scoreZustandStoreFile(b) - scoreZustandStoreFile(a));
    const winner = entries[0];
    let winnerContent = stripSelfHookImports(winner.content, hook);
    fs.writeFileSync(winner.file, winnerContent.endsWith('\n') ? winnerContent : `${winnerContent}\n`, 'utf-8');

    for (const loser of entries.slice(1)) {
      try {
        fs.unlinkSync(loser.file);
        changed += 1;
        console.log(`[postprocess] Removed duplicate zustand store: ${path.relative(destPath, loser.file)}`);
      } catch {
        /* ignore */
      }
    }
    fixZustandImportPaths(destPath, winner.file, hook);
  }
  if (changed > 0) {
    console.log(`[postprocess] Consolidated zustand store(s) (${changed} change(s))`);
  }
  return changed;
}

function fixZustandImportPaths(destPath, canonicalFile, hook) {
  const srcRoot = path.join(destPath, 'src');
  const canonicalImport = relativeModulePath(canonicalFile, canonicalFile).replace(/\\/g, '/');
  const canonicalNoExt = canonicalImport.replace(/\.(tsx|ts)$/, '');

  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))) {
    if (file === canonicalFile) continue;
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;
    content = content.replace(
      new RegExp(`import\\s+\\{\\s*${hook}\\s*\\}\\s+from\\s+['"]([^'"]+)['"]`, 'g'),
      (full, spec) => {
        const resolved = resolveModuleFile(file, spec);
        if (resolved && fs.existsSync(resolved)) return full;
        const rel = relativeModulePath(file, canonicalFile).replace(/\.(tsx|ts)$/, '');
        return `import { ${hook} } from '${rel}'`;
      }
    );
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
  }

  const hookFileName = `${hook}.ts`;
  const useHookBarrel = path.join(srcRoot, 'store', hookFileName);
  const exportPath = `./${path
    .relative(path.join(srcRoot, 'store'), canonicalFile)
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '')}`;
  const exportLine = `export { ${hook} } from '${exportPath}';\n`;
  if (!fs.existsSync(useHookBarrel)) {
    fs.mkdirSync(path.dirname(useHookBarrel), { recursive: true });
    fs.writeFileSync(useHookBarrel, exportLine, 'utf-8');
  }
  const legacyBarrel = path.join(srcRoot, 'store', `${hook.replace(/^use/, '').charAt(0).toLowerCase()}${hook.replace(/^use/, '').slice(1)}.ts`);
  if (legacyBarrel !== useHookBarrel && fs.existsSync(legacyBarrel)) {
    try {
      const legacyContent = fs.readFileSync(legacyBarrel, 'utf-8');
      const isRealStore = new RegExp(`export const ${hook}\\s*=\\s*create`).test(legacyContent);
      if (!isRealStore) {
        fs.unlinkSync(legacyBarrel);
      }
    } catch {
      /* ignore */
    }
  }
}

function cleanupStoreBarrelFiles(destPath) {
  const srcRoot = path.join(destPath, 'src', 'store');
  if (!fs.existsSync(srcRoot)) return 0;
  let fixed = 0;
  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.ts') && !n.endsWith('.store.ts') && !n.endsWith('.state.ts'))) {
    const base = path.basename(file);
    if (!/Store\.ts$/.test(base) && !/^use\w+Store\.ts$/.test(base)) continue;
    let content = fs.readFileSync(file, 'utf-8');
    if (!/^export\s+\{/.test(content.trim()) && !/export\s+\{/.test(content)) continue;
    const original = content;
    content = content.replace(/^import\s+\{[^}]+\}\s+from\s+[^;]+;\s*\n?/m, '');
    content = content.trimEnd();
    if (!content.endsWith('\n')) content += '\n';
    if (content !== original) {
      fs.writeFileSync(file, content, 'utf-8');
      fixed += 1;
    }
  }
  return fixed;
}

function fixCnUtilityFile(destPath) {
  const utilsPath = path.join(destPath, 'src', 'lib', 'utils.ts');
  if (!fs.existsSync(utilsPath)) return 0;
  let content = fs.readFileSync(utilsPath, 'utf-8');
  if (!/\bClassValue\b/.test(content)) return 0;
  if (/import\s+type\s+\{\s*ClassValue\s*\}/.test(content)) return 0;
  content = ensureImport(content, 'ClassValue', 'clsx');
  content = content.replace(
    /import\s+\{\s*ClassValue\s*\}\s+from\s+['"]clsx['"]/,
    "import { type ClassValue } from 'clsx'"
  );
  fs.writeFileSync(utilsPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  return 1;
}

function getZustandStateFields(storeContent) {
  const fields = new Set();
  const iface = storeContent.match(/interface\s+\w+\s*\{([\s\S]*?)\}/);
  if (iface) {
    for (const m of iface[1].matchAll(/^\s*(\w+)\??\s*:/gm)) fields.add(m[1]);
  }
  for (const m of storeContent.matchAll(/^\s{2,}(\w+)\s*:/gm)) {
    if (!['set', 'get'].includes(m[1])) fields.add(m[1]);
  }
  return fields;
}

function fixZustandStoreDestructuring(content, hook, stateField, aliasField) {
  const re = new RegExp(`const\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*${hook}\\s*\\(\\s*\\)`, 'g');
  return content.replace(re, (full, inner) => {
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
    const hasStateField = parts.some(
      (p) =>
        p === stateField ||
        p.startsWith(`${stateField}:`) ||
        new RegExp(`^${stateField}:\\s*${aliasField}$`).test(p)
    );
    const hasBareAlias = parts.some((p) => p === aliasField);
    if (hasBareAlias && !hasStateField) {
      const newParts = parts.map((p) => (p === aliasField ? `${stateField}: ${aliasField}` : p));
      return `const { ${newParts.join(', ')} } = ${hook}()`;
    }
    return full;
  });
}

function consolidateZustandHookUsage(content, hook) {
  if (!content.includes(hook)) return content;

  const selectorRe = new RegExp(
    `^\\s*const\\s+(\\w+)\\s*=\\s*${hook}\\(\\(state(?:\\s*:\\s*\\w+)?\\)\\s*=>\\s*state\\.(\\w+)\\)\\s*;\\s*$`
  );
  const destructRe = new RegExp(
    `^\\s*const\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*${hook}\\(\\s*\\)\\s*;\\s*$`
  );

  const fieldMap = new Map();
  const linesToRemove = new Set();

  for (const line of content.split('\n')) {
    const sel = line.match(selectorRe);
    if (sel) {
      linesToRemove.add(line);
      fieldMap.set(sel[2], sel[1]);
      continue;
    }
    const dest = line.match(destructRe);
    if (dest) {
      linesToRemove.add(line);
      for (const part of dest[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        const alias = p.match(/^(\w+)\s*:\s*(\w+)$/);
        if (alias) fieldMap.set(alias[1], alias[2]);
        else fieldMap.set(p, p);
      }
    }
  }

  const hookUsageCount = (content.match(new RegExp(`\\b${hook}\\b`, 'g')) || []).length;
  if (fieldMap.size === 0) return content;
  if (linesToRemove.size <= 1 && linesToRemove.size < hookUsageCount) return content;

  const parts = [...fieldMap.entries()].map(([field, local]) =>
    field === local ? field : `${field}: ${local}`
  );
  const consolidated = `  const { ${parts.join(', ')} } = ${hook}();`;
  const filtered = content
    .split('\n')
    .filter((line) => !linesToRemove.has(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  if (new RegExp(`const\\s+\\{\\s*[^}]+\\}\\s*=\\s*${hook}\\(\\s*\\)`).test(filtered)) {
    return filtered;
  }
  return filtered.replace(
    /(export\s+(?:default\s+)?function\s+\w+[^{]*\{)/,
    `$1\n${consolidated}`
  );
}

/** Collapse duplicate zustand selectors/destructuring into one hook call per file. */
export function fixZustandHookUsage(destPath) {
  ensureZustandStoreScaffold(destPath);
  const stores = findZustandStoreFiles(destPath);
  if (stores.length === 0) return 0;
  let changed = 0;
  const srcRoot = path.join(destPath, 'src');

  for (const store of stores) {
    fixZustandImportPaths(destPath, store.file, store.hook);
    const fields = getZustandStateFields(store.content);
    for (const file of walkFiles(srcRoot, (n) => n.endsWith('.tsx') || n.endsWith('.ts'))) {
      let content = fs.readFileSync(file, 'utf-8');
      if (!content.includes(store.hook)) continue;
      const original = content;
      if (fields.has('items') && !fields.has('tasks')) {
        content = fixZustandStoreDestructuring(content, store.hook, 'items', 'tasks');
      }
      content = consolidateZustandHookUsage(content, store.hook);
      if (content !== original) {
        fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
        changed += 1;
      }
    }
  }
  return changed;
}

/** Align selector fields (state.<alias> → state.items when the store uses items). */
export function fixZustandSelectorFields(destPath) {
  const stores = findZustandStoreFiles(destPath);
  if (stores.length === 0) return 0;
  let changed = 0;
  const srcRoot = path.join(destPath, 'src');

  for (const store of stores) {
    const fields = getZustandStateFields(store.content);
    if (!fields.has('items')) continue;
    for (const file of walkFiles(srcRoot, (n) => n.endsWith('.tsx') || n.endsWith('.ts'))) {
      let content = fs.readFileSync(file, 'utf-8');
      if (!content.includes(store.hook)) continue;
      const original = content;
      content = content.replace(/\bstate\.(\w+)\b/g, (full, name) => {
        if (fields.has(name)) return full;
        if (/s$/i.test(name) && name !== 'status') return 'state.items';
        return full;
      });
      const aliases = new Set();
      for (const m of content.matchAll(
        new RegExp(`const\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*${store.hook}\\s*\\(`, 'g')
      )) {
        for (const part of m[1].split(',')) {
          const name = part.split(':')[0].trim();
          if (name && !fields.has(name) && /s$/i.test(name) && name !== 'status') aliases.add(name);
        }
      }
      for (const alias of aliases) {
        content = fixZustandStoreDestructuring(content, store.hook, 'items', alias);
      }
      content = consolidateZustandHookUsage(content, store.hook);
      if (content !== original) {
        fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
        changed += 1;
      }
    }
  }
  return changed;
}

function indexComponentPropInterfaces(destPath) {
  const map = new Map();
  const componentsRoot = path.join(destPath, 'src', 'components');
  if (!fs.existsSync(componentsRoot)) return map;
  for (const file of walkFiles(componentsRoot, (n) => n.endsWith('.tsx') || n.endsWith('.ts'))) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const m of content.matchAll(/export interface (\w+Props)\s*\{([\s\S]*?)\}/g)) {
      const name = m[1].replace(/Props$/, '');
      const props = new Set(
        [...m[2].matchAll(/(\w+)\??\s*:/g)].map((x) => x[1])
      );
      map.set(name, props);
    }
    const fnMatch = content.match(/export (?:const|function) (\w+)\s*[:=][^{]*\{([^}]+)\}/);
    if (fnMatch && !map.has(fnMatch[1])) {
      const props = new Set(
        [...fnMatch[2].matchAll(/\b(\w+)\s*(?:=|,|\})/g)]
          .map((x) => x[1])
          .filter((n) => n !== 'null' && n !== 'false' && n !== 'true')
      );
      if (props.size) map.set(fnMatch[1], props);
    }
  }
  return map;
}

function mergeDeleteDialogCallbacks(content, compName, props) {
  if (!props.has('onClose') || props.has('onConfirm')) return content;
  if (!content.includes(`<${compName}`) || !/\bonConfirm=/.test(content)) return content;

  const tagRe = new RegExp(`<${compName}\\b([\\s\\S]*?)/>`, 'g');
  return content.replace(tagRe, (tag, inner) => {
    if (!/\bonConfirm=/.test(tag)) return tag;
    const confirmFn = inner.match(/\bonConfirm=\{([^}]+)\}/)?.[1]?.trim();
    const closeFn = inner.match(/\bonClose=\{([^}]+)\}/)?.[1]?.trim();
    if (!confirmFn) return tag;

    let newInner = inner
      .replace(/\s*onConfirm=\{[^}]+\}\s*/g, '\n')
      .replace(/\s*onClose=\{[^}]+\}\s*/g, '\n');
    const elseBody = closeFn?.includes('=>')
      ? closeFn.replace(/^[^=]+=>\s*/, '').replace(/;$/, '')
      : closeFn
        ? `${closeFn}()`
        : null;
    const merged = elseBody
      ? `(confirmed) => {\n        if (confirmed) ${confirmFn}();\n        else { ${elseBody}; }\n      }`
      : `(confirmed) => { if (confirmed) ${confirmFn}(); }`;
    return `<${compName}${newInner}        onClose={${merged}}\n      />`;
  });
}

function removeUnusedArrowHandlers(content) {
  return String(content || '').replace(
    /^\s*const\s+(handle\w+)\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\};\s*\n/gm,
    (block, name) => {
      const without = String(content).replace(block, '');
      if (new RegExp(`\\b${name}\\b`).test(without)) return block;
      return '';
    }
  );
}
function stripJsxProp(content, componentName, propName) {
  return String(content || '').replace(
    new RegExp(`(<${componentName}\\b[^>]*?)\\s+${propName}=\\{[^}]+\\}`, 'gs'),
    '$1'
  );
}

function renameJsxPropInComponent(content, componentName, fromProp, toProp) {
  const tagRe = new RegExp(`<${componentName}\\b[\\s\\S]*?(/?>)`, 'g');
  return String(content || '').replace(tagRe, (tag) => {
    if (!new RegExp(`\\b${fromProp}=`).test(tag)) return tag;
    if (new RegExp(`\\b${toProp}=`).test(tag)) {
      return tag.replace(new RegExp(`\\s+${fromProp}=\\{[^}]+\\}`), '');
    }
    return tag.replace(new RegExp(`\\b${fromProp}=`), `${toProp}=`);
  });
}

/** Align JSX call sites with exported component prop interfaces. */
export function syncComponentCallSiteProps(destPath) {
  const componentProps = indexComponentPropInterfaces(destPath);
  if (componentProps.size === 0) return 0;
  const srcRoot = path.join(destPath, 'src');
  let changed = 0;

  for (const file of walkFiles(srcRoot, (n) => n.endsWith('.tsx'))) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;
    for (const [compName, props] of componentProps) {
      if (!content.includes(`<${compName}`)) continue;
      if (!props.has('open')) content = stripJsxProp(content, compName, 'open');
      if (props.has('onCancel') && !props.has('onClose')) {
        content = renameJsxPropInComponent(content, compName, 'onClose', 'onCancel');
      }
      if (props.has('onClose') && !props.has('onCancel')) {
        content = renameJsxPropInComponent(content, compName, 'onCancel', 'onClose');
      }
      content = mergeDeleteDialogCallbacks(content, compName, props);
    }
    content = removeUnusedArrowHandlers(content);
    content = injectMissingComponentProps(content, componentProps);
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
      changed += 1;
    }
  }
  return changed;
}

/** Inject required props only when the component interface declares them. */
export function injectMissingComponentProps(content, componentProps = null) {
  let c = String(content || '');
  if (!componentProps || typeof componentProps.entries !== 'function') return c;
  for (const [compName, props] of componentProps.entries()) {
    if (!props || typeof props.has !== 'function' || !props.has('open')) continue;
    const tag = String(compName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`<${tag}\\b`).test(c) || new RegExp(`<${tag}[^>]*\\bopen=`).test(c)) continue;
    const openVar = c.match(/\[(\w+),\s*set\w+\]\s*=\s*useState\([^)]*\)/)?.[1];
    if (!openVar) continue;
    c = c.replace(new RegExp(`<${tag}(\\s*)`), `<${compName} open={${openVar}}$1`);
  }
  return c;
}

function dedupeMuiImports(content) {
  const text = String(content || '');
  const barrelMatch = text.match(/import\s+\{([^}]+)\}\s+from\s+['"]@mui\/material['"]/);
  if (!barrelMatch) return text;
  const barrelNames = new Set(
    barrelMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const defMatch = line.match(/^import\s+(\w+)\s+from\s+['"]@mui\/material\/(\w+)['"]/);
    if (defMatch && barrelNames.has(defMatch[1])) continue;
    if (/^import\s+\{[^}]+\}\s+from\s+['"]@mui\/material['"]/.test(line) && out.some((l) => /^import\s+\{[^}]+\}\s+from\s+['"]@mui\/material['"]/.test(l))) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function repairReactSourceFiles(destPath) {
  const files = walkFiles(path.join(destPath, 'src'), (name) =>
    name.endsWith('.tsx') || name.endsWith('.ts') || name.endsWith('.jsx') || name.endsWith('.js')
  );

  const contents = new Map();
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf-8');
    let content = rewriteReactAngularLeftovers(original);
    content = stripUnusedReactDefaultImport(content);
    content = pruneUnusedNamedImports(content);
    content = removeUnusedArrowHandlers(content);
    content = dedupeMuiImports(content);
    contents.set(file, content);
  }
  ensureZustandHookImports(contents);

  for (const [file, content] of contents) {
    let original = '';
    try {
      original = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
  }
}

/**
 * Full React workspace repair after AI generation.
 */
export function repairReactWorkspace(destPath, options = {}) {
  const { sourcePackageJson = null, sourceFilesMap = null } = options;
  const sourceStack = detectSourceStack(sourceFilesMap || {}, sourcePackageJson);

  hoistReactSrcApp(destPath);
  addReactPathAliases(destPath);
  mergePackageDependencies(destPath, sourcePackageJson, 'react');
  repairReactSourceFiles(destPath);
  pinSourceDomainArtifacts(destPath, sourceFilesMap);
  consolidateDuplicateZustandStores(destPath);
  ensureZustandStoreScaffold(destPath);
  cleanupStoreBarrelFiles(destPath);
  fixZustandSelectorFields(destPath);
  fixZustandHookUsage(destPath);
  alignTaskStatusLiterals(destPath);
  syncComponentCallSiteProps(destPath);
  fixCnUtilityFile(destPath);
  fixReactModuleImports(destPath);
  dedupeStoreModelTypes(destPath);
  fixTaskModelFieldMismatches(destPath);
  ensureReactAppShell(destPath, sourceFilesMap);
  removeUnusedStoreShards(destPath);
  removeAngularLeftoverReactFiles(destPath);
  stripAngularTestDepsFromReactPackage(destPath);
  const renamedJsx = renameJsxTsFilesToTsx(destPath);
  if (renamedJsx > 0) {
    console.log(`[postprocess] Renamed ${renamedJsx} JSX .ts file(s) to .tsx`);
  }
  const addedPkgs = ensureReactPackagesFromImports(destPath, sourceStack);
  if (addedPkgs > 0) {
    console.log(`[postprocess] Added ${addedPkgs} missing React package(s) from imports/source stack`);
  }
  if (sourceStack.material) ensureMaterialIconsLink(destPath);

  // Ensure App.tsx + main.tsx exist (caller also runs ensureReactRuntimeFiles)
  const appPath = path.join(destPath, 'src', 'App.tsx');
  if (!fs.existsSync(appPath)) {
    const alt = walkFiles(path.join(destPath, 'src'), (n) => /^app\.(tsx|jsx)$/i.test(n))[0];
    if (alt) fs.copyFileSync(alt, appPath);
  }

  enforceReactTailwindScss(destPath);
  return addedPkgs;
}

function enforceReactTailwindScss(destPath) {
  // Rename .css → .scss under src and rewrite imports
  for (const file of walkFiles(path.join(destPath, 'src'), (n) => n.endsWith('.css'))) {
    const scssPath = file.replace(/\.css$/, '.scss');
    if (!fs.existsSync(scssPath)) {
      try { fs.renameSync(file, scssPath); } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }

  for (const file of walkFiles(path.join(destPath, 'src'), (n) =>
    n.endsWith('.ts') || n.endsWith('.tsx') || n.endsWith('.jsx') || n.endsWith('.js')
  )) {
    let content = fs.readFileSync(file, 'utf-8');
    const original = content;
    content = content
      .replace(/(['"])([^'"]+)\.css\1/g, '$1$2.scss$1')
      .replace(/from\s+['"]\.\/index\.css['"]/g, "from './index.scss'")
      .replace(/import\s+['"]\.\/index\.css['"]/g, "import './index.scss'");
    if (content !== original) {
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    }
  }

  const indexScss = path.join(destPath, 'src', 'index.scss');
  if (!fs.existsSync(indexScss)) {
    fs.writeFileSync(
      indexScss,
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
      'utf-8'
    );
  } else {
    const styles = fs.readFileSync(indexScss, 'utf-8');
    if (!/@tailwind\s+base/.test(styles)) {
      fs.writeFileSync(
        indexScss,
        `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n${styles}`,
        'utf-8'
      );
    }
  }

  if (!fs.existsSync(path.join(destPath, 'tailwind.config.js'))) {
    fs.writeFileSync(
      path.join(destPath, 'tailwind.config.js'),
      `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx,scss}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n`,
      'utf-8'
    );
  }
  if (!fs.existsSync(path.join(destPath, 'postcss.config.js'))) {
    fs.writeFileSync(
      path.join(destPath, 'postcss.config.js'),
      `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`,
      'utf-8'
    );
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
  addReactPathAliases,
  ensureCnUtil
};
