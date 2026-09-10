import fs from 'fs';
import path from 'path';
import os from 'os';
import { fixAngularCompileErrors } from '../src/services/postprocess.js';

function assert(c, m) {
  if (!c) {
    console.error('FAIL', m);
    process.exitCode = 1;
  } else {
    console.log('PASS', m);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-remove-event-assign-'));
const listDir = path.join(tmp, 'src/app/pages/app/tasks/pages/task-list');
const tableDir = path.join(tmp, 'src/app/pages/app/tasks/components/task-table');
const modelsDir = path.join(tmp, 'src/app/models');
fs.mkdirSync(listDir, { recursive: true });
fs.mkdirSync(tableDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
fs.writeFileSync(
  path.join(modelsDir, 'task.model.ts'),
  `export interface Task { id: string; title: string; description: string; status: string; }\n`
);
fs.writeFileSync(
  path.join(tableDir, 'task-table.component.ts'),
  `import { Component, EventEmitter, Output } from '@angular/core';
import { Task } from '../../models/task.model';
@Component({ selector: 'app-task-table', standalone: true, templateUrl: './task-table.component.html' })
export class TaskTableComponent {
  @Output() onRemove = new EventEmitter<Task>();
  @Output() onEdit = new EventEmitter<Task>();
}
`
);
fs.writeFileSync(path.join(tableDir, 'task-table.component.html'), `<p>table</p>\n`);
fs.writeFileSync(
  path.join(listDir, 'task-list.component.ts'),
  `import { Component } from '@angular/core';
import { Task } from '../../../../../models/task.model';
export interface Task { id: string; title: string; description: string; status: string; }
import { TaskTableComponent } from '../../components/task-table/task-table.component';
@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [TaskTableComponent],
  templateUrl: './task-list.component.html'
})
export class TaskListComponent {
  deletingTask: Task | null = null;
  openEdit(_task: Task): void {}
}
`
);
fs.writeFileSync(
  path.join(listDir, 'task-list.component.html'),
  `<app-task-table (edit)="openEdit($event)" (remove)="deletingTask = $event"></app-task-table>\n`
);

const n = fixAngularCompileErrors(
  tmp,
  `TS2739: Type 'Event' is missing the following properties from type 'Task': id, title, description, status
src/app/pages/app/tasks/pages/task-list/task-list.component.html:61:74:
  61 │ (edit)="openEdit($event)" (remove)="deletingTask = $event"
src/app/pages/app/tasks/pages/task-list/task-list.component.ts:33:15: templateUrl
TS2440: Import declaration conflicts with local declaration of 'Task'.
src/app/pages/app/tasks/pages/task-list/task-list.component.ts:1:9:
`
);
const listHtml = fs.readFileSync(path.join(listDir, 'task-list.component.html'), 'utf-8');
const listTs = fs.readFileSync(path.join(listDir, 'task-list.component.ts'), 'utf-8');
console.log('---html---\n' + listHtml);
console.log('---ts---\n' + listTs);
assert(n >= 1, 'changed');
assert(/deletingTask = \$any\(\$event\)/.test(listHtml), 'assignment wraps any');
assert(/from ['"].*task\.model['"]/.test(listTs), 'keeps import');
assert(!/(?:export\s+)?interface\s+Task\b/.test(listTs), 'local interface gone');
fs.rmSync(tmp, { recursive: true, force: true });
