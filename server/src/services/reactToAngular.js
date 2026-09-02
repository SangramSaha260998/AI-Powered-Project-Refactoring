/**
 * Mechanical React → Angular conversion used when the AI unit writer fails.
 * Produces a standalone component triad from a function-component TSX file.
 */
import path from 'path';
import { declarablesNeededByHtml, inferDeclarablePackage } from './postprocess.js';

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
      return `<mat-form-field appearance="outline"><mat-label>${label}</mat-label><${tag} matInput${a}></${tag}></mat-form-field>`;
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
  h = h.replace(/\btask=\{([^}]+)\}/g, '[task]="$1"');
  h = h.replace(/\btasks=\{([^}]+)\}/g, '[tasks]="$1"');
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
      return `@if (${expr}) {\n<div class="task-delete-dialog">`;
    }
    return '<div class="task-delete-dialog">';
  });
  h = h.replace(/<\/ng-container>/g, '</div>\n}');
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
  const re = /const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n  \};/g;
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
    const folder = kebab.includes('task-list')
      ? `src/app/pages/${kebab}`
      : `src/app/components/${kebab}`;
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
  html = html.replace(/\bTASK_STATUS_LABELS\b/g, 'statusLabels');
  html = html.replace(/\bTASK_STATUS_OPTIONS\b/g, 'statusOptions');
  html = html.replace(/\(click\)="(\w+)\(\$event\)"/g, (full, name) => {
    if (name.startsWith('set') || name.startsWith('on') || name === 'openAdd' || name === 'openEdit') {
      return full.replace('($event)', '()');
    }
    return full;
  });
  html = html.replace(/\(click\)="openAdd\(\$event\)"/g, '(click)="openAdd()"');
  html = html.replace(/\(remove\)="setDeletingTask\(\$event\)"/g, '(remove)="deletingTask = $event"');
  html = html.replace(/<mat-sidenav([\s\S]*?)\[open\]=/g, '<mat-sidenav$1[opened]=');
  html = html.replace(/track option\.id/g, 'track option');
  html = html.replace(/\(click\)="onEdit\(task[^"]*/g, '(click)="onEdit(task)"');
  html = html.replace(/\(click\)="onRemove\(task[^"]*/g, '(click)="onRemove(task)"');

  const states = parseUseState(tsx);
  const props = parseProps(tsx);
  const body = extractComponentBody(tsx);
  const methods = extractMethods(body, states);
  const moduleConsts = [...tsx.matchAll(/^const\s+([A-Z_][A-Z0-9_]*)[^=]*=\s*([\s\S]*?);$/gm)];

  const tsPath = info.files[0];
  const ngModules = materialImportsForHtml(html);
  const children = childComponentImports(html, tsPath);
  const needsOnChanges = /useEffect\(/.test(tsx) && props.names.includes('task');
  const usesTaskModel = /\bTask\b/.test(tsx);
  const modelImport = usesTaskModel
    ? `import { Task${/TaskDraft/.test(tsx) ? ', TaskDraft' : ''}${/\bTaskStatus\b/.test(tsx) ? ', TaskStatus' : ''}${/TASK_STATUS_LABELS/.test(tsx) ? ', TASK_STATUS_LABELS' : ''}${/TASK_STATUS_OPTIONS/.test(tsx) ? ', TASK_STATUS_OPTIONS' : ''} } from '${relativeImport(tsPath, 'src/app/models/task.model')}';\n`
    : '';

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
  if (modelImport) importLines.push(modelImport.trim());

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
  if (/TASK_STATUS_LABELS/.test(tsx)) extraFields.push('  readonly statusLabels = TASK_STATUS_LABELS;');
  if (/TASK_STATUS_OPTIONS/.test(tsx)) extraFields.push('  readonly statusOptions = TASK_STATUS_OPTIONS;');
  const getters = [];
  if (/\bheading\b/.test(html)) {
    getters.push(`  get heading(): string {\n    return this.task ? 'Edit task' : 'Add task';\n  }`);
  }
  if (/\bsubmitLabel\b/.test(html)) {
    getters.push(`  get submitLabel(): string {\n    return this.task ? 'Update' : 'Add';\n  }`);
  }

  const constDecls = moduleConsts.map((m) => `const ${m[1]} = ${m[2]};`);
  const thisNames = [
    ...states.map((s) => s.name),
    ...props.fields.map((f) => f.name),
    ...methods.map((m) => m.name),
    'title',
    'description',
    'status',
    'titleTouched'
  ];

  const methodText = [
    ...methods.map((fn) => {
      let inner = fn.body
        .replace(/\bthis\.(\w+) = \(([\s\S]*?)\);/g, 'this.$1 = $2;')
        .replace(/\bcloseSidebar\(\)/g, 'this.closeSidebar()')
        .replace(/\bopenAdd\(\)/g, 'this.openAdd()')
        .replace(/\bonSave\(/g, 'this.save.emit(')
        .replace(/\bFormEvent\b/g, 'Event');
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
    onChanges = `
  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['task']) return;
    if (this.task) {
      this.title = this.task.title;
      this.description = this.task.description;
      this.status = this.task.status;
    } else {
      this.title = '';
      this.description = '';
      this.status = 'todo';
    }
    this.titleTouched = false;
  }
`;
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
