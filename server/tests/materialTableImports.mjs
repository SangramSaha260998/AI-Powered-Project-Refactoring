import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inferDeclarablePackage,
  declarablesNeededByHtml,
  repairInvalidMaterialTableImports,
} from '../src/services/postprocess.js';

assert.equal(inferDeclarablePackage('MatCellDefModule'), '@angular/material/table');
assert.equal(inferDeclarablePackage('MatFooterRowDefModule'), '@angular/material/table');

const tableHtml = `<table mat-table [dataSource]="dataSource">
  <ng-container matColumnDef="name">
    <th mat-header-cell *matHeaderCellDef>Name</th>
    <td mat-cell *matCellDef="let row">{{ row.name }}</td>
  </ng-container>
  <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
  <tr mat-row *matRowDef="let row; columns: displayedColumns"></tr>
</table>`;

const needed = declarablesNeededByHtml(tableHtml);
assert.ok(needed.includes('MatTableModule'));
assert.ok(!needed.includes('MatCellDefModule'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-import-'));
const dir = path.join(tmp, 'src', 'app', 'list');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'list.component.ts'),
  `import { Component } from '@angular/core';
import { MatHeaderCellDefModule } from '@angular/material/header-cell-def';
import { MatCellDefModule } from '@angular/material/cell-def';
import { MatHeaderRowDefModule } from '@angular/material/header-row-def';
import { MatRowDefModule } from '@angular/material/row-def';

@Component({
  selector: 'app-list',
  standalone: true,
  imports: [MatHeaderCellDefModule, MatCellDefModule, MatHeaderRowDefModule, MatRowDefModule],
  templateUrl: './list.component.html',
})
export class ListComponent {
  displayedColumns = ['name'];
}
`,
);
fs.writeFileSync(path.join(dir, 'list.component.html'), tableHtml);

assert.equal(repairInvalidMaterialTableImports(tmp), 1);
const ts = fs.readFileSync(path.join(dir, 'list.component.ts'), 'utf-8');
assert.doesNotMatch(ts, /@angular\/material\/cell-def/);
assert.doesNotMatch(ts, /@angular\/material\/header-row-def/);
assert.match(ts, /@angular\/material\/table/);
assert.match(ts, /MatTableModule/);

console.log('materialTableImports.mjs: all assertions passed');
