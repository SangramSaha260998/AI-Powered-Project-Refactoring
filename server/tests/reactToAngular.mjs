import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  angularDestForReactSource,
  isReactBootstrapPath,
  isMisplacedAngularAppComponentPath,
  reactTsxToAngularTriad,
  synthesizeAngularUnitFromReact,
  restoreAngularBehaviorFromReact,
  collectAngularBehaviorGaps
} from '../src/services/reactToAngular.js';
import { buildMigrationPlan } from '../src/services/analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reactRoot = path.resolve(__dirname, '../../../task-manager-react');

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

assert(isReactBootstrapPath('src/App.tsx'), 'App.tsx is bootstrap');
assert(isReactBootstrapPath('src/app/App.tsx'), 'src/app/App.tsx is bootstrap');
assert(isReactBootstrapPath('src/main.tsx'), 'main.tsx is bootstrap');
assert(!isReactBootstrapPath('src/pages/host-page/HostPage.tsx'), 'feature page is not bootstrap');
assert(
  isMisplacedAngularAppComponentPath('src/app/pages/admin/app/app.component'),
  'pages/admin/app/app.component is a misplaced root App'
);
assert(
  isMisplacedAngularAppComponentPath('src/app/pages/admin/app/app.component.ts'),
  'pages/admin/app/app.component.ts is a misplaced root App'
);
assert(
  !isMisplacedAngularAppComponentPath('src/app/app.component.ts'),
  'src/app/app.component.ts is the real root shell'
);
assert(
  !isMisplacedAngularAppComponentPath('src/app/pages/host-page/host-page.component.ts'),
  'feature page is not a misplaced App'
);

const pageDest = angularDestForReactSource('src/pages/host-page/HostPage.tsx');
assert(pageDest?.kind === 'component', 'page maps to a component');
assert(
  pageDest?.unit === 'src/app/pages/host-page/host-page.component',
  'page stays under pages/'
);

const tableDest = angularDestForReactSource('src/components/item-table/ItemTable.tsx');
assert(
  tableDest?.unit === 'src/app/components/item-table/item-table.component',
  'shared UI stays under components/'
);

const modelDest = angularDestForReactSource('src/models/item.model.ts');
assert(modelDest?.newPath === 'src/app/models/item.model.ts', 'models stay in src/app/models');

{
  const tsx = fs.readFileSync(path.join(reactRoot, 'src/pages/task-list/TaskList.tsx'), 'utf-8');
  const scss = fs.readFileSync(path.join(reactRoot, 'src/pages/task-list/TaskList.scss'), 'utf-8');
  const files = reactTsxToAngularTriad({
    sourceRel: 'src/pages/task-list/TaskList.tsx',
    tsx,
    scss,
    dest: angularDestForReactSource('src/pages/task-list/TaskList.tsx')
  });
  const ts = files.find((f) => f.path.endsWith('.ts')).content;
  const html = files.find((f) => f.path.endsWith('.html')).content;
  assert(/export class TaskListComponent/.test(ts), 'TaskList Angular class name');
  assert(/selector: 'app-task-list'/.test(ts), 'TaskList selector');
  assert(/standalone: true/.test(ts), 'TaskList is standalone');
  assert(/from '@angular\/material\/button'/.test(ts), 'TaskList imports MatButtonModule');
  assert(/from '@angular\/material\/icon'/.test(ts), 'TaskList imports MatIconModule');
  assert(/imports:\s*\[[^\]]*MatButtonModule/.test(ts), 'TaskList lists MatButtonModule in imports');
  assert(/imports:\s*\[[^\]]*MatIconModule/.test(ts), 'TaskList lists MatIconModule in imports');
  assert(/<app-task-table/.test(html), 'TaskList mounts app-task-table');
  assert(/<app-task-form-sidebar/.test(html), 'TaskList mounts form sidebar');
  assert(/<app-task-delete-dialog/.test(html) || /deletingTask/.test(html), 'TaskList keeps delete dialog');
  assert(!/useState/.test(ts), 'TaskList class has no useState');
  assert(!/PaperProps|className=|startIcon=/.test(html), 'TaskList html has no React leftovers');
  assert(/\(click\)="openAdd\(\)"/.test(html), 'Add task click handler');
  assert(/\[opened\]="sidebarOpen"/.test(html), 'sidenav uses [opened]');
  assert(/<mat-sidenav-container[\s\S]*<mat-sidenav\b/.test(html), 'sidenav is inside the container');
  assert(
    !/<\/div>\s*<\/mat-sidenav-content>/s.test(html),
    'TaskList does not close a layout div inside mat-sidenav-content'
  );
  const sidenavContent = html.match(
    /<mat-sidenav-content>([\s\S]*)<\/mat-sidenav-content>/
  )?.[1] || '';
  const contentDivOpens = (sidenavContent.match(/<div\b/g) || []).length;
  const contentDivCloses = (sidenavContent.match(/<\/div>/g) || []).length;
  assert(
    contentDivOpens === contentDivCloses,
    'div tags inside mat-sidenav-content are balanced'
  );
  assert(!/<app-text-field/.test(html), 'TextField is not left as a custom component');
  assert(/\(click\)="onEdit\(task\)"/.test(html) || /app-task-table/.test(html), 'table is wired');
}

