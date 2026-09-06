/**
 * Mechanical repair: plain HTML tables → Angular Material mat-table pattern.
 */

import fs from 'fs';
import path from 'path';

function walkComponentHtmlFiles(destPath) {
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
      if (name.endsWith('.component.html')) {
        results.push(full);
      }
    }
  };
  walk(srcRoot);
  return results;
}

function isPlainHtmlTable(html) {
  return /<table\b/i.test(html) && !/\bmat-table\b/i.test(html);
}

function slugify(label, index) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return base || `col${index}`;
}

function parseHeaders(html) {
  const thead = html.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || '';
  return [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').trim(),
  );
}

function parseForLoop(html) {
  const m = html.match(/@for\s*\(\s*(\w+)\s+of\s+([\w.]+)/);
  return { rowVar: m?.[1] || 'row', collection: m?.[2] || 'items' };
}

function parseCellExpressions(html, rowVar) {
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || html;
  const rowMatch = tbody.match(new RegExp(`@for\\s*\\([\\s\\S]*?\\)\\s*\\{([\\s\\S]*?)\\}`, 'i'));
  const rowBody = rowMatch?.[1] || tbody;
  const cells = [...rowBody.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].trim());
  return cells.map((cell) => {
    if (/<button\b/i.test(cell) || /\(click\)/i.test(cell)) {
      return { type: 'action', raw: cell };
    }
    const interps = [...cell.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim());
    const expr = interps.find((e) => e.includes('.')) || interps[0] || `${rowVar}`;
    return { type: 'text', expr };
  });
}

function parseMatTableRowVar(html) {
  const m = html.match(/matCellDef="let\s+(\w+)"/);
  return m?.[1] || 'row';
}

