/**
 * Mechanical React → Angular conversion used when the AI unit writer fails.
 * Produces a standalone component triad from a function-component TSX file.
 */
import fs from 'fs';
import path from 'path';
import { declarablesNeededByHtml, inferDeclarablePackage, repairSelfClosingNonVoidTags, repairInferredTemplateHandlers } from './postprocess.js';

export function isReactBootstrapPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  return (
    /^src\/(main|index|App)\.(tsx|ts|jsx|js)$/i.test(p) ||
    /^src\/app\/App\.(tsx|ts|jsx|js)$/i.test(p) ||
    /^src\/App\.(scss|css)$/i.test(p) ||
    /^src\/index\.(scss|css)$/i.test(p) ||
    /^src\/vite-env\.d\.ts$/i.test(p) ||
    /(^|\/)index\.html$/i.test(p)
  );
}

/**
 * LLM/analyzer often dump React App.tsx under src/app/pages/admin/app/.
 * The Angular kit already owns src/app/app.component — this nested copy is not a page.
 */
export function isMisplacedAngularAppComponentPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (/^src\/app\/app\.component(\.(ts|html|scss|css))?$/i.test(p)) return false;
  return /(?:^|\/)pages\/(?:[\w-]+\/)*app\/app\.component(\.|$)/i.test(p);
}

export function toKebabName(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'converted';
}

export function toPascalName(kebab) {
  return String(kebab || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Map a React source path onto the Angular destination (models stay models,
 * pages stay pages, components stay components). Bootstrap files return null.
 */
export function angularDestForReactSource(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (!/^src\//.test(n)) return null;
  if (isReactBootstrapPath(n)) return null;
  if (/\.(spec|test)\./i.test(n)) return null;
  if (/vite-env\.d|routeTree\.gen|__root/.test(n)) return null;

  if (/\/models\//i.test(n) || /\.model\.(ts|tsx)$/i.test(n)) {
    const base = path.posix.basename(n).replace(/\.tsx$/i, '.ts');
    return { kind: 'model', newPath: `src/app/models/${base}` };
  }

  if (/\.(tsx|jsx)$/i.test(n)) {
    const fileBase = path.posix.basename(n).replace(/\.(tsx|jsx)$/i, '');
    const kebab = toKebabName(fileBase.replace(/\.component$/i, ''));
    const dir = path.posix.dirname(n);
    let folder;
    if (/^src\/pages(\/|$)/i.test(dir)) folder = dir.replace(/^src\/pages/i, 'src/app/pages');
    else if (/^src\/components(\/|$)/i.test(dir)) {
      folder = dir.replace(/^src\/components/i, 'src/app/components');
    } else if (/^src\/features(\/|$)/i.test(dir)) {
      folder = dir.replace(/^src\/features/i, 'src/app/pages');
    } else {
      folder = `src/app/pages/${kebab}`;
    }
    const unit = `${folder}/${kebab}.component`;
    return {
      kind: 'component',
      folder,
      kebab,
      className: `${toPascalName(kebab)}Component`,
      selector: `app-${kebab}`,
      unit,
      files: [`${unit}.ts`, `${unit}.html`, `${unit}.scss`]
    };
  }

  if (/\.(scss|css)$/i.test(n)) return { kind: 'style' };
  if (/\.(ts|js)$/i.test(n) && !/\.d\.ts$/i.test(n)) {
    if (/\/(lib|utils|hooks)\//i.test(n)) {
      return { kind: 'lib', newPath: `src/app/lib/${path.posix.basename(n)}` };
    }
    const base = toKebabName(path.posix.basename(n).replace(/\.(ts|js)$/i, ''));
    return { kind: 'service', newPath: `src/app/services/${base}.ts` };
  }
  return null;
}

function relativeImport(fromFile, toFile) {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\\/g, '/');
  rel = rel.replace(/\.(ts|tsx)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function extractJsxReturn(tsx) {
  const src = String(tsx || '');
  const early = src.match(
    /if\s*\(([^)]+)\)\s*\{\s*return\s*\(([\s\S]*?)\)\s*;\s*\}\s*return\s*\(([\s\S]*?)\)\s*;/
  );
  if (early) {
    return `{${early[1]} ? (${early[2].trim()}) : (${early[3].trim()})}`;
  }
  const m = src.match(/return\s*\(\s*([\s\S]*?)\s*\)\s*;\s*\}\s*$/);
  if (m) return m[1].trim();
  const m2 = src.match(/return\s*\(\s*([\s\S]*?)\s*\)\s*;/);
  return m2 ? m2[1].trim() : '';
}

function convertClassName(html) {
  let h = html;
  h = h.replace(
    /className=\{`status status--\$\{([^}]+)\}`\}/g,
    `[class]="'status status--' + $1"`
  );
  h = h.replace(/className=\{`([^`$]*)\$\{([^}]+)\}([^`]*)`\}/g, `class="$1{{ $2 }}$3"`);
  h = h.replace(/className="([^"]*)"/g, 'class="$1"');
  h = h.replace(/className=\{([^}]+)\}/g, '[class]="$1"');
  return h;
}

function skipJsxValue(html, i) {
  if (html[i] === '{') {
    let depth = 0;
    do {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') depth -= 1;
      i += 1;
    } while (i < html.length && depth > 0);
    return i;
  }
  if (html[i] === '"' || html[i] === "'") {
    const q = html[i];
    i += 1;
    while (i < html.length && html[i] !== q) i += 1;
    return i + 1;
  }
  return i + 1;
}

function stripJsxProp(html, name) {
  const needle = `${name}=`;
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith(needle, i) && (i === 0 || /\s/.test(html[i - 1]))) {
      i += needle.length;
      i = skipJsxValue(html, i);
      continue;
    }
    out += html[i];
    i += 1;
  }
  return out;
}

