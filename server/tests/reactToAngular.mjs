import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  angularDestForReactSource,
  isReactBootstrapPath,
  isMisplacedAngularAppComponentPath,
  reactTsxToAngularTriad,
  synthesizeAngularUnitFromReact
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
assert(!isReactBootstrapPath('src/pages/task-list/TaskList.tsx'), 'TaskList is not bootstrap');
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
  !isMisplacedAngularAppComponentPath('src/app/pages/task-list/task-list.component.ts'),
  'task-list is not a misplaced App'
);

const pageDest = angularDestForReactSource('src/pages/task-list/TaskList.tsx');
assert(pageDest?.kind === 'component', 'TaskList maps to a component');
assert(
  pageDest?.unit === 'src/app/pages/task-list/task-list.component',
  'TaskList stays under pages/'
);

const tableDest = angularDestForReactSource('src/components/task-table/TaskTable.tsx');
assert(
  tableDest?.unit === 'src/app/components/task-table/task-table.component',
  'TaskTable stays under components/'
);

const modelDest = angularDestForReactSource('src/models/task.model.ts');
assert(modelDest?.newPath === 'src/app/models/task.model.ts', 'models stay in src/app/models');

{
  const tsx = fs.readFileSync(path.join(reactRoot, 'src/pages/task-list/TaskList.tsx'), 'utf-8');
  const scss = fs.readFileSync(path.join(reactRoot, 'src/pages/task-list/TaskList.scss'), 'utf-8');
  const files = reactTsxToAngularTriad({
    sourceRel: 'src/pages/task-list/TaskList.tsx',
    tsx,
    scss,
    dest: pageDest
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
  assert(!/<app-text-field/.test(html), 'TextField is not left as a custom component');
  assert(/\(click\)="onEdit\(task\)"/.test(html) || /app-task-table/.test(html), 'table is wired');
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
  assert(!/\[opened\]/.test(html), 'dialog does not use sidenav [opened]');
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

if (process.exitCode) {
  console.error('\nSome reactToAngular tests failed.');
} else {
  console.log('\nAll reactToAngular tests passed.');
}