function parseMatColumnDefs(html) {
  return [...html.matchAll(/matColumnDef="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== 'noRecords');
}

function needsMatTableTsCompletion(html, tsSource) {
  return (
    /\bmat-table\b/i.test(html) &&
    (!/MatTableDataSource/.test(tsSource) ||
      !/imports:\s*\[[^\]]*MatTableModule/.test(tsSource) ||
      /<matColumnDef="action"[\s\S]*?\{\{\s*task\s*\}\}/i.test(html))
  );
}

function fixMatTableCellBindings(html, rowVar, columns) {
  let out = html;
  for (const col of columns) {
    if (col.type === 'action') continue;
    const re = new RegExp(
      `(matColumnDef="${col.key}"[\\s\\S]*?<p[^>]*>)(\\{\\{[^}]+\\}\\})(</p>)`,
      'i',
    );
    out = out.replace(re, `$1{{ ${col.expr} }}$3`);
    const titleRe = new RegExp(
      `(matColumnDef="${col.key}"[\\s\\S]*?\\[title\\]=")([^"]*)(")`,
      'i',
    );
    out = out.replace(titleRe, `$1${col.expr} || '--'$3`);
  }
  return out;
}

function extractInputArrayName(tsSource) {
  const m = tsSource.match(/@Input\(\)\s+(\w+)\s*:\s*\w+\[\]/);
  return m?.[1] || 'items';
}

function extractOutputs(tsSource) {
  const outputs = [...tsSource.matchAll(/@Output\(\)\s+(\w+)/g)].map((m) => m[1]);
  return outputs;
}

function buildMatTableTs(tsSource, columns, inputName) {
  let source = tsSource;
  const colKeys = columns.map((c) => c.key);

  if (!/from '@angular\/material\/table'/.test(source)) {
    source = `import { MatTableDataSource, MatTableModule } from '@angular/material/table';\n${source}`;
  } else if (!/MatTableModule/.test(source)) {
    source = source.replace(
      /import\s*\{([^}]*)\}\s*from\s*'@angular\/material\/table'/,
      (full, names) => {
        const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
        if (!parts.includes('MatTableModule')) parts.push('MatTableModule');
        if (!parts.includes('MatTableDataSource')) parts.push('MatTableDataSource');
        return `import { ${parts.join(', ')} } from '@angular/material/table'`;
      },
    );
  }

  if (!/imports:\s*\[[^\]]*MatTableModule/.test(source) && /imports:\s*\[/.test(source)) {
    source = source.replace(/imports:\s*\[/, 'imports: [MatTableModule, ');
  }

  if (!/dataSource\s*=/.test(source)) {
    source = source.replace(
      /export class \w+[^{]*\{/,
      (m) => `${m}\n  public dataSource = new MatTableDataSource<unknown>([]);`,
    );
  }

  if (!/displayedColumns/.test(source)) {
    source = source.replace(
      /(public dataSource[^\n]*\n)/,
      (m) => `${m}  public displayedColumns: string[] = ${JSON.stringify(colKeys)};\n`,
    );
    if (!/displayedColumns/.test(source)) {
      source = source.replace(
        /export class \w+[^{]*\{/,
        (m) => `${m}\n  public displayedColumns: string[] = ${JSON.stringify(colKeys)};\n`,
      );
    }
  } else {
    source = source.replace(
      /displayedColumns[^=]*=\s*\[[^\]]*\]/,
      `displayedColumns: string[] = ${JSON.stringify(colKeys)}`,
    );
  }

  const inputRe = new RegExp(
    `@Input\\(\\)\\s+${inputName}\\s*:\\s*([^;=]+)(?:\\s*=\\s*[^;]+)?;`,
  );
  if (inputRe.test(source) && !source.includes(`set ${inputName}(`)) {
    source = source.replace(inputRe, (_, typePart) => {
      const typeName = typePart.trim();
      return `@Input() set ${inputName}(value: ${typeName}) {
    this._${inputName} = value || [];
    this.dataSource.data = this._${inputName};
  }
  get ${inputName}(): ${typeName} {
    return this._${inputName};
  }
  private _${inputName}: ${typeName} = [];`;
    });
  }

  return source;
}

function buildActionCell(cellHtml, rowVar, outputs) {
  const editOut = outputs.find((o) => /edit/i.test(o)) || 'edit';
  const removeOut = outputs.find((o) => /remove|delete/i.test(o)) || 'remove';
  const hasEdit = /handleEdit|edit/i.test(cellHtml) || outputs.some((o) => /edit/i.test(o));
  const hasRemove =
    /handleRemove|remove|delete/i.test(cellHtml) || outputs.some((o) => /remove|delete/i.test(o));

  let actions = '';
  if (hasEdit) {
    actions += `
            <div class="custom-table-tooltip">
              <a class="list-icon-rounded icon-setting" role="none" (click)="${editOut}.emit(${rowVar})">
                <svg><use xlink:href="/scss/icons.svg#icon-settings-secondary"></use></svg>
              </a>
              <span class="custom-table-tooltip-text">Edit</span>
            </div>`;
  }
  if (hasRemove) {
    actions += `
            <div class="custom-table-tooltip">
              <a class="list-icon-rounded icon-delete" role="none" (click)="${removeOut}.emit(${rowVar})">
                <svg><use xlink:href="/scss/icons.svg#icon-delete"></use></svg>
              </a>
              <span class="custom-table-tooltip-text">Delete</span>
            </div>`;
  }
  if (!actions) {
    actions = `<p>—</p>`;
  }
  return actions;
}

function buildMatTableHtml({ columns, rowVar, emptyMessage, actionCellHtml, outputs }) {
  const colDefs = columns
    .map((col) => {
      const cellContent =
        col.type === 'action'
          ? buildActionCell(actionCellHtml, rowVar, outputs)
          : `<p [title]="${col.expr} || '--'">{{ ${col.expr} }}</p>`;

      return `
      <ng-container matColumnDef="${col.key}">
        <th mat-header-cell *matHeaderCellDef>
          <div class="custom-datatable-header"><p>${col.label}</p></div>
        </th>
        <td mat-cell *matCellDef="let ${rowVar}">
          <div class="custom-datatable-cont">
            ${cellContent}
          </div>
        </td>
      </ng-container>`;
    })
    .join('\n');

  const displayedCols = columns.map((c) => c.key);

  return `<div class="custom-page-wrapper custom-page-wrapper-list">
  <div class="feature-list-table-wrapper">
    <table
      class="mat-table"
      mat-table
      [dataSource]="dataSource"
      [ngClass]="{ 'table-norecords': !dataSource.filteredData.length }">
${colDefs}

      <ng-container matColumnDef="noRecords">
        <mat-footer-cell *matFooterCellDef [attr.colspan]="displayedColumns.length">
          <div class="no-records-table">
            <div class="no-records-block">
              <div class="icon-block">
                <img src="images/mock-list-no-record.svg" width="54" height="65" alt="" loading="lazy" />
              </div>
              <p>${emptyMessage}</p>
            </div>
          </div>
        </mat-footer-cell>
      </ng-container>

      <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
      <tr mat-row *matRowDef="let row; columns: displayedColumns"></tr>
      <mat-footer-row
        *matFooterRowDef="['noRecords']"
        [hidden]="dataSource.data.length > 0 && dataSource.filteredData.length > 0"></mat-footer-row>
    </table>
  </div>
</div>
`;
}

function repairComponentHtmlTs(htmlPath, tsPath) {
  let html = fs.readFileSync(htmlPath, 'utf-8');
  const tsSource = fs.readFileSync(tsPath, 'utf-8');

  if (needsMatTableTsCompletion(html, tsSource)) {
    const rowVar = parseMatTableRowVar(html);
    const keys = parseMatColumnDefs(html);
    const hasStatusLabel = /getStatusLabel\s*\(/.test(tsSource);
    const columns = keys.map((key) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      type: key === 'action' ? 'action' : 'text',
      expr:
        key === 'action'
          ? ''
          : key === 'status' && hasStatusLabel
            ? `getStatusLabel(${rowVar}.status)`
            : `${rowVar}.${key}`,
    }));
    const inputName = extractInputArrayName(tsSource) || 'items';
    let newTs = buildMatTableTs(tsSource, columns, inputName);
    if (!/CommonModule/.test(newTs)) {
      newTs = newTs.replace(/imports:\s*\[/, 'imports: [CommonModule, MatTableModule, ');
      if (!/from '@angular\/common'/.test(newTs)) {
        newTs = `import { CommonModule } from '@angular/common';\n${newTs}`;
      }
    }
    html = fixMatTableCellBindings(html, rowVar, columns);
    const actionCol = columns.find((c) => c.key === 'action');
    if (actionCol) {
      const outputs = extractOutputs(tsSource);
      const actionHtml = buildActionCell('', rowVar, outputs);
      const actionRe = /(<ng-container matColumnDef="action"[\s\S]*?<div class="custom-datatable-cont">)([\s\S]*?)(<\/div>\s*<\/td>)/i;
      html = html.replace(actionRe, `$1\n            ${actionHtml}\n          $3`);
    }
    fs.writeFileSync(htmlPath, html, 'utf-8');
    fs.writeFileSync(tsPath, newTs.endsWith('\n') ? newTs : `${newTs}\n`, 'utf-8');
    return true;
  }

  if (!isPlainHtmlTable(html)) return false;
  const headers = parseHeaders(html);
  if (!headers.length) return false;

  const { rowVar, collection } = parseForLoop(html);
  const cells = parseCellExpressions(html, rowVar);
  const inputName = extractInputArrayName(tsSource) || collection.split('.')[0] || 'items';
  const outputs = extractOutputs(tsSource);

  const columns = headers.map((label, i) => {
    const key = /action/i.test(label) ? 'action' : slugify(label, i);
    const cell = cells[i] || { type: 'text', expr: `${rowVar}.${key}` };
    if (cell.type === 'action') {
      return { key: 'action', label, type: 'action', expr: '' };
    }
    return { key, label, type: 'text', expr: cell.expr || `${rowVar}.${key}` };
  });

  const actionCell = cells.find((c) => c.type === 'action')?.raw || '';
  const emptyMatch = html.match(/<p>([^<]*no[^<]*)<\/p>/i);
  const emptyMessage = emptyMatch?.[1]?.trim() || 'No records found';

  const newHtml = buildMatTableHtml({
    columns,
    rowVar,
    emptyMessage,
    actionCellHtml: actionCell,
    outputs,
  });

  let newTs = buildMatTableTs(tsSource, columns, inputName);

  // Ensure CommonModule for ngClass
  if (!/CommonModule/.test(newTs)) {
    newTs = newTs.replace(/imports:\s*\[/, 'imports: [CommonModule, ');
    if (!/from '@angular\/common'/.test(newTs)) {
      newTs = `import { CommonModule } from '@angular/common';\n${newTs}`;
    }
  }

  fs.writeFileSync(htmlPath, newHtml, 'utf-8');
  fs.writeFileSync(tsPath, newTs.endsWith('\n') ? newTs : `${newTs}\n`, 'utf-8');
  return true;
}

export function repairPlainHtmlTablesToMatTable(destPath) {
  let changed = 0;
  for (const htmlPath of walkComponentHtmlFiles(destPath)) {
    const tsPath = htmlPath.replace(/\.html$/, '.ts');
    if (!fs.existsSync(tsPath)) continue;
    try {
      if (repairComponentHtmlTs(htmlPath, tsPath)) {
        changed += 1;
        console.log(`[postprocess] Converted plain HTML table → mat-table: ${path.relative(destPath, htmlPath)}`);
      }
    } catch (err) {
      console.warn(`[postprocess] mat-table repair failed for ${htmlPath}: ${err.message}`);
    }
  }
  return changed;
}

export function unitHtmlHasPlainTableViolation(htmlContent) {
  const content = String(htmlContent || '');
  return /<table\b/i.test(content) && !/\bmat-table\b/i.test(content);
}