function convertEventsAndBindings(html) {
  let h = html;
  h = h.replace(/\bonClick=\{\(\)\s*=>\s*([^}]+)\}/g, '(click)="$1"');
  h = h.replace(/\bonClick=\{\((\w+)\)\s*=>\s*([^}]+)\}/g, '(click)="$2"');
  h = h.replace(/\bonClick=\{(\w+)\}/g, '(click)="$1()"');
  h = h.replace(/\bonSubmit=\{(\w+)\}/g, '(ngSubmit)="$1($event)"');
  h = h.replace(/\bonBlur=\{\(\)\s*=>\s*set([A-Z]\w+)\(([^)]*)\)\}/g, (_, cap, val) => {
    const field = cap.charAt(0).toLowerCase() + cap.slice(1);
    return `(blur)="${field} = ${val}"`;
  });
  h = h.replace(
    /\bonChange=\{\(event\)\s*=>\s*set([A-Z]\w+)\(event\.target\.value as ([A-Za-z]+)\)\}/g,
    (_, cap) => {
      const field = cap.charAt(0).toLowerCase() + cap.slice(1);
      return `(selectionChange)="${field} = $event.value"`;
    }
  );
  h = h.replace(
    /\bonChange=\{\(event\)\s*=>\s*set([A-Z]\w+)\(event\.target\.value\)\}/g,
    (_, cap) => {
      const field = cap.charAt(0).toLowerCase() + cap.slice(1);
      return `(input)="${field} = $any($event.target).value"`;
    }
  );
  h = h.replace(/\bonCancel=\{(\w+)\}/g, '(cancel)="$1()"');
  h = h.replace(/\bonSave=\{(\w+)\}/g, '(save)="$1($event)"');
  h = h.replace(/\bonEdit=\{(\w+)\}/g, '(edit)="$1($event)"');
  h = h.replace(/\bonRemove=\{(\w+)\}/g, '(remove)="$1($event)"');
  h = h.replace(/\bonClose=\{(\w+)\}/g, '(close)="$1($event)"');
  h = h.replace(/<mat-sidenav([^>]*?)\sonClose=\{\(\)\s*=>\s*[^}]+\}/g, '<mat-sidenav$1 (openedChange)="onSidebarChange($event)"');
  h = h.replace(/\bonClose=\{\(\)\s*=>\s*([^}]+)\}/g, '(close)="$1"');
  return h;
}

function convertMui(html) {
  let h = html.replace(/=>/g, '⟹');
  h = stripJsxProp(h, 'sx');
  h = stripJsxProp(h, 'PaperProps');
  h = stripJsxProp(h, 'startIcon');
  h = stripJsxProp(h, 'key');
  h = stripJsxProp(h, 'error');
  h = stripJsxProp(h, 'helperText');
  h = h.replace(/<Box\b([^>]*)>/g, '<div$1>');
  h = h.replace(/<\/Box>/g, '</div>');
  h = h.replace(/<AppBar\b[^>]*>\s*<Toolbar\b([^>]*)>/g, '<mat-toolbar color="primary"$1>');
  h = h.replace(/<\/Toolbar>\s*<\/AppBar>/g, '</mat-toolbar>');
  h = h.replace(/<Toolbar\b([^>]*)>/g, '<mat-toolbar$1>');
  h = h.replace(/<\/Toolbar>/g, '</mat-toolbar>');
  h = h.replace(/<Drawer\b/g, '<mat-sidenav position="end" mode="over"');
  h = h.replace(/<\/Drawer>/g, '</mat-sidenav>');
  h = h.replace(/\banchor="right"/g, '');
  h = h.replace(/<Dialog\b([^>]*)>/g, '<ng-container$1>');
  h = h.replace(/<\/Dialog>/g, '</ng-container>');
  h = h.replace(/<DialogTitle\b([^>]*)>/g, '<h2 mat-dialog-title$1>');
  h = h.replace(/<\/DialogTitle>/g, '</h2>');
  h = h.replace(/<DialogContent\b([^>]*)>/g, '<div mat-dialog-content$1>');
  h = h.replace(/<\/DialogContent>/g, '</div>');
  h = h.replace(/<DialogActions\b([^>]*)>/g, '<div mat-dialog-actions align="end"$1>');
  h = h.replace(/<\/DialogActions>/g, '</div>');
  h = h.replace(/<IconButton\b/g, '<button mat-icon-button type="button"');
  h = h.replace(/<\/IconButton>/g, '</button>');
  h = h.replace(
    /<Button\b([^>]*?)>/g,
    (_, attrs) => {
      let a = attrs;
      let directive = 'mat-button';
      if (/\bvariant="contained"/.test(a) && /\bcolor="error"/.test(a)) {
        directive = 'mat-flat-button';
        a = a.replace(/\bvariant="contained"/g, '').replace(/\bcolor="error"/g, 'color="warn"');
      } else if (/\bvariant="contained"/.test(a)) {
        directive = 'mat-flat-button';
        a = a.replace(/\bvariant="contained"/g, '');
      }
      a = a.replace(/\bcolor="inherit"/g, '');
      a = a.replace(/\btype="button"/g, '');
      return `<button ${directive} type="button"${a}>`;
    }
  );
  h = h.replace(/<\/Button>/g, '</button>');
  h = h.replace(
    /<TextField\b([^>]*?)\/>/g,
    (_, attrs) => {
      const label = attrs.match(/\blabel="([^"]+)"/)?.[1] || '';
      let a = attrs
        .replace(/\blabel="[^"]*"/g, '')
        .replace(/\berror=\{[^}]+\}/g, '')
        .replace(/\bhelperText=\{[^}]+\}/g, '')
        .replace(/\bmultiline\b/g, '')
        .replace(/\brows=\{(\d+)\}/g, 'rows="$1"');
      const tag = /\brows=/.test(a) ? 'textarea' : 'input';
      const control =
        tag === 'input'
          ? `<input matInput${a} />`
          : `<textarea matInput${a}></textarea>`;
      return `<mat-form-field appearance="outline"><mat-label>${label}</mat-label>${control}</mat-form-field>`;
    }
  );
  h = h.replace(/<FormControl\b([^>]*)>/g, '<mat-form-field appearance="outline"$1>');
  h = h.replace(/<\/FormControl>/g, '</mat-form-field>');
  h = h.replace(/<InputLabel\b([^>]*)>/g, '<mat-label$1>');
  h = h.replace(/<\/InputLabel>/g, '</mat-label>');
  h = h.replace(/<Select\b([^>]*)>/g, '<mat-select$1>');
  h = h.replace(/<\/Select>/g, '</mat-select>');
  h = h.replace(/<MenuItem\b([^>]*)>/g, '<mat-option$1>');
  h = h.replace(/<\/MenuItem>/g, '</mat-option>');
  h = h.replace(/<FormHelperText\b[^>]*>[\s\S]*?<\/FormHelperText>/g, '');
  h = h.replace(/<(\w+)Icon\s*\/>/g, (_, name) => `<mat-icon>${toKebabName(name)}</mat-icon>`);
  h = h.replace(/<mat-sidenav([^>]*?)\sopen=\{([^}]+)\}/g, '<mat-sidenav$1 [opened]="$2"');
  h = h.replace(/\bopen=\{([^}]+)\}/g, '[open]="$1"');
  h = h.replace(/\bmaxWidth="[^"]*"/g, '');
  h = h.replace(/\bfullWidth\b/g, '');
  h = h.replace(/\blabelId="[^"]*"/g, '');
  h = h.replace(/(?<!aria-|mat-)label="([^"]+)"/g, '');
  h = h.replace(/\bvalue=\{([^}]+)\}/g, '[value]="$1"');
  h = h.replace(/\b([a-z]\w*)=\{([^}]+)\}/g, (full, name, expr) => {
    if (/^on[A-Z]/.test(name)) return full;
    return `[${name}]="${expr}"`;
  });
  return h.replace(/⟹/g, '=>');
}

