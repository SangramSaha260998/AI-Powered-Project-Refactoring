import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  angularStructureOutputViolatesMandate,
  inferAngularFeatureContext,
  normalizeAngularMigrationPlan,
  normalizeAngularPlanPath,
} from '../src/config/angularStructureGuide.js';
import { enforceAngularFolderStructure } from '../src/services/angularStructureEnforce.js';

const ctx = inferAngularFeatureContext([
  'src/app/pages/task-list/task-list.component.ts',
  'src/app/components/task-table/task-table.component.ts',
  'src/app/components/task-form-sidebar/task-form-sidebar.component.ts',
]);
assert.equal(ctx.area, 'app');
assert.equal(ctx.feature, 'tasks');

assert.equal(
  normalizeAngularPlanPath('src/app/pages/task-list/task-list.component.ts', ctx),
  'src/app/pages/app/tasks/pages/task-list/task-list.component.ts',
);
assert.equal(
  normalizeAngularPlanPath('src/app/components/task-form-sidebar/task-form-sidebar.component.ts', ctx),
  'src/app/pages/app/tasks/components/task-form-sidebar/task-form-sidebar.component.ts',
);

const plan = normalizeAngularMigrationPlan([
  {
    newPath: 'src/app/pages/task-list/task-list.component.ts',
    unit: 'src/app/pages/task-list/task-list.component',
  },
  {
    newPath: 'src/app/components/task-table/task-table.component.ts',
    unit: 'src/app/components/task-table/task-table.component',
  },
]);
assert.match(plan[0].newPath, /pages\/app\/tasks\/pages\/task-list\//);
assert.match(plan[1].newPath, /pages\/app\/tasks\/components\/task-table\//);

assert.equal(
  angularStructureOutputViolatesMandate([
    { path: 'src/app/pages/task-list/task-list.component.ts', content: '' },
  ]),
  true,
);
assert.equal(
  angularStructureOutputViolatesMandate([
    {
      path: 'src/app/pages/app/tasks/pages/task-list/task-list.component.ts',
      content: '',
    },
  ]),
  false,
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-enforce-'));
const listDir = path.join(tmp, 'src', 'app', 'pages', 'task-list');
const compDir = path.join(tmp, 'src', 'app', 'components', 'task-table');
fs.mkdirSync(listDir, { recursive: true });
fs.mkdirSync(compDir, { recursive: true });

fs.writeFileSync(
  path.join(listDir, 'task-list.component.ts'),
  `import { TaskTableComponent } from '../../components/task-table/task-table.component';
@Component({ selector: 'app-task-list', imports: [TaskTableComponent] })
export class TaskListComponent {}`,
);
fs.writeFileSync(path.join(compDir, 'task-table.component.ts'), `export class TaskTableComponent {}`);

const moved = enforceAngularFolderStructure(tmp);
assert.ok(moved >= 2);
assert.ok(
  fs.existsSync(
    path.join(tmp, 'src', 'app', 'pages', 'app', 'tasks', 'pages', 'task-list', 'task-list.component.ts'),
  ),
);
assert.ok(
  fs.existsSync(
    path.join(
      tmp,
      'src',
      'app',
      'pages',
      'app',
      'tasks',
      'components',
      'task-table',
      'task-table.component.ts',
    ),
  ),
);

console.log('angularStructureEnforce.mjs: all assertions passed');
