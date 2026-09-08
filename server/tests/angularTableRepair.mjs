import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairPlainHtmlTablesToMatTable } from '../src/services/angularTableRepair.js';
import {
  angularTableOutputViolatesMandate,
  isAngularTableUnit,
} from '../src/config/angularTableMandate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'table-repair-'));

const componentDir = path.join(tmp, 'src', 'app', 'components', 'task-table');
fs.mkdirSync(componentDir, { recursive: true });

fs.writeFileSync(
  path.join(componentDir, 'task-table.component.html'),
  `<div>
  @if (tasks.length === 0) {
    <p>No tasks yet.</p>
  } @else {
    <table class="task-table">
      <thead><tr><th>Title</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        @for (task of tasks; track task.id) {
          <tr>
            <td>{{ task.title }}</td>
            <td>{{ getStatusLabel(task.status) }}</td>
            <td><button (click)="handleEdit(task)">Edit</button></td>
          </tr>
        }
      </tbody>
    </table>
  }
</div>`,
);

fs.writeFileSync(
  path.join(componentDir, 'task-table.component.ts'),
  `import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-task-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './task-table.component.html',
})
export class TaskTableComponent {
  @Input() tasks: { id: string; title: string; status: string }[] = [];
  @Output() edit = new EventEmitter();
  @Output() remove = new EventEmitter();

  getStatusLabel(status: string): string {
    return status;
  }

  handleEdit(task: unknown): void {
    this.edit.emit(task);
  }
}
`,
);

assert.equal(isAngularTableUnit({ files: [{ newPath: 'src/app/components/task-table/task-table.component.ts' }] }), true);
assert.equal(
  angularTableOutputViolatesMandate([
    { path: 'src/app/components/task-table/task-table.component.html', content: '<table><tr></tr></table>' },
  ]),
  true,
);

const changed = repairPlainHtmlTablesToMatTable(tmp);
assert.equal(changed, 1, 'should repair one component');

const html = fs.readFileSync(path.join(componentDir, 'task-table.component.html'), 'utf-8');
const ts = fs.readFileSync(path.join(componentDir, 'task-table.component.ts'), 'utf-8');

assert.match(html, /mat-table/);
assert.match(html, /custom-datatable-header/);
assert.match(html, /custom-datatable-cont/);
assert.match(html, /MatTableDataSource|dataSource/);
assert.match(ts, /MatTableModule/);
assert.match(ts, /MatTableDataSource/);
assert.match(ts, /displayedColumns/);
assert.doesNotMatch(html, /<table class="task-table"/);

console.log('All angularTableRepair tests passed.');