function cleanupHtml(html) {
  let h = html;
  h = h.replace(/<span(\s[^>]*)\/>/g, '<span$1></span>');
  h = h.replace(/\s+type="button"/g, ' type="button"');
  h = h.replace(/ type="button" type="button"/g, ' type="button"');
  h = h.replace(/@for \((\w+) of statusOptions; track \1\.id\)/g, '@for ($1 of statusOptions; track $1)');
  h = h.replace(/\[opened\]=/g, (match, offset) => {
    const before = h.slice(Math.max(0, offset - 80), offset);
    return /mat-sidenav/.test(before) ? match : '[open]=';
  });
  h = h.replace(/<ng-container([^>]*)>/g, (full, attrs) => {
    if (/\[open\]=/.test(attrs)) {
      const expr = attrs.match(/\[open\]="([^"]+)"/)?.[1] || 'open';
      return `@if (${expr}) {\n<div class="dialog-host">`;
    }
    return '<div class="dialog-host">';
  });
  h = h.replace(/<\/ng-container>/g, '</div>\n}');
  h = repairSelfClosingNonVoidTags(h);
  return h;
}

function convertCustomTags(html) {
  return html.replace(/<\/?([A-Z][A-Za-z0-9]*)\b/g, (full, name) => {
    const sel = `app-${toKebabName(name)}`;
    return full.startsWith('</') ? `</${sel}` : `<${sel}`;
  });
}

function closeCustomSelfClosing(html) {
  return html.replace(/<(app-[\w-]+)([^>]*)\/>/g, '<$1$2></$1>');
}

function convertControlFlow(html) {
  let h = html;
  h = h.replace(
    /\{(\w+)\.length === 0\s*\?\s*\(([\s\S]*?)\)\s*:\s*\(([\s\S]*?)\)\}/g,
    '@if ($1.length === 0) {\n$2\n} @else {\n$3\n}'
  );
  h = h.replace(
    /\{(\w+)\.map\(\((\w+)(?:\s*:\s*[^)]+)?\)\s*=>\s*\(([\s\S]*?)\)\s*\)\}/g,
    '@for ($2 of $1; track $2.id) {\n$3\n}'
  );
  h = h.replace(
    /\{(\w+)\.map\(\((\w+)(?:\s*:\s*[^)]+)?\)\s*=>\s*\{?\s*return\s*\(([\s\S]*?)\);\s*\}?\s*\)\}/g,
    '@for ($2 of $1; track $2.id) {\n$3\n}'
  );
  return h;
}

function convertInterpolations(html) {
  return html.replace(/\{([A-Za-z_$][\w.?![\]]*)\}/g, '{{ $1 }}');
}

function convertJsxToAngularHtml(jsx) {
  let h = String(jsx || '');
  h = h.replace(/<>/g, '').replace(/<\/>/g, '');
  h = h.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  h = convertControlFlow(h);
  h = convertClassName(h);
  h = convertMui(h);
  h = convertEventsAndBindings(h);
  h = convertCustomTags(h);
  h = closeCustomSelfClosing(h);
  h = convertInterpolations(h);
  h = cleanupHtml(h);
  if (/<mat-sidenav\b/.test(h) && !/<mat-sidenav-container\b/.test(h)) {
    h = `<mat-sidenav-container class="layout">\n${h}\n</mat-sidenav-container>`;
    h = h.replace(
      /<\/mat-sidenav>([\s\S]*)<\/mat-sidenav-container>/,
      '</mat-sidenav>\n<mat-sidenav-content>$1</mat-sidenav-content>\n</mat-sidenav-container>'
    );
  }
  h = h.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return h.trim() + '\n';
}

function parseUseState(tsx) {
  const states = [];
  const re = /const\s+\[(\w+),\s*set(\w+)\]\s*=\s*useState(?:<([^>]+)>)?\(([\s\S]*?)\);/g;
  let m;
  while ((m = re.exec(tsx))) {
    const inferred =
      (m[3] || '').trim() ||
      (m[4].trim() === 'false' || m[4].trim() === 'true'
        ? 'boolean'
        : m[4].trim() === "''" || m[4].trim() === '""'
          ? 'string'
          : m[4].trim() === 'null'
            ? 'null'
            : 'unknown');
    states.push({
      name: m[1],
      setter: `set${m[2]}`,
      type: inferred === 'null' ? 'unknown | null' : inferred,
      init: m[4].trim() === 'null' ? 'null' : m[4].trim()
    });
  }
  return states;
}

function parseProps(tsx) {
  const iface = tsx.match(/interface\s+(\w+)\s*\{([\s\S]*?)\}/);
  const fields = [];
  if (iface) {
    for (const line of iface[2].split('\n')) {
      const m = line.match(/(\w+)\??\s*:\s*([^;]+);/);
      if (m) fields.push({ name: m[1], type: m[2].trim() });
    }
  }
  const destructure = tsx.match(/function\s+\w+\s*\(\s*\{([^}]+)\}/);
  const names = destructure
    ? destructure[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean)
    : fields.map((f) => f.name);
  return { fields, names };
}

function primaryEntityProp(props) {
  return (props?.fields || []).find(
    (f) =>
      !/^on[A-Z]/.test(f.name) &&
      !String(f.type || '').includes('=>') &&
      !/boolean/.test(f.type) &&
      f.name !== 'open'
  );
}

function extractTernaryConst(tsx, name) {
  const re = new RegExp(
    `(?:const|let)\\s+${name}\\s*=\\s*(\\w+)\\s*\\?\\s*(['"][^'"]+['"])\\s*:\\s*(['"][^'"]+['"])`
  );
  const m = String(tsx || '').match(re);
  if (!m) return null;
  return { cond: m[1], whenTrue: m[2], whenFalse: m[3] };
}

function rewriteSetters(body, states) {
  let out = body;
  for (const st of states) {
    const setter = st.setter;
    out = out.replace(
      new RegExp(`${setter}\\(\\((\\w+)\\)\\s*=>\\s*([\\s\\S]*?)\\)(?=\\s*;)`, 'g'),
      (_, _arg, expr) => {
        const rewritten = expr.replace(new RegExp(`\\b${_arg}\\b`, 'g'), `this.${st.name}`);
        return `this.${st.name} = ${rewritten.trim()}`;
      }
    );
    out = out.replace(new RegExp(`\\b${setter}\\(`, 'g'), `this.${st.name} = (`);
  }
  return out;
}