{
  const tsx = fs.readFileSync(
    path.join(reactRoot, 'src/components/task-table/TaskTable.tsx'),
    'utf-8'
  );
  const files = reactTsxToAngularTriad({
    sourceRel: 'src/components/task-table/TaskTable.tsx',
    tsx,
    dest: angularDestForReactSource('src/components/task-table/TaskTable.tsx')
  });
  const html = files.find((f) => f.path.endsWith('.html')).content;
  assert(/mat-icon-button/.test(html), 'TaskTable converts IconButton to mat-icon-button');
  assert(
    !/<button\b[^>]*\/>/.test(html),
    'TaskTable does not self-close native button tags'
  );
  const opens = (html.match(/<button\b/g) || []).length;
  const closes = (html.match(/<\/button>/g) || []).length;
  assert(opens === closes, 'TaskTable button open/close tags are balanced');
  assert(!/\)""/.test(html), 'TaskTable click bindings do not double-close quotes');
  assert(/\(click\)="onEdit\(task\)"/.test(html), 'TaskTable wires onEdit(task)');
  assert(/\(click\)="onRemove\(task\)"/.test(html), 'TaskTable wires onRemove(task)');
  assert(!/\)\}\s*$/.test(html.trim()), 'TaskTable has no leftover JSX )} closer');
  assert(/@if\s*\(tasks\.length === 0\)/.test(html), 'TaskTable empty state uses @if');
  assert(/@else\s*\{/.test(html), 'TaskTable non-empty branch uses @else');
  assert(/@for\s*\(task of tasks/.test(html), 'TaskTable rows use @for');
}

{
  const tsx = fs.readFileSync(
    path.join(reactRoot, 'src/components/task-delete-dialog/TaskDeleteDialog.tsx'),
    'utf-8'
  );
  const files = reactTsxToAngularTriad({
    sourceRel: 'src/components/task-delete-dialog/TaskDeleteDialog.tsx',
    tsx,
    dest: angularDestForReactSource('src/components/task-delete-dialog/TaskDeleteDialog.tsx')
  });
  const ts = files.find((f) => f.path.endsWith('.ts')).content;
  const html = files.find((f) => f.path.endsWith('.html')).content;
  assert(/export class TaskDeleteDialogComponent/.test(ts), 'Delete dialog class');
  assert(/Delete task/.test(html), 'Delete dialog title');
  assert(/@Input\(\) open/.test(ts), 'Delete dialog has open input');
  assert(/onClose\(/.test(ts), 'Delete dialog emits via onClose');
  assert(!/@Output\(\)\s+onClose/.test(ts), 'Delete dialog Output is close, not onClose');
  assert(
    !/@Output\(\)\s+onClose[\s\S]*^\s*onClose\s*\(/m.test(ts),
    'Delete dialog does not declare Output and method both named onClose'
  );
  assert(!/\[opened\]/.test(html), 'dialog does not use sidenav [opened]');
}

{
  const tsx = fs.readFileSync(
    path.join(reactRoot, 'src/components/task-form-sidebar/TaskFormSidebar.tsx'),
    'utf-8'
  );
  const files = reactTsxToAngularTriad({
    sourceRel: 'src/components/task-form-sidebar/TaskFormSidebar.tsx',
    tsx,
    dest: angularDestForReactSource('src/components/task-form-sidebar/TaskFormSidebar.tsx')
  });
  const html = files.find((f) => f.path.endsWith('.html')).content;
  assert(/<input\b/.test(html), 'Title field becomes a native input');
  assert(!/<\/input>/.test(html), 'void input has no end tag');
  assert(/<textarea\b/.test(html) && /<\/textarea>/.test(html), 'multiline field stays a textarea');
}

{
  const filesMap = {
    'src/pages/task-list/TaskList.tsx': fs.readFileSync(
      path.join(reactRoot, 'src/pages/task-list/TaskList.tsx'),
      'utf-8'
    ),
    'src/pages/task-list/TaskList.scss': fs.readFileSync(
      path.join(reactRoot, 'src/pages/task-list/TaskList.scss'),
      'utf-8'
    )
  };
  const unit = {
    label: 'src/app/pages/task-list/task-list.component',
    files: [
      { newPath: 'src/app/pages/task-list/task-list.component.ts' },
      { newPath: 'src/app/pages/task-list/task-list.component.html' },
      { newPath: 'src/app/pages/task-list/task-list.component.scss' }
    ]
  };
  const syn = synthesizeAngularUnitFromReact(unit, filesMap);
  assert(syn.length === 3, 'synthesize writes the full triad');
  assert(
    syn.some((f) => f.path.endsWith('.html') && /app-task-table/.test(f.content)),
    'synthesized TaskList html includes the table'
  );
}

{
  const filesMap = {
    'src/models/task.model.ts': 'export interface Task { id: string; }\n'
  };
  const unit = {
    files: [{ newPath: 'src/app/models/task.model.ts' }]
  };
  const syn = synthesizeAngularUnitFromReact(unit, filesMap);
  assert(syn[0]?.content.includes('export interface Task'), 'model file is copied from React source');
}

{
  const preview = buildMigrationPlan(
    {
      components: [
        { name: 'App', file: 'src/App.tsx' },
        { name: 'TaskList', file: 'src/pages/task-list/TaskList.tsx' }
      ],
      hooks: []
    },
    null,
    'react',
    'angular'
  );
  assert(
    !preview.plan.some((p) => /pages\/admin\/app/.test(p.newPath)),
    'analyzer does not dump App.tsx under pages/admin/app'
  );
  assert(
    !preview.mappings.some((m) => m.source === 'src/App.tsx'),
    'analyzer skips bootstrap App.tsx'
  );
  assert(
    preview.plan.some((p) => p.newPath.includes('task-list.component')),
    'analyzer plans TaskList under pages/task-list'
  );
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-restore-'));
  const listDir = path.join(tmp, 'src', 'app', 'pages', 'task-list');
  fs.mkdirSync(listDir, { recursive: true });
  fs.writeFileSync(
    path.join(listDir, 'task-list.component.ts'),
    `import { Component } from '@angular/core';
import { Task, TaskDraft } from '../../models/task.model';
import { TaskFormSidebarComponent } from '../../components/task-form-sidebar/task-form-sidebar.component';
@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [TaskFormSidebarComponent],
  templateUrl: './task-list.component.html',
  styleUrl: './task-list.component.scss'
})
export class TaskListComponent {
  tasks: Task[] = [];
  sidebarOpen = false;
  editingTask: Task | null = null;
  openAdd(): void {
    this.sidebarOpen = true;
  }
  onSave(draft: TaskDraft): void {}
}
`
  );
  fs.writeFileSync(
    path.join(listDir, 'task-list.component.html'),
    `<mat-sidenav-container>
  <mat-sidenav [opened]="sidebarOpen">
    <app-task-form-sidebar [task]="editingTask"></app-task-form-sidebar>
  </mat-sidenav>
  <mat-sidenav-content>
    <button type="button">Add task</button>
  </mat-sidenav-content>
</mat-sidenav-container>
`
  );
  fs.writeFileSync(path.join(listDir, 'task-list.component.scss'), '/* empty */\n');

  const sourceFilesMap = {
    'src/pages/task-list/TaskList.tsx': fs.readFileSync(
      path.join(reactRoot, 'src/pages/task-list/TaskList.tsx'),
      'utf-8'
    ),
    'src/pages/task-list/TaskList.scss': fs.readFileSync(
      path.join(reactRoot, 'src/pages/task-list/TaskList.scss'),
      'utf-8'
    )
  };

  const beforeGaps = collectAngularBehaviorGaps(tmp, sourceFilesMap);
  assert(
    beforeGaps.some((g) => (g.missingHandlers || []).includes('onSave')),
    'stub onSave is detected as a behavior gap'
  );

  const restored = restoreAngularBehaviorFromReact(tmp, sourceFilesMap);
  assert(restored.changed >= 1, 'restore updates the stub TaskList component');
  const ts = fs.readFileSync(path.join(listDir, 'task-list.component.ts'), 'utf-8');
  const html = fs.readFileSync(path.join(listDir, 'task-list.component.html'), 'utf-8');
  assert(/crypto\.randomUUID|this\.tasks = \[/.test(ts), 'empty onSave is filled from React source');
  assert(/\(save\)="onSave\(\$event\)"/.test(html), 'missing (save) binding is added from source');
  assert(/<app-task-table/.test(html), 'missing child table is inserted from source');
  assert(/\(click\)="openAdd\(\)"/.test(html), 'Add task button gets openAdd click from source');
  assert(
    !collectAngularBehaviorGaps(tmp, sourceFilesMap).some((g) =>
      (g.missingHandlers || []).includes('onSave')
    ),
    'onSave gap is gone after restore'
  );

  const customOnSave = `onSave(draft: TaskDraft): void {
    this.tasks = this.tasks.concat([{ ...draft, id: 'kept' }]);
  }`;
  const kept = ts.replace(
    /onSave\(draft: TaskDraft\): void \{[\s\S]*?\n  \}/,
    customOnSave
  );
  fs.writeFileSync(path.join(listDir, 'task-list.component.ts'), kept);
  restoreAngularBehaviorFromReact(tmp, sourceFilesMap);
  const ts2 = fs.readFileSync(path.join(listDir, 'task-list.component.ts'), 'utf-8');
  assert(/id: 'kept'/.test(ts2), 'non-stub onSave body is not overwritten');

  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-onclose-dedupe-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'task-delete-dialog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task-delete-dialog.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Task } from '../../models/task.model';
@Component({
  selector: 'app-task-delete-dialog',
  standalone: true,
  templateUrl: './task-delete-dialog.component.html'
})
export class TaskDeleteDialogComponent {
  @Input() open = false;
  @Input() task: Task | null = null;
  @Output() onClose = new EventEmitter<boolean>();
}
`
  );
  fs.writeFileSync(
    path.join(dir, 'task-delete-dialog.component.html'),
    `<div>Delete?</div>\n`
  );
  fs.writeFileSync(path.join(dir, 'task-delete-dialog.component.scss'), '/* empty */\n');

  restoreAngularBehaviorFromReact(tmp, {
    'src/components/task-delete-dialog/TaskDeleteDialog.tsx': fs.readFileSync(
      path.join(reactRoot, 'src/components/task-delete-dialog/TaskDeleteDialog.tsx'),
      'utf-8'
    )
  });
  const ts = fs.readFileSync(path.join(dir, 'task-delete-dialog.component.ts'), 'utf-8');
  const outputCount = (ts.match(/@Output\(\)\s+onClose\b/g) || []).length;
  const methodCount = (ts.match(/^\s*onClose\s*\(/gm) || []).length;
  assert(outputCount + methodCount === 1, 'restore does not duplicate onClose as Output and method');

  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-form-restore-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'task-form-sidebar');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task-form-sidebar.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Task, TaskDraft, TaskStatus } from '../../models/task.model';
@Component({
  selector: 'app-task-form-sidebar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './task-form-sidebar.component.html'
})
export class TaskFormSidebarComponent {
  handleCancel(..._args: any[]) { return _args[0] ?? null; }
  onTitleInput(..._args: any[]) { return _args[0] ?? null; }
  titleError: any = null;
  @Input() task: Task | null = null;
  @Output() save = new EventEmitter<TaskDraft>();
  @Output() cancel = new EventEmitter<void>();
  title = '';
  description = '';
  status: TaskStatus = 'todo';
  titleTouched = false;
  onSubmit(event: Event): void {
    event.preventDefault();
    this.save.emit({ title: this.title, description: this.description, status: this.status });
  }
  onCancel(): void { this.cancel.emit(); }
}
`
  );
  fs.writeFileSync(
    path.join(dir, 'task-form-sidebar.component.html'),
    `<form (submit)="handleSubmit($event)" (ngSubmit)="onSubmit($event)">
  <button type="button" (click)="handleCancel()">Cancel</button>
  <input [value]="title" (input)="onTitleInput($event)" />
</form>
`
  );
  fs.writeFileSync(path.join(dir, 'task-form-sidebar.component.scss'), '/* empty */\n');

  restoreAngularBehaviorFromReact(tmp, {
    'src/components/task-form-sidebar/TaskFormSidebar.tsx': fs.readFileSync(
      path.join(reactRoot, 'src/components/task-form-sidebar/TaskFormSidebar.tsx'),
      'utf-8'
    )
  });
  const html = fs.readFileSync(path.join(dir, 'task-form-sidebar.component.html'), 'utf-8');
  const ts = fs.readFileSync(path.join(dir, 'task-form-sidebar.component.ts'), 'utf-8');
  assert(/\(click\)="onCancel\(\)"/.test(html), 'restore retargets handleCancel to onCancel');
  assert(
    /formControlName="title"/.test(html) || /\[formGroup\]="form"/.test(html),
    'restore wires title input via reactive form'
  );
  assert(!/\[\(ngModel\)\]/.test(html), 'restore does not use ngModel');
  assert(!/handleCancel\(\.\.\._args/.test(ts), 'restore drops unused handleCancel stub');

  fs.rmSync(tmp, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\nSome reactToAngular tests failed.');
} else {
  console.log('\nAll reactToAngular tests passed.');
}
