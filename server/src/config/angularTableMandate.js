/**
 * Short, high-priority table rules — injected for list/table migration units.
 * The full list guide is too long for models to follow reliably without this block.
 */

export const ANGULAR_TABLE_MANDATE = `
## ANGULAR TABLE — HARD RULES (NON-NEGOTIABLE)

### FORBIDDEN
- Plain HTML \`<table>\`, \`<thead>\`, \`<tbody>\` **without** \`mat-table\`
- Bootstrap / Tailwind-only data grids with no Material table
- Separate \`*-table\` child components for simple CRUD lists (put the grid in \`*-list.component\`)

### REQUIRED for every list / data grid
1. **Angular Material table**: \`MatTableModule\` + \`MatTableDataSource<T>\`
2. **Template classes**: \`class="mat-table" mat-table [dataSource]="dataSource"\`
3. **Column defs**: each column = \`ng-container matColumnDef="..."\` with:
   - \`<div class="custom-datatable-header"><p>Label</p></div>\` in header
   - \`<div class="custom-datatable-cont">...</div>\` in cell
4. **Rows**: \`displayedColumns: string[]\`, \`mat-header-row\`, \`mat-row\`
5. **Empty state**: \`matColumnDef="noRecords"\` footer row + \`no-records-table\` block (not a custom empty div)
6. **Actions column**: \`list-icon-rounded\` + \`custom-table-tooltip\` + SVG from \`/scss/icons.svg\`
7. **List page wrapper**: \`custom-page-wrapper custom-page-wrapper-list\`
8. **Pagination** (list pages): \`mat-paginator appPagination\` + "Showing X to Y of Z"

### FORBIDDEN imports (do NOT use — they are not real npm entry points)
\`\`\`typescript
// WRONG — will break the build:
import { MatCellDefModule } from '@angular/material/cell-def';
import { MatHeaderRowDefModule } from '@angular/material/header-row-def';
import { MatRowDefModule } from '@angular/material/row-def';
// ... any *-def subpath under @angular/material/
\`\`\`
**Only** import table symbols from \`@angular/material/table\`:
\`import { MatTableModule, MatTableDataSource } from '@angular/material/table';\`
\`MatTableModule\` already includes \`*matCellDef\`, \`*matHeaderRowDef\`, \`matColumnDef\`, etc.

### TypeScript minimum (list or inline table)
\`\`\`typescript
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatPaginator, PageEvent } from '@angular/material/paginator';
import { PaginatorDirective } from '@app/shared/directives';

public dataSource = new MatTableDataSource<MyRow>([]);
public displayedColumns = ['name', 'status', 'action'];

// When data loads:
this.dataSource = new MatTableDataSource<MyRow>(rows);
\`\`\`

### Simple CRUD list (no server pagination yet)
Still use \`mat-table\` + \`MatTableDataSource\` — bind \`dataSource.data = items\` from local array or store.
Do NOT fall back to \`<table class="task-table">\`.

If the source React app used a plain HTML table, convert it to **mat-table** anyway.
`;

export function isAngularTableUnit(unit) {
  const paths = (unit?.files || []).map((f) => String(f.newPath || '').toLowerCase());
  return paths.some(
    (p) =>
      p.includes('-list.component') ||
      p.includes('/list/') ||
      p.includes('-table.component') ||
      p.includes('/table/') ||
      p.includes('datatable') ||
      p.includes('data-table'),
  );
}

export function angularTableOutputViolatesMandate(parsedFiles) {
  const invalidImportRe =
    /@angular\/material\/(?:cell-def|header-cell-def|footer-cell-def|header-row-def|row-def|footer-row-def|column-def|def)/;
  for (const file of parsedFiles || []) {
    const p = String(file.path || '').toLowerCase();
    const content = String(file.content || '');
    if (invalidImportRe.test(content)) return true;
    if (/\bMat(?:Header|Footer)?(?:Cell|Row)DefModule\b/.test(content) &&
      !/from\s*['"]@angular\/material\/table['"]/.test(content)) {
      return true;
    }
    if (!p.endsWith('.html')) continue;
    if (!/(list|table)/.test(p)) continue;
    if (/<table\b/i.test(content) && !/\bmat-table\b/i.test(content)) {
      return true;
    }
    if (/\bmat-table\b/i.test(content) && !/custom-datatable-header/i.test(content)) {
      return true;
    }
  }
  return false;
}

export const ANGULAR_TABLE_RETRY_SUFFIX = `
CRITICAL TABLE VIOLATION — your last output was REJECTED.
- You used a plain HTML <table> OR mat-table without custom-datatable-header/cont.
- You imported table directives from fake paths like @angular/material/cell-def — use ONLY:
  import { MatTableModule, MatTableDataSource } from '@angular/material/table';
- Regenerate using Angular Material mat-table + MatTableDataSource exactly as in ANGULAR TABLE MANDATE.
- Put the table in the *-list.component (not a separate *-table child) unless the source had a reusable grid with its own API.
- Include noRecords footer row, not a custom @if empty div above the table.
`;