function extractComponentBody(tsx) {
  const m = tsx.match(/export\s+default\s+function\s+\w+\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/);
  if (m) return m[1];
  const m2 = tsx.match(/export\s+function\s+\w+\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/);
  return m2 ? m2[1] : tsx;
}

function extractMethods(body, states) {
  const methods = [];
  const withoutReturn = body.replace(/return\s*\([\s\S]*\)\s*;\s*$/, '');
  const re =
    /const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)(?:\s*:\s*[^=\{]+)?\s*=>\s*\{([\s\S]*?)\n\s*\};/g;
  let m;
  while ((m = re.exec(withoutReturn))) {
    let inner = rewriteSetters(m[3], states);
    inner = inner.replace(/\bthis\.this\./g, 'this.');
    inner = inner
      .split('\n')
      .map((line) => line.replace(/^\s{2}/, ''))
      .join('\n');
    inner = inner.replace(/(^|\n)(\s*)(?!this\.)([a-zA-Z_]\w+)\s*=/g, '$1$2this.$3 =');
    methods.push({
      name: m[1],
      args: m[2].trim(),
      body: inner.trim()
    });
  }
  return methods;
}

function materialImportsForHtml(html) {
  const mods = [];
  const add = (mod, pkg) => {
    if (!mods.some((m) => m.mod === mod)) mods.push({ mod, pkg });
  };
  for (const mod of declarablesNeededByHtml(html)) {
    const pkg = inferDeclarablePackage(mod, '');
    if (pkg) add(mod, pkg);
  }
  return mods;
}

function childComponentImports(html, fromFile) {
  const found = [...html.matchAll(/<(app-[\w-]+)/g)].map((m) => m[1]);
  const unique = [...new Set(found)];
  return unique.map((sel) => {
    const kebab = sel.replace(/^app-/, '');
    const className = `${toPascalName(kebab)}Component`;
    const folder = `src/app/components/${kebab}`;
    const target = `${folder}/${kebab}.component`;
    return { sel, className, importPath: relativeImport(fromFile, `${target}.ts`) };
  });
}

/**
 * Convert one React function component into Angular .ts/.html/.scss contents.
 */
export function reactTsxToAngularTriad({ sourceRel, tsx, scss = '', dest }) {
  const info = dest || angularDestForReactSource(sourceRel);
  if (!info || info.kind !== 'component') return [];
  const jsx = extractJsxReturn(tsx);
  let html = convertJsxToAngularHtml(jsx);
  html = html.replace(/\b[A-Z][A-Z0-9]*_STATUS_LABELS\b/g, 'statusLabels');
  html = html.replace(/\b[A-Z][A-Z0-9]*_STATUS_OPTIONS\b/g, 'statusOptions');
  html = html.replace(/\(click\)="(\w+)\(\$event\)"/g, (full, name) => {
    if (name.startsWith('set') || name.startsWith('on') || /^open[A-Z]/.test(name)) {
      return full.replace('($event)', '()');
    }
    return full;
  });
  html = html.replace(/\((\w+)\)="set([A-Z]\w+)\(\$event\)"/g, (_, evt, cap) => {
    const field = cap.charAt(0).toLowerCase() + cap.slice(1);
    return `(${evt})="${field} = $event"`;
  });
  html = html.replace(/<mat-sidenav([\s\S]*?)\[open\]=/g, '<mat-sidenav$1[opened]=');
  html = html.replace(/track option\.id/g, 'track option');
  html = html.replace(/\(click\)="(on(?:Edit|Remove))\((\w+)[^"]*/g, '(click)="$1($2)"');

  const states = parseUseState(tsx);
  const props = parseProps(tsx);
  const body = extractComponentBody(tsx);
  const methods = extractMethods(body, states);
  const moduleConsts = [...tsx.matchAll(/^const\s+([A-Z_][A-Z0-9_]*)[^=]*=\s*([\s\S]*?);$/gm)];

  const tsPath = info.files[0];
  const ngModules = materialImportsForHtml(html);
  const children = childComponentImports(html, tsPath);
  const needsOnChanges = /useEffect\(/.test(tsx) && props.names.length > 0;
  const modelImportLines = [];
  for (const m of String(tsx || '').matchAll(
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]*models\/[^'"]+)['"]/g
  )) {
    const names = m[1].replace(/\btype\s+/g, '').trim();
    const spec = m[2].replace(/\.(tsx|ts)$/i, '');
    const base = spec.replace(/^.*\bmodels\//, '');
    if (!names || !base) continue;
    modelImportLines.push(
      `import { ${names} } from '${relativeImport(tsPath, `src/app/models/${base}`)}';`
    );
  }

  const importLines = [
    `import { Component${needsOnChanges ? ', Input, Output, EventEmitter, OnChanges, SimpleChanges' : props.fields.length ? ', Input, Output, EventEmitter' : ''} } from '@angular/core';`
  ];
  if (props.fields.length && !needsOnChanges) {
    /* inputs already in Component import */
  }
  if (!props.fields.length && !needsOnChanges) {
    importLines[0] = `import { Component } from '@angular/core';`;
  } else if (props.fields.length && needsOnChanges) {
    importLines[0] = `import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';`;
  } else if (props.fields.length) {
    importLines[0] = `import { Component, Input, Output, EventEmitter } from '@angular/core';`;
  }
  for (const mod of ngModules) {
    importLines.push(`import { ${mod.mod} } from '${mod.pkg}';`);
  }
  for (const ch of children) {
    importLines.push(`import { ${ch.className} } from '${ch.importPath}';`);
  }
  if (modelImportLines.length) importLines.push(...modelImportLines);

  const ngImports = [
    ...ngModules.map((m) => m.mod),
    ...children.map((c) => c.className)
  ];

  const inputDecls = [];
  const outputDecls = [];
  const emitWrappers = [];
  for (const f of props.fields) {
    if (/^on[A-Z]/.test(f.name) || f.type.includes('=>')) {
      const evt = f.name.replace(/^on/, '');
      const evtName = evt.charAt(0).toLowerCase() + evt.slice(1);
      const gen = (f.type.match(/\(([^)]*)\)/)?.[1] || 'unknown')
        .replace(/^\w+\s*:\s*/, '')
        .trim() || 'unknown';
      const payload = gen === '' ? 'void' : gen;
      outputDecls.push(`  @Output() ${evtName} = new EventEmitter<${payload}>();`);
      if (!methods.some((m) => m.name === f.name)) {
        if (payload === 'void' || payload === 'unknown') {
          emitWrappers.push(
            `  ${f.name}(): void {\n    this.${evtName}.emit();\n  }`
          );
        } else {
          emitWrappers.push(
            `  ${f.name}(value: ${payload}): void {\n    this.${evtName}.emit(value);\n  }`
          );
        }
      }
    } else {
      const def = /boolean/.test(f.type)
        ? 'false'
        : /\| null/.test(f.type)
          ? 'null'
          : /\[\]/.test(f.type)
            ? '[]'
            : /number/.test(f.type)
              ? '0'
              : "''";
      inputDecls.push(`  @Input() ${f.name}: ${f.type} = ${def};`);
    }
  }

  const stateDecls = states.map((st) => `  ${st.name}: ${st.type} = ${st.init};`);
  const extraFields = [];
  for (const m of String(tsx || '').matchAll(/\b([A-Z][A-Z0-9]*_STATUS_(?:LABELS|OPTIONS))\b/g)) {
    const alias = /LABELS$/.test(m[1]) ? 'statusLabels' : 'statusOptions';
    const line = `  readonly ${alias} = ${m[1]};`;
    if (!extraFields.includes(line)) extraFields.push(line);
  }
  const getters = [];
  for (const getterName of ['heading', 'submitLabel']) {
    if (!new RegExp(`\\b${getterName}\\b`).test(html)) continue;
    const ternary = extractTernaryConst(tsx, getterName);
    if (ternary) {
      getters.push(
        `  get ${getterName}(): string {\n    return this.${ternary.cond} ? ${ternary.whenTrue} : ${ternary.whenFalse};\n  }`
      );
    }
  }

  const constDecls = moduleConsts.map((m) => `const ${m[1]} = ${m[2]};`);
  const thisNames = [
    ...states.map((s) => s.name),
    ...props.fields.map((f) => f.name),
    ...methods.map((m) => m.name)
  ];

  const methodText = [
    ...methods.map((fn) => {
      let inner = fn.body
        .replace(/\bthis\.(\w+) = \(([\s\S]*?)\);/g, 'this.$1 = $2;')
        .replace(/\bFormEvent\b/g, 'Event');
      for (const f of props.fields) {
        if (!/^on[A-Z]/.test(f.name) && !String(f.type || '').includes('=>')) continue;
        const evt = f.name.replace(/^on/, '');
        const evtName = evt.charAt(0).toLowerCase() + evt.slice(1);
        inner = inner.replace(new RegExp(`\\b${f.name}\\(`, 'g'), `this.${evtName}.emit(`);
      }
      for (const n of thisNames) {
        inner = inner.replace(
          new RegExp(`(?<!this\\.)(?<![.\\w])(?<!\\{\\s*)(?<!,\\s*)\\b${n}\\b`, 'g'),
          `this.${n}`
        );
      }
      inner = inner.replace(/\bthis\.this\./g, 'this.');
      inner = inner
        .split('\n')
        .map((line) => (line.trim() ? `    ${line.trim()}` : ''))
        .join('\n');
      return `  ${fn.name}(${fn.args}): void {\n${inner}\n  }`;
    }),
    ...emitWrappers,
    ...getters
  ].join('\n\n');

  let onChanges = '';
  if (needsOnChanges) {
    const entity = primaryEntityProp(props);
    if (entity) {
      const formStates = states.filter(
        (st) => !/Touched$|Error$|^open$/.test(st.name) && !/boolean/.test(st.type)
      );
      const assigns = formStates
        .map((st) => `      this.${st.name} = this.${entity.name}.${st.name};`)
        .join('\n');
      const resets = formStates.map((st) => `      this.${st.name} = ${st.init};`).join('\n');
      const touched = states
        .filter((st) => /Touched$/.test(st.name))
        .map((st) => `    this.${st.name} = false;`)
        .join('\n');
      onChanges = `
  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['${entity.name}']) return;
    if (this.${entity.name}) {
${assigns}
    } else {
${resets}
    }
${touched}
  }
`;
    }
  }

  const implementsClause = needsOnChanges ? ' implements OnChanges' : '';
  const ts = `${importLines.join('\n')}
${constDecls.length ? `\n${constDecls.join('\n')}\n` : ''}
@Component({
  selector: '${info.selector}',
  standalone: true,
  imports: [${ngImports.join(', ')}],
  templateUrl: './${info.kebab}.component.html',
  styleUrl: './${info.kebab}.component.scss'
})
export class ${info.className}${implementsClause} {
${[...inputDecls, ...outputDecls, ...stateDecls, ...extraFields].filter(Boolean).join('\n')}
${onChanges}
${methodText}
}
`.replace(/\bFormEvent\b/g, 'Event');

  const scssOut = String(scss || '').trim()
    ? `${String(scss).replace(/:host/g, ':host')}\n`
    : '/* Prefer Tailwind utilities in the template */\n';

  return [
    { path: info.files[0], content: ts },
    { path: info.files[1], content: html },
    { path: info.files[2], content: scssOut }
  ];
}

/**
 * Build Angular files for a failed migration unit from matching React source.
 */
export function synthesizeAngularUnitFromReact(unit, filesMap) {
  if (!unit?.files?.length || !filesMap) return [];
  const destTs = (unit.files || []).find((f) => /\.component\.ts$/i.test(f.newPath));
  if (!destTs) {
    const out = [];
    for (const f of unit.files) {
      const expected = String(f.newPath).replace(/\\/g, '/');
      const wanted = path.posix.basename(expected);
      for (const [rel, content] of Object.entries(filesMap)) {
        const n = String(rel).replace(/\\/g, '/');
        const base = path.posix.basename(n).replace(/\.tsx$/i, '.ts');
        if (base === wanted || path.posix.basename(n) === wanted) {
          out.push({ path: expected, content: String(content || '') });
          break;
        }
      }
    }
    return out;
  }
  const destStem = path.posix
    .basename(destTs.newPath)
    .replace(/\.component\.ts$/i, '');
  let sourceRel = '';
  let tsx = '';
  for (const [rel, content] of Object.entries(filesMap)) {
    const n = String(rel).replace(/\\/g, '/');
    if (!/\.(tsx|jsx)$/i.test(n)) continue;
    if (isReactBootstrapPath(n)) continue;
    const stem = toKebabName(path.posix.basename(n).replace(/\.(tsx|jsx)$/i, ''));
    if (stem === destStem || n.includes(`/${destStem}/`)) {
      sourceRel = n;
      tsx = String(content || '');
      break;
    }
  }
  if (!tsx) return [];
  const scssRel = Object.keys(filesMap).find((rel) => {
    const n = rel.replace(/\\/g, '/');
    return (
      /\.(scss|css)$/i.test(n) &&
      toKebabName(path.posix.basename(n).replace(/\.(scss|css)$/i, '')) === destStem
    );
  });
  const dest = angularDestForReactSource(sourceRel);
  const info = dest && dest.kind === 'component'
    ? dest
    : {
        kind: 'component',
        kebab: destStem,
        className: `${toPascalName(destStem)}Component`,
        selector: `app-${destStem}`,
        files: unit.files.map((f) => f.newPath)
      };
  info.files = unit.files.map((f) => String(f.newPath).replace(/\\/g, '/'));
  info.kebab = destStem;
  info.className = `${toPascalName(destStem)}Component`;
  info.selector = `app-${destStem}`;
  return reactTsxToAngularTriad({
    sourceRel,
    tsx,
    scss: scssRel ? filesMap[scssRel] : '',
    dest: info
  });
}

function findMatchingBrace(text, openIdx) {
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
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isStubMethodBody(body) {
  const t = String(body || '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (!t) return true;
  if (/^return;?$/.test(t)) return true;
  if (/return\s+_args\b/.test(t)) return true;
  if (/^throw new Error/.test(t)) return true;
  if (/not implemented|TODO|FIXME/i.test(t) && t.length < 80) return true;
  return t.length < 6;
}

function isThinTemplate(html) {
  const t = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .trim();
  if (t.length < 40) return true;
  return /placeholder|coming soon|not implemented|todo component/i.test(t);
}

function sourceHandlerNames(tsx) {
  const names = new Set();
  const src = String(tsx || '');
  for (const m of src.matchAll(
    /const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)(?:\s*:\s*[^=\{]+)?\s*=>\s*\{/g
  )) {
    if (/^(use[A-Z]|set[A-Z])/.test(m[1])) continue;
    names.add(m[1]);
  }
  return [...names];
}

function extractClassMethods(source) {
  const classMatch = String(source || '').match(/export\s+class\s+\w+[^{]*\{/);
  if (!classMatch || classMatch.index == null) return [];
  const open = classMatch.index + classMatch[0].length - 1;
  const close = findMatchingBrace(source, open);
  if (close < 0) return [];
  const body = source.slice(open + 1, close);
  const methods = [];
  const re =
    /(?:^|(?<=[\n}]))([ \t]*(?:public|protected|private|override|async\s+)*(?!constructor\b)(\w+)\s*\([^;{]*\)\s*(?::[^{]+)?\{)/g;
  let m;
  while ((m = re.exec(body))) {
    if (/^(if|for|while|switch|catch|get|set)$/.test(m[2])) continue;
    const absOpen = open + 1 + m.index + m[1].length - 1;
    const absClose = findMatchingBrace(source, absOpen);
    if (absClose < 0) continue;
    const methodBody = source.slice(absOpen + 1, absClose);
    methods.push({
      name: m[2],
      start: open + 1 + m.index,
      end: absClose + 1,
      body: methodBody,
      full: source.slice(open + 1 + m.index, absClose + 1)
    });
  }
  return methods;
}

function extractSynClassMembers(synTs) {
  const classMatch = String(synTs || '').match(/export\s+class\s+\w+[^{]*\{/);
  if (!classMatch || classMatch.index == null) return { fields: '', methods: [] };
  const open = classMatch.index + classMatch[0].length - 1;
  const close = findMatchingBrace(synTs, open);
  if (close < 0) return { fields: '', methods: [] };
  const methods = extractClassMethods(synTs);
  let cursor = open + 1;
  const fieldParts = [];
  const sorted = [...methods].sort((a, b) => a.start - b.start);
  for (const method of sorted) {
    fieldParts.push(synTs.slice(cursor, method.start));
    cursor = method.end;
  }
  fieldParts.push(synTs.slice(cursor, close));
  return { fields: fieldParts.join('').trim(), methods };
}

function classHasMemberName(source, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `@(?:Input|Output)\\s*\\([^)]*\\)\\s*(?:readonly\\s+)?${esc}\\b|\\b${esc}\\s*[!=:(]|\\b${esc}\\s*\\(`
  ).test(source);
}

function classHasInputOrOutput(source, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `@(?:Input|Output)\\s*\\([^)]*\\)\\s*(?:readonly\\s+)?${esc}\\b|` +
      `(?:readonly\\s+)?${esc}\\s*=\\s*(?:input|output|model)\\s*(?:<[^>]*>)?\\s*\\(`
  ).test(source);
}

function insertBeforeClassClose(source, snippet) {
  const classMatch = String(source || '').match(/export\s+class\s+\w+[^{]*\{/);
  if (!classMatch || classMatch.index == null) return source;
  const open = classMatch.index + classMatch[0].length - 1;
  const close = findMatchingBrace(source, open);
  if (close < 0) return source;
  const block = snippet.trim();
  if (!block) return source;
  return `${source.slice(0, close)}\n${block}\n${source.slice(close)}`;
}

function replaceMethod(source, method, replacement) {
  return `${source.slice(0, method.start)}\n${replacement.trim()}\n${source.slice(method.end)}`;
}

function mergeClassBehavior(destTs, synTs) {
  let out = destTs;
  const destMethods = extractClassMethods(out);
  const byName = new Map(destMethods.map((m) => [m.name, m]));
  const syn = extractSynClassMembers(synTs);

  for (const synMethod of syn.methods) {
    if (isStubMethodBody(synMethod.body)) continue;
    const existing = byName.get(synMethod.name);
    if (!existing) {
      // @Output() onClose + method onClose is TS2300. Keep the decorator member.
      if (classHasInputOrOutput(out, synMethod.name)) continue;
      out = insertBeforeClassClose(out, synMethod.full);
      continue;
    }
    if (isStubMethodBody(existing.body)) {
      out = replaceMethod(out, existing, synMethod.full);
      const refreshed = extractClassMethods(out);
      byName.clear();
      for (const method of refreshed) byName.set(method.name, method);
    }
  }

  const synFields = syn.fields
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('ngOnChanges') && l.includes(';'));
  for (const line of synFields) {
    const name = line
      .replace(/@\w+\([^)]*\)\s*/g, '')
      .replace(/^(?:public|protected|private|readonly)\s+/, '')
      .match(/^(\w+)/)?.[1];
    if (!name || classHasMemberName(out, name)) continue;
    out = insertBeforeClassClose(out, `  ${line}`);
  }

  const synConsts = [...String(synTs).matchAll(/^const\s+[A-Z_][A-Z0-9_]*\s*=/gm)];
  for (const m of synConsts) {
    const name = m[0].match(/^const\s+(\w+)/)[1];
    if (new RegExp(`\\bconst\\s+${name}\\b`).test(out)) continue;
    const block = String(synTs).match(new RegExp(`const\\s+${name}[\\s\\S]*?;\\n`));
    if (block) {
      out = out.replace(/(@Component\s*\()/, `${block[0]}\n$1`);
    }
  }
  return out;
}

function extractElement(html, tag) {
  const src = String(html || '');
  const self = src.match(new RegExp(`<${tag}\\b[^>]*/>`, 'i'));
  if (self) return self[0];
  const open = src.match(new RegExp(`<${tag}\\b[^>]*>`, 'i'));
  if (!open) return '';
  const start = src.indexOf(open[0]);
  const closeTag = `</${tag}>`;
  const end = src.indexOf(closeTag, start);
  if (end < 0) return open[0];
  return src.slice(start, end + closeTag.length);
}

function mergeMissingBindings(destHtml, synHtml, destTs = '') {
  let out = String(destHtml || '');
  if (isThinTemplate(out) && String(synHtml || '').trim()) return String(synHtml);

  const synTags = [...String(synHtml || '').matchAll(/<([a-z][\w-]*)(\s[^>]*)?>/gi)];
  for (const m of synTags) {
    const tag = m[1];
    const synAttrs = m[2] || '';
    const bindings = [...synAttrs.matchAll(/((?:\[[\w.]+\]|\([\w.]+\)|\[\w+\])\s*=\s*"[^"]*")/g)].map(
      (b) => b[1].trim()
    );
    if (!bindings.length && !tag.startsWith('app-')) continue;
    if (!tag.startsWith('app-') && tag !== 'form' && !tag.startsWith('mat-')) continue;

    if (!new RegExp(`<${tag}\\b`, 'i').test(out)) {
      if (!tag.startsWith('app-')) continue;
      const snippet = extractElement(synHtml, tag) || `<${tag}${synAttrs || ''}></${tag}>`;
      if (/sidebar|form|drawer/i.test(tag) && /<mat-sidenav\b/i.test(out)) {
        out = out.replace(/(<mat-sidenav\b[^>]*>)/i, `$1\n    ${snippet}\n`);
      } else if (/dialog|modal|delete|confirm/i.test(tag)) {
        if (/<\/mat-sidenav-container>/i.test(out)) {
          out = out.replace(/<\/mat-sidenav-container>/i, `  ${snippet}\n</mat-sidenav-container>`);
        } else {
          out = `${out.trim()}\n${snippet}\n`;
        }
      } else if (/<section\b/i.test(out)) {
        out = out.replace(/(<section\b[^>]*>)/i, `$1\n      ${snippet}\n`);
      } else if (/<main\b/i.test(out)) {
        out = out.replace(/(<main\b[^>]*>)/i, `$1\n    ${snippet}\n`);
      } else {
        out = `${out.trim()}\n${snippet}\n`;
      }
      continue;
    }

    out = out.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, 'i'), (full, destAttrs = '') => {
      let attrs = destAttrs || '';
      for (const binding of bindings) {
        const key = binding.match(/^((?:\[[\w.]+\]|\([\w.]+\)|\[\w+\]))/)?.[1];
        if (!key) continue;
        const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const existing = attrs.match(new RegExp(`(${keyEsc}\\s*=\\s*")([^"]*)(")`));
        if (existing) {
          const handler = existing[2].match(/^(\w+)\s*\(/)?.[1];
          const method = handler ? destMethodByName(destTs, handler) : null;
          if (handler && method && isStubMethodBody(method.body)) {
            attrs = attrs.replace(existing[0], binding);
          }
          continue;
        }
        const evt = key.match(/^\((\w+)\)$/)?.[1];
        if (evt) {
          let relatedName = '';
          if (/^on[A-Z]/.test(evt)) {
            relatedName = evt.slice(2);
            relatedName = relatedName
              ? relatedName.charAt(0).toLowerCase() + relatedName.slice(1)
              : '';
          } else {
            relatedName = `on${evt.charAt(0).toUpperCase()}${evt.slice(1)}`;
          }
          if (relatedName && new RegExp(`\\(${relatedName}\\)\\s*=`).test(attrs)) continue;
        }
        attrs += ` ${binding}`;
      }
      return `<${tag}${attrs}>`;
    });
  }

  const synButtons = [...synHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  for (const synBtn of synButtons) {
    const click = synBtn[1].match(/\(click\)="([^"]+)"/)?.[1];
    if (!click || out.includes(`(click)="${click}"`)) continue;
    const innerNorm = synBtn[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!innerNorm) continue;
    out = out.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (full, attrs, inner) => {
      if (/\(click\)=/.test(attrs)) return full;
      const destInner = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (destInner !== innerNorm && !destInner.includes(innerNorm) && !innerNorm.includes(destInner)) {
        return full;
      }
      return `<button${attrs} (click)="${click}">${inner}</button>`;
    });
  }
  return out;
}

function mergeMissingImports(destTs, synTs) {
  let out = destTs;
  const synNgImports = synTs.match(/imports\s*:\s*\[([\s\S]*?)\]/);
  const destNgImports = out.match(/imports\s*:\s*\[([\s\S]*?)\]/);
  if (synNgImports && destNgImports) {
    const synNames = synNgImports[1].split(',').map((s) => s.trim()).filter(Boolean);
    const destNames = destNgImports[1].split(',').map((s) => s.trim()).filter(Boolean);
    const destSet = new Set(destNames);
    const added = synNames.filter((n) => n && !destSet.has(n));
    if (added.length) {
      const merged = [...destNames, ...added].filter(Boolean).join(', ');
      out = out.replace(/imports\s*:\s*\[([\s\S]*?)\]/, `imports: [${merged}]`);
    }
  }
  for (const m of synTs.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const symbols = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const from = m[2];
    for (const sym of symbols) {
      const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fromEsc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`import\\s*\\{[^}]*\\b${esc}\\b`).test(out)) continue;
      if (new RegExp(`from\\s+['"]${fromEsc}['"]`).test(out) && new RegExp(`\\b${esc}\\b`).test(out)) {
        continue;
      }
      out = `import { ${sym} } from '${from}';\n${out}`;
    }
  }
  return out;
}

function walkComponentTsFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkComponentTsFiles(full, results);
    } else if (entry.name.endsWith('.component.ts')) {
      results.push(full);
    }
  }
  return results;
}

function findDestComponentFiles(destPath, sourceRel) {
  const planned = angularDestForReactSource(sourceRel);
  if (planned?.kind === 'component') {
    const ts = path.join(destPath, planned.files[0]);
    if (fs.existsSync(ts)) {
      return {
        ts,
        html: ts.replace(/\.ts$/, '.html'),
        scss: ts.replace(/\.ts$/, '.scss'),
        info: planned
      };
    }
  }
  const stem = toKebabName(path.posix.basename(String(sourceRel)).replace(/\.(tsx|jsx)$/i, ''));
  const hits = walkComponentTsFiles(path.join(destPath, 'src')).filter(
    (f) => path.basename(f) === `${stem}.component.ts`
  );
  if (!hits.length) return null;
  const ts = hits[0];
  return {
    ts,
    html: ts.replace(/\.ts$/, '.html'),
    scss: ts.replace(/\.ts$/, '.scss'),
    info: planned
  };
}

function destMethodByName(destTs, name) {
  return extractClassMethods(destTs).find((m) => m.name === name);
}

/**
 * True when the Angular component is missing source handlers (empty methods or
 * no matching method at all). Used to decide whether a source-backed restore
 * or a follow-up AI parity pass is still needed.
 */
export function collectAngularBehaviorGaps(destPath, sourceFilesMap) {
  const gaps = [];
  if (!sourceFilesMap) return gaps;
  for (const [rel, content] of Object.entries(sourceFilesMap)) {
    const n = String(rel).replace(/\\/g, '/');
    if (!/\.(tsx|jsx)$/i.test(n) || isReactBootstrapPath(n)) continue;
    const tsx = String(content || '');
    const handlers = sourceHandlerNames(tsx);
    if (!handlers.length) continue;
    const dest = findDestComponentFiles(destPath, n);
    if (!dest || !fs.existsSync(dest.ts)) {
      gaps.push({ source: n, reason: 'missing-component' });
      continue;
    }
    const destTs = fs.readFileSync(dest.ts, 'utf-8');
    const destHtml = fs.existsSync(dest.html) ? fs.readFileSync(dest.html, 'utf-8') : '';
    const missing = handlers.filter((name) => {
      const method = destMethodByName(destTs, name);
      return !method || isStubMethodBody(method.body);
    });
    for (const method of extractClassMethods(destTs)) {
      if (!isStubMethodBody(method.body)) continue;
      if (!new RegExp(`\\b${method.name}\\s*\\(`).test(destHtml)) continue;
      if (!missing.includes(method.name)) missing.push(method.name);
    }
    const synHasForm = /onSubmit|handleSubmit|<form\b/.test(tsx);
    const destHasSubmit = /\(ngSubmit\)=|<form\b/.test(destHtml);
    if (missing.length || (synHasForm && !destHasSubmit && isThinTemplate(destHtml))) {
      gaps.push({
        source: n,
        dest: path.relative(destPath, dest.ts).replace(/\\/g, '/'),
        missingHandlers: missing
      });
    }
  }
  return gaps;
}

/**
 * After AI conversion, overlay real source behavior onto stub Angular components.
 * Works for any uploaded React project — not tied to a specific sample app.
 */
export function restoreAngularBehaviorFromReact(destPath, sourceFilesMap) {
  if (!destPath || !sourceFilesMap) return { changed: 0, gaps: [] };
  let changed = 0;
  for (const [rel, content] of Object.entries(sourceFilesMap)) {
    const n = String(rel).replace(/\\/g, '/');
    if (!/\.(tsx|jsx)$/i.test(n) || isReactBootstrapPath(n)) continue;
    const tsx = String(content || '');
    if (!tsx.trim() || !/</.test(tsx)) continue;
    const dest = findDestComponentFiles(destPath, n);
    if (!dest) continue;
    const planned = dest.info || angularDestForReactSource(n);
    if (!planned || planned.kind !== 'component') continue;
    const scssRel = Object.keys(sourceFilesMap).find((key) => {
      const p = String(key).replace(/\\/g, '/');
      return (
        /\.(scss|css)$/i.test(p) &&
        path.posix.dirname(p) === path.posix.dirname(n) &&
        toKebabName(path.posix.basename(p).replace(/\.(scss|css)$/i, '')) ===
          toKebabName(path.posix.basename(n).replace(/\.(tsx|jsx)$/i, ''))
      );
    });
    const synthesized = reactTsxToAngularTriad({
      sourceRel: n,
      tsx,
      scss: scssRel ? sourceFilesMap[scssRel] : '',
      dest: {
        ...planned,
        files: [
          path.relative(destPath, dest.ts).replace(/\\/g, '/'),
          path.relative(destPath, dest.html).replace(/\\/g, '/'),
          path.relative(destPath, dest.scss).replace(/\\/g, '/')
        ]
      }
    });
    if (!synthesized.length) continue;
    const synTs = synthesized.find((f) => /\.ts$/i.test(f.path))?.content || '';
    const synHtml = synthesized.find((f) => /\.html$/i.test(f.path))?.content || '';
    const synScss = synthesized.find((f) => /\.scss$/i.test(f.path))?.content || '';

    let destTs = fs.existsSync(dest.ts) ? fs.readFileSync(dest.ts, 'utf-8') : '';
    let destHtml = fs.existsSync(dest.html) ? fs.readFileSync(dest.html, 'utf-8') : '';
    let destScss = fs.existsSync(dest.scss) ? fs.readFileSync(dest.scss, 'utf-8') : '';
    const before = destTs + destHtml + destScss;

    if (!destTs.trim()) {
      destTs = synTs;
      destHtml = synHtml;
      destScss = synScss || destScss;
    } else {
      destTs = mergeClassBehavior(destTs, synTs);
      destTs = mergeMissingImports(destTs, synTs);
      destHtml = mergeMissingBindings(destHtml, synHtml, destTs);
      const inferred = repairInferredTemplateHandlers(destTs, destHtml);
      destTs = inferred.source;
      destHtml = inferred.html;
      if ((!destScss || destScss.trim().length < 20) && synScss.trim().length > 20) {
        destScss = synScss;
      }
    }

    if (destTs + destHtml + destScss !== before) {
      fs.mkdirSync(path.dirname(dest.ts), { recursive: true });
      fs.writeFileSync(dest.ts, destTs.endsWith('\n') ? destTs : `${destTs}\n`, 'utf-8');
      fs.writeFileSync(dest.html, destHtml.endsWith('\n') ? destHtml : `${destHtml}\n`, 'utf-8');
      if (destScss != null) {
        fs.writeFileSync(dest.scss, destScss.endsWith('\n') ? destScss : `${destScss}\n`, 'utf-8');
      }
      changed += 1;
    }
  }
  return { changed, gaps: collectAngularBehaviorGaps(destPath, sourceFilesMap) };
}
