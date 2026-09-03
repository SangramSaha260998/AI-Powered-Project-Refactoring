import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  repairAngularWorkspace,
  repairReactWorkspace,
  repairAngularComponentFile,
  stripCssLeakedIntoTs,
  componentClassNameFromFile,
  isPlaceholderTemplate,
  collectConversionDefects,
  collectMissingSourcePages,
  rewriteReactAngularLeftovers,
  rewriteNgxsStateToZustand,
  detectSourceStack,
  isTruncatedSource,
  addPackagesFromBuildErrors,
  fixReactModuleImports,
  dedupeStoreModelTypes,
  removeUnusedStoreShards,
  fixReactTypeErrors,
  consolidateDuplicateZustandStores,
  fixZustandSelectorFields,
  fixZustandHookUsage,
  injectMissingComponentProps,
  syncComponentCallSiteProps,
  fixTaskModelFieldMismatches,
  alignTaskStatusLiterals,
  ensureZustandStoreScaffold,
  pinSourceDomainArtifacts,
  ensureReactAppShell,
  fixAngularCompileErrors,
  ensureAngularMaterialPackages,
  inferDeclarablePackage,
  declarablesNeededByHtml
} from '../src/services/postprocess.js';
import { rewriteHtmlLucideToInlineSvg } from '../src/services/lucideInlineSvg.js';
import {
  sanitizeAngularComponentTs,
  sanitizeCssContent,
  matchUnitBundleFile,
  normalizeReactPlanPath,
  groupPlanIntoMigrationUnits,
  coerceReactMigrationUnit,
  synthesizeReactUnitFromAngular
} from '../src/services/migration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('PASS:', message);
  }
}

// --- Unit: class naming ---
assert(
  componentClassNameFromFile('/x/avatar.component.ts') === 'AvatarComponent',
  'avatar.component.ts → AvatarComponent'
);
assert(
  componentClassNameFromFile('/x/app.component.ts') === 'AppComponent',
  'app.component.ts → AppComponent'
);
assert(
  componentClassNameFromFile('/x/admin-shell.component.ts') === 'AdminShellComponent',
  'admin-shell.component.ts → AdminShellComponent'
);

// --- Unit: sanitize forces class name ---
{
  const broken = `import { Component } from '@angular/core';
@Component({
  selector: 'app-avatar',
  templateUrl: './avatar.component.html',
  styleUrl: './avatar.component.css'
})
export class AppComponent {
  src = '';
}
`;
  const fixed = sanitizeAngularComponentTs(broken, 'avatar.component');
  assert(fixed.includes('export class AvatarComponent'), 'sanitize renames AppComponent → AvatarComponent');
  assert(fixed.includes('standalone: true'), 'sanitize adds standalone: true');
}

// --- Unit: CSS leak stripping ---
{
  const leaked = `import { Component } from '@angular/core';
@Component({
  selector: 'app-switch',
  standalone: true,
  templateUrl: './switch.component.html',
  styleUrl: './switch.component.css',
  styles: [\`
    .switch-root {
      background-color: hsl(var(--primary));
    }
  \`]
})
export class SwitchComponent {
  checked = false;
}
.switch-thumb {
  pointer-events: none;
  height: 1rem;
}
`;
  const stripped = stripCssLeakedIntoTs(leaked);
  assert(!/pointer-events/.test(stripped), 'stripCssLeakedIntoTs removes leaked CSS after class');
  assert(/export class SwitchComponent/.test(stripped), 'stripCssLeakedIntoTs keeps class');
}

// --- Unit: multi-component files must NOT be truncated ---
{
  const multi = `import { Component } from '@angular/core';

@Component({
  selector: 'app-carousel',
  standalone: true,
  templateUrl: './carousel.component.html',
  styleUrl: './carousel.component.css',
  imports: [CarouselContentComponent]
})
export class CarouselComponent {}

@Component({
  selector: 'app-carousel-content',
  standalone: true,
  template: '<ng-content />'
})
export class CarouselContentComponent {}
`;
  const fixed = sanitizeAngularComponentTs(multi, 'carousel.component');
  assert(fixed.includes('export class CarouselComponent'), 'keeps primary carousel class');
  assert(fixed.includes('export class CarouselContentComponent'), 'does NOT truncate sibling component class');
}

// --- Unit: preserve alternate templateUrl targets ---
{
  const withTrigger = `import { Component } from '@angular/core';
@Component({
  selector: 'app-accordion-trigger',
  standalone: true,
  templateUrl: './accordion-trigger.component.html',
  styleUrl: './accordion-trigger.component.css'
})
export class AccordionTriggerComponent {}
`;
  // Simulate repair via temp file
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-tmpl-'));
  const ts = path.join(tmp, 'accordion.component.ts');
  fs.writeFileSync(ts, withTrigger);
  repairAngularComponentFile(ts);
  const after = fs.readFileSync(ts, 'utf-8');
  assert(
    after.includes("templateUrl: './accordion-trigger.component.html'"),
    'does not force-rewrite templateUrl to filename match'
  );
  assert(
    !fs.existsSync(path.join(tmp, 'accordion-trigger.component.html')),
    'does not stub a missing referenced template with placeholder HTML'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Integration: repair Angular workspace fixture ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-angular-'));
  const srcApp = path.join(tmp, 'src', 'app', 'components', 'ui', 'avatar');
  fs.mkdirSync(srcApp, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'app'), { recursive: true });

  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({
      name: 'migrated-angular-project',
      dependencies: {
        '@angular/core': '^20.3.0',
        '@angular/common': '^20.3.0',
        '@angular/platform-browser': '^20.3.0',
        '@angular/router': '^20.3.0',
        '@angular/animations': '^20.3.0'
      }
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(tmp, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
  );

  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'app.component.ts'),
    `import { ErrorHandler } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { reportLovableError } from '../lib/lovable-error-reporting';

export class LovableErrorHandler implements ErrorHandler {
  handleError(error: unknown) {
    reportLovableError(error);
    super.handleError(error);
  }
}

import { Component } from '@angular/core';
@Component({
  selector: 'app-root',
  providers: [provideHttpClient()],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {}
`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'app.component.html'),
    `<router-outlet></router-outlet>\n`
  );
  fs.writeFileSync(path.join(tmp, 'src', 'app', 'app.component.css'), `/* app */\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'app.routes.ts'),
    `import { Routes } from '@angular/router';\nexport const routes: Routes = [];\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'main.ts'),
    `import { bootstrapApplication } from '@angular/platform-browser';\n`
  );

  fs.writeFileSync(
    path.join(srcApp, 'avatar.component.ts'),
    `import { Component } from '@angular/core';

@Component({
  selector: 'app-avatar',
  templateUrl: './avatar.component.html',
  styleUrl: './avatar.component.css'
})
export class AppComponent {
  src = '';
  failed = false;
}
`
  );
  fs.writeFileSync(
    path.join(srcApp, 'avatar.component.html'),
    `<img *ngIf="!failed && src" [src]="src" />
<div *ngIf="failed || !src"></div>
`
  );
  fs.writeFileSync(path.join(srcApp, 'avatar.component.css'), `\n`);

  fs.mkdirSync(path.join(tmp, 'src', 'app', 'components', 'admin'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'components', 'admin', 'admin-avatar.component.ts'),
    `import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/core';
import { cn } from '@/lib/utils';

@Component({
  selector: 'app-admin-avatar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './admin-avatar.component.html',
  styleUrl: './admin-avatar.component.css'
})
export class AdminAvatarComponent {
  @Input() name = '';
  get avatarClasses() { return cn('avatar'); }
  get avatarStyle() { return {}; }
}
`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'components', 'admin', 'admin-avatar.component.html'),
    `<div [ngClass]="avatarClasses()" [ngStyle]="avatarStyle()"></div>\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'components', 'admin', 'admin-avatar.component.css'),
    `/* admin-avatar */\n`
  );

  repairAngularWorkspace(tmp, {
    sourcePackageJson: {
      dependencies: {
        clsx: '^2.1.1',
        'tailwind-merge': '^2.5.0',
        'lucide-react': '^0.468.0',
        '@tanstack/react-start': '^1.167.50',
        '@lovable.dev/vite-tanstack-config': '^2.3.2',
        nitro: '3.0.260603-beta'
      }
    },
    sourceFilesMap: {
      'src/lib/utils.ts': `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`
    }
  });

  const avatarTs = fs.readFileSync(path.join(srcApp, 'avatar.component.ts'), 'utf-8');
  assert(avatarTs.includes('export class AvatarComponent'), 'repair renames avatar class');
  assert(avatarTs.includes("from '@angular/common'"), 'repair imports CommonModule from @angular/common');
  assert(avatarTs.includes('CommonModule'), 'repair adds CommonModule for *ngIf');

  const adminHtml = fs.readFileSync(
    path.join(tmp, 'src', 'app', 'components', 'admin', 'admin-avatar.component.html'),
    'utf-8'
  );
  assert(!/avatarClasses\(\)/.test(adminHtml), 'repair removes () from getters in template');
  assert(/avatarClasses/.test(adminHtml), 'getter name preserved without call');

  const adminTs = fs.readFileSync(
    path.join(tmp, 'src', 'app', 'components', 'admin', 'admin-avatar.component.ts'),
    'utf-8'
  );
  assert(!/CommonModule \} from '@angular\/core'/.test(adminTs), 'CommonModule not imported from @angular/core');

  const appTs = fs.readFileSync(path.join(tmp, 'src', 'app', 'app.component.ts'), 'utf-8');
  assert(!/reportLovableError/.test(appTs), 'broken ErrorHandler shell removed from app.component');
  assert(/RouterOutlet/.test(appTs), 'app.component imports RouterOutlet when template has router-outlet');

  const tsconfig = JSON.parse(fs.readFileSync(path.join(tmp, 'tsconfig.json'), 'utf-8'));
  assert(tsconfig.compilerOptions.paths?.['@/*'], '@/* path alias added');

  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies.clsx, 'clsx merged into package.json');
  assert(!pkg.dependencies['@lucide/angular'], 'lucide-react is not mapped to @lucide/angular');
  assert(!pkg.dependencies['lucide-react'], 'lucide-react stripped from Angular output (inline SVG)');
  assert(!pkg.dependencies['lucide-angular'], 'legacy lucide-angular must not be added');
  assert(pkg.dependencies['tailwind-merge'], 'tailwind-merge merged');
  assert(!pkg.dependencies['@tanstack/react-start'], 'TanStack React packages not copied into Angular');
  assert(!pkg.dependencies['@lovable.dev/vite-tanstack-config'], 'Lovable Vite config not copied into Angular');
  assert(!pkg.dependencies.nitro, 'nitro not copied into Angular');

  assert(fs.existsSync(path.join(tmp, 'src', 'lib', 'utils.ts')), 'source lib/utils.ts copied');

  const avatarScssPath = path.join(srcApp, 'avatar.component.scss');
  const avatarCssPath = path.join(srcApp, 'avatar.component.css');
  assert(fs.existsSync(avatarScssPath), 'empty CSS repaired and renamed to .scss');
  assert(!fs.existsSync(avatarCssPath), 'legacy .css removed after scss rename');
  assert(fs.readFileSync(avatarScssPath, 'utf-8').trim().length > 0, 'scss is non-empty');

  // cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Integration: React path aliases ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-react-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }, null, 2)
  );
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2));
  fs.writeFileSync(path.join(tmp, 'vite.config.ts'), `import { defineConfig } from 'vite';\nexport default defineConfig({});\n`);
  fs.writeFileSync(path.join(tmp, 'src', 'App.tsx'), `export default function App() { return <div />; }\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'Icon.tsx'),
    `import { Search } from '@lucide/angular';\nexport function Icon() { return <Search />; }\n`
  );

  repairReactWorkspace(tmp, {
    sourcePackageJson: { dependencies: { '@lucide/angular': '^1.23.0', clsx: '^2.1.1' } }
  });

  const vite = fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf-8');
  assert(/alias/.test(vite) && /@/.test(vite), 'React vite alias @ configured');

  const icon = fs.readFileSync(path.join(tmp, 'src', 'Icon.tsx'), 'utf-8');
  assert(/lucide-react/.test(icon), '@lucide/angular rewritten to lucide-react');

  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies.clsx, 'React merge includes clsx');
  assert(pkg.dependencies['lucide-react'], '@lucide/angular mapped to lucide-react for React');
  assert(!pkg.dependencies['lucide-angular'], 'React project must not keep lucide-angular');
  assert(!pkg.dependencies['@lucide/angular'], 'React project must not keep @lucide/angular');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Quality: no placeholder route stubs; lucide from React source; defect scan ---
{
  assert(isPlaceholderTemplate('home.component.html', '<p>HomeComponent placeholder</p>'), 'detects placeholder HTML');
  assert(!isPlaceholderTemplate('home.component.html', '<div class="flex gap-2"><h1>Admin Users</h1></div>'), 'real HTML is not a placeholder');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-quality-'));
  const srcApp = path.join(tmp, 'src', 'app');
  fs.mkdirSync(path.join(srcApp, 'pages', 'admin-users'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-angular-project', dependencies: { '@angular/core': '^20.0.0' } }, null, 2)
  );
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  fs.writeFileSync(
    path.join(srcApp, 'app.component.ts'),
    `import { Component } from '@angular/core';\n@Component({ selector: 'app-root', standalone: true, templateUrl: './app.component.html', styleUrl: './app.component.scss' })\nexport class AppComponent {}\n`
  );
  fs.writeFileSync(path.join(srcApp, 'app.component.html'), `<router-outlet></router-outlet>\n`);
  fs.writeFileSync(path.join(srcApp, 'app.component.scss'), `/* app */\n`);
  fs.writeFileSync(
    path.join(srcApp, 'app.routes.ts'),
    `import { Routes } from '@angular/router';\nimport { HomeComponent } from './pages/home/home.component';\nexport const routes: Routes = [{ path: '', component: HomeComponent }];\n`
  );
  fs.writeFileSync(
    path.join(srcApp, 'pages', 'admin-users', 'admin-users.component.ts'),
    `import { Component } from '@angular/core';\n@Component({\n  selector: 'app-admin-users',\n  standalone: true,\n  templateUrl: './admin-users.component.html',\n  styleUrl: './admin-users.component.scss'\n})\nexport class AdminUsersComponent {}\n`
  );
  fs.writeFileSync(
    path.join(srcApp, 'pages', 'admin-users', 'admin-users.component.html'),
    `<button type="button"><Plus className="w-4 h-4" /></button>\n`
  );
  fs.writeFileSync(path.join(srcApp, 'pages', 'admin-users', 'admin-users.component.scss'), `/* admin-users */\n`);
  fs.writeFileSync(path.join(tmp, 'src', 'main.ts'), `import { bootstrapApplication } from '@angular/platform-browser';\n`);

  const reactUsers = `import { Plus, Pencil } from 'lucide-react';
export function AdminUsers() {
  return (
    <div>
      <button><Plus className="w-4 h-4" /></button>
      <button><Pencil className="w-4 h-4" /></button>
    </div>
  );
}
`;

  repairAngularWorkspace(tmp, {
    sourceFilesMap: {
      'src/pages/admin-users.tsx': reactUsers,
      'src/components/AdminShell.tsx': `import { Bell } from 'lucide-react';
export function AdminShell({ children }) { return <div><Bell className="w-5 h-5" />{children}</div>; }
`
    }
  });

  const homeHtml = path.join(srcApp, 'pages', 'home', 'home.component.html');
  assert(!fs.existsSync(homeHtml), 'missing route module is not stubbed with placeholder HTML');
  const routes = fs.readFileSync(path.join(srcApp, 'app.routes.ts'), 'utf-8');
  assert(!/HomeComponent/.test(routes), 'unresolved HomeComponent import is dropped from routes');

  const usersHtml = fs.readFileSync(
    path.join(srcApp, 'pages', 'admin-users', 'admin-users.component.html'),
    'utf-8'
  );
  assert(/<svg[\s\S]*viewBox="0 0 24 24"/i.test(usersHtml), 'React <Plus /> rewritten to inline Lucide SVG from source');
  assert(!/<Plus\b/.test(usersHtml), 'React Plus tag is gone after lucide rewrite');

  const rewritten = rewriteHtmlLucideToInlineSvg('<Search className="w-4" />', `import { Search } from 'lucide-react';`);
  assert(/<svg[\s\S]*viewBox/i.test(rewritten), 'lucide rewrite helper inlines Search from React import');

  const defects = collectConversionDefects(tmp);
  assert(defects.placeholders.length === 0, 'converted admin-users template is not flagged as placeholder');

  const missing = collectMissingSourcePages(tmp, {
    'src/pages/admin-users.tsx': reactUsers,
    'src/components/AdminShell.tsx': `export function AdminShell() { return <div className="shell" />; }`
  });
  assert(missing.includes('src/components/AdminShell.tsx'), 'flags AdminShell when no matching Angular component exists');
  assert(!missing.includes('src/pages/admin-users.tsx'), 'admin-users is covered by admin-users.component.ts');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- React: JSX written to .ts must be renamed to .tsx ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-jsx-ts-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }, null, 2));
  fs.writeFileSync(path.join(tmp, 'vite.config.ts'), `import { defineConfig } from 'vite';\nexport default defineConfig({});\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.ts'),
    `export default function TaskList() {\n  return (\n    <div className="layout">\n      <h1>Task Manager</h1>\n    </div>\n  );\n}\n`
  );
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'task.state.ts'), `export const tasks = [];\n`);

  repairReactWorkspace(tmp, {});

  assert(!fs.existsSync(path.join(tmp, 'src', 'pages', 'TaskList.ts')), 'JSX TaskList.ts is removed');
  assert(fs.existsSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx')), 'JSX TaskList.ts renamed to .tsx');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'task.state.ts')), 'plain .ts store file is not renamed');

  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'task.types.ts'),
    `export type Result = Promise<User>;\nexport function wrap<T>(x: T): T { return x; }\n`
  );
  repairReactWorkspace(tmp, {});
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'task.types.ts')), 'generic Promise<User> .ts is not renamed to .tsx');
  assert(!fs.existsSync(path.join(tmp, 'src', 'store', 'task.types.tsx')), 'generic types file has no .tsx twin');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- React leftovers: NGXS → zustand, Material → MUI, packages, truncation ---
{
  const ngxs = `import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { Task } from '../../models/task.model';
import { AddTask, DeleteTask, UpdateTask } from './task.actions';

export interface TaskStateModel {
  items: Task[];
}

const INITIAL_TASKS: Task[] = [{ id: '1', title: 'A', description: '', status: 'todo' }];

@State<TaskStateModel>({
  name: 'tasks',
  defaults: {
    items: INITIAL_TASKS
  }
})
@Injectable()
export class TaskState {
  @Selector()
  static items(state: TaskStateModel): Task[] {
    return state.items;
  }

  @Action(AddTask)
  addTask(ctx: StateContext<TaskStateModel>, action: AddTask): void {
    const task: Task = {
      ...action.payload,
      id: crypto.randomUUID()
    };
    ctx.patchState({
      items: [...ctx.getState().items, task]
    });
  }

  @Action(DeleteTask)
  deleteTask(ctx: StateContext<TaskStateModel>, action: DeleteTask): void {
    ctx.patchState({
      items: ctx.getState().items.filter((task) => task.id !== action.id)
    });
  }
}
`;
  const zustand = rewriteNgxsStateToZustand(ngxs);
  assert(/from 'zustand'/.test(zustand), 'NGXS state file imports zustand');
  assert(/export const useTaskStore = create/.test(zustand), 'NGXS TaskState becomes useTaskStore');
  assert(/addTask: \(payload\)/.test(zustand), 'AddTask action becomes addTask(payload)');
  assert(/deleteTask: \(id\)/.test(zustand), 'DeleteTask action becomes deleteTask(id)');
  assert(!/@State/.test(zustand), 'NGXS @State decorator is gone');
  assert(!/@angular\//.test(zustand), 'Angular imports stripped from converted store');

  const leftoverUi = `import { Store } from '@ngxs/store';
import { MatButtonModule } from '@angular/material/button';
import { TaskTableComponent } from '../../components/task-table/task-table.component';

export function TaskList() {
  private readonly store = inject(Store);
  readonly tasks$ = this.store.select(TaskState.items);

  onSave(draft) {
    this.store.dispatch(new AddTask(draft));
  }

  return (
    <mat-sidenav-container>
      <mat-toolbar color="primary">
        <mat-icon>checklist</mat-icon>
        <button mat-flat-button type="button" (click)="openAdd()">
          Add task
        </button>
      </mat-toolbar>
      @if (tasks.length === 0) {
        <p>{{ emptyLabel }}</p>
      } @else {
        <app-task-table [tasks]="tasks" (edit)="openEdit($event)" />
      }
    </mat-sidenav-container>
  );
}
`;
  const rewritten = rewriteReactAngularLeftovers(leftoverUi);
  assert(!/@angular\//.test(rewritten), 'leftover @angular imports stripped');
  assert(!/@ngxs\//.test(rewritten), 'leftover @ngxs imports stripped');
  assert(/useTaskStore\(\(s\) => s\.items\)/.test(rewritten), 'NGXS select → zustand hook');
  assert(/useTaskStore\.getState\(\)\.addTask\(draft\)/.test(rewritten), 'dispatch(new AddTask) → zustand method');
  assert(/<AppBar/.test(rewritten) && /<Toolbar>/.test(rewritten), 'mat-toolbar → AppBar+Toolbar');
  assert(/<Icon>checklist<\/Icon>/.test(rewritten), 'mat-icon → Icon');
  assert(/<Button variant="contained"/.test(rewritten), 'mat-flat-button → MUI Button');
  assert(/onClick=\{openAdd\}/.test(rewritten), '(click)="openAdd()" → onClick={openAdd}');
  assert(/<TaskTableComponent/.test(rewritten) || /<TaskTable/.test(rewritten), 'app-task-table → PascalCase component');
  assert(/tasks=\{tasks\}/.test(rewritten), '[tasks] → tasks={tasks}');
  assert(/from '@mui\/material'/.test(rewritten), 'MUI named imports injected');
  assert(!/<mat-/.test(rewritten), 'no leftover mat-* tags');
  assert(rewritten.includes('{emptyLabel}'), '{{ interpolation }} rewritten');
  assert(!/{{\s*emptyLabel\s*}}/.test(rewritten), 'Angular emptyLabel {{ }} is gone');

  assert(isTruncatedSource('export function Foo() {\n  return (\n'), 'unbalanced braces count as truncated');
  assert(!isTruncatedSource('export function Foo() { return 1; }\n'), 'balanced file is not truncated');
  assert(detectSourceStack({}, { dependencies: { '@ngxs/store': '20', '@angular/material': '20' } }).ngxs, 'detects NGXS from package.json');
  assert(detectSourceStack({}, { dependencies: { '@angular/material': '20' } }).material, 'detects Material from package.json');
  assert(detectSourceStack({}, { dependencies: { '@mui/material': '6' } }).material, 'detects Material from MUI package.json');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-stack-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }, null, 2));
  fs.writeFileSync(path.join(tmp, 'vite.config.ts'), `import { defineConfig } from 'vite';\nexport default defineConfig({});\n`);
  fs.writeFileSync(path.join(tmp, 'index.html'), `<html><head></head><body></body></html>\n`);
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'task.state.ts'), ngxs);
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.ts'),
    leftoverUi
  );

  repairReactWorkspace(tmp, {
    sourcePackageJson: {
      dependencies: { '@ngxs/store': '^20.0.0', '@angular/material': '^20.0.0' }
    },
    sourceFilesMap: {
      'src/app/store/task/task.state.ts': ngxs,
      'src/app/pages/task-list/task-list.component.html': '<mat-toolbar></mat-toolbar>'
    }
  });

  const storeOut = fs.readFileSync(path.join(tmp, 'src', 'store', 'task.state.ts'), 'utf-8');
  assert(/useTaskStore/.test(storeOut), 'workspace repair converts NGXS store file');
  assert(fs.existsSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx')), 'JSX leftovers renamed to .tsx');
  const pageOut = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(/import \{ useTaskStore \} from/.test(pageOut), 'useTaskStore import injected into page');
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies.zustand, 'zustand added from NGXS source stack');
  assert(pkg.dependencies['@mui/material'], 'MUI added from Material source stack');
  assert(pkg.dependencies['@emotion/react'], 'emotion peer added with MUI');
  assert(!pkg.dependencies['@ngxs/store'], 'NGXS package not copied into React app');
  assert(!pkg.dependencies['@angular/material'], 'Angular Material not copied into React app');
  const html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf-8');
  assert(/Material\+Icons/.test(html), 'Material Icons font linked when source used Material');

  const added = addPackagesFromBuildErrors(tmp, `Cannot find module 'react-router-dom'`);
  const pkg2 = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(added >= 1 && pkg2.dependencies['react-router-dom'], 'Cannot find module adds known package');
  const skippedUnknown = addPackagesFromBuildErrors(tmp, `Cannot find module 'totally-fake-lib-xyz'`);
  assert(skippedUnknown === 0, 'unknown packages are not invented');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- MatDialog.open → React dialog state; mechanical type-error imports ---
{
  const caller = `import { TaskDeleteDialogComponent } from '../../components/task-delete-dialog/task-delete-dialog';
import { Task } from '../../models/task.model';

export function TaskList() {
  const openDelete = (task: Task) => {
    const dialogRef = this.dialog.open(TaskDeleteDialogComponent, {
      width: '400px',
      data: { task }
    });
    dialogRef.afterClosed().subscribe((confirmed) => {
      if (confirmed) {
        useTaskStore.getState().deleteTask(task.id);
      }
    });
  };

  return (
    <div>
      <button type="button" onClick={() => openDelete(items[0])}>Delete</button>
    </div>
  );
}
`;
  const convertedCaller = rewriteReactAngularLeftovers(caller);
  assert(/useState\(/.test(convertedCaller), 'MatDialog.open adds useState');
  assert(/from 'react'/.test(convertedCaller) && /useState/.test(convertedCaller), 'useState imported from react');
  assert(!/\.dialog\.open\(/.test(convertedCaller), 'dialog.open is gone');
  assert(!/afterClosed/.test(convertedCaller), 'afterClosed is gone');
  assert(/<TaskDeleteDialogComponent/.test(convertedCaller), 'dialog component is rendered');
  assert(/open=\{Boolean\(/.test(convertedCaller), 'rendered dialog gets open prop');
  assert(/onClose=\{/.test(convertedCaller), 'rendered dialog gets onClose prop');
  assert(/deleteTask\(task\.id\)/.test(convertedCaller), 'afterClosed body is kept in onClose');
  assert(!/\bthis\./.test(convertedCaller), 'this. stripped in function component');

  const dialogComp = `import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

export class TaskDeleteDialogComponent {
  constructor(
    private readonly dialogRef: MatDialogRef<TaskDeleteDialogComponent, boolean>,
    @Inject(MAT_DIALOG_DATA) public data: { task: { title: string } }
  ) {}

  onCancel(): void {
    this.dialogRef.close(false);
  }

  onConfirm(): void {
    this.dialogRef.close(true);
  }
}

export function Template() {
  return (
    <h2 mat-dialog-title>Delete task</h2>
    <mat-dialog-content>
      Delete "{{ data.task.title }}"?
    </mat-dialog-content>
    <mat-dialog-actions>
      <button mat-button type="button" (click)="onCancel()">Cancel</button>
    </mat-dialog-actions>
  );
}
`;
  const convertedDialog = rewriteReactAngularLeftovers(dialogComp);
  assert(/export function TaskDeleteDialogComponent\(\{ open/.test(convertedDialog), 'dialog class becomes function with open prop');
  assert(/onClose\(false\)/.test(convertedDialog), 'dialogRef.close(false) → onClose(false)');
  assert(/onClose\(true\)/.test(convertedDialog), 'dialogRef.close(true) → onClose(true)');
  assert(/<Dialog\b/.test(convertedDialog), 'dialog template wrapped in MUI Dialog');
  assert(/<DialogTitle>/.test(convertedDialog), 'mat-dialog-title → DialogTitle');
  assert(/<DialogContent>/.test(convertedDialog), 'mat-dialog-content → DialogContent');
  assert(!/dialogRef/.test(convertedDialog), 'MatDialogRef leftover is gone');
  assert(!/MAT_DIALOG/.test(convertedDialog), 'MAT_DIALOG_DATA leftover is gone');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-types-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'TaskDeleteDialog.tsx'),
    `export function TaskDeleteDialog({ open, onClose, data }) {\n  return <div>{data?.task?.title}</div>;\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `export function TaskList() {\n  const [open, setOpen] = useState(false);\n  return <TaskDeleteDialog open={open} onClose={() => setOpen(false)} />;\n}\n`
  );
  const n = fixReactTypeErrors(
    tmp,
    [
      `src/pages/TaskList.tsx(2,26): error TS2304: Cannot find name 'useState'.`,
      `src/pages/TaskList.tsx(3,11): error TS2304: Cannot find name 'TaskDeleteDialog'.`
    ].join('\n')
  );
  assert(n >= 1, 'mechanical type-error fixer updates the file');
  const fixed = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(/import \{ useState \} from 'react'/.test(fixed), 'adds missing useState import');
  assert(/import \{ TaskDeleteDialog \} from/.test(fixed), 'adds missing local component import');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- JSX object literals: do not treat prop={{ key: val }} as Angular {{ }} ---
{
  const broken = `<Drawer PaperProps={{ className: 'sidebar-panel' }} classes={{ paper: 'x' }} />`;
  const fixed = rewriteReactAngularLeftovers(broken);
  assert(/PaperProps=\{\{\s*className:/.test(fixed), 'PaperProps={{ }} stays double-braced');
  assert(/classes=\{\{\s*paper:/.test(fixed), 'classes={{ }} stays double-braced');
  assert(!/PaperProps=\{className:/.test(fixed), 'PaperProps outer braces not stripped');
  assert(!/classes=\{paper:/.test(fixed), 'classes outer braces not stripped');

  const repaired = rewriteReactAngularLeftovers(
    `<Drawer PaperProps={className: 'sidebar-panel'} classes={paper: 'sidebar-panel'} />`
  );
  assert(/PaperProps=\{\{\s*className:/.test(repaired), 'repairs broken PaperProps object literal');
  assert(/classes=\{\{\s*paper:/.test(repaired), 'repairs broken classes object literal');

  const text = rewriteReactAngularLeftovers(`<p>Delete "{{ data.task.title }}"?</p>`);
  assert(text.includes('{data.task.title}'), 'template {{ }} still becomes JSX expression');
}

// --- Module imports, store/model dedupe, react-hook-form ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-imports-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store', 'task'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `export default function TaskList() { return <div />; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'App.tsx'),
    `import { TaskList } from './pages/task-list';\nexport default function App() { return <TaskList />; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export interface Task { id: string; title: string; description: string; status: 'todo' | 'in-progress' | 'done'; }\nexport type TaskDraft = Omit<Task, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'taskStore.ts'),
    `import { create } from 'zustand';\nexport interface Task { id: string; title: string; description?: string; status: 'todo' | 'in-progress' | 'done'; }\nexport type TaskDraft = Omit<Task, 'id'>;\nexport const useTaskStore = create(() => ({ items: [] as Task[] }));\n`
  );
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'task', 'task.state.ts'), `export const useTaskStateStore = () => ({});\n`);
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'task', 'task.actions.ts'), `export type AddTask = unknown;\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'Form.tsx'),
    `import { useForm } from 'react-hook-form';\nexport function Form() { useForm(); return null; }\n`
  );

  fixReactModuleImports(tmp);
  const app = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(/import TaskList from '\.\/pages\/TaskList'/.test(app), 'wrong path + named import fixed to default import');
  assert(!/task-list/.test(app), 'kebab import path is corrected');

  dedupeStoreModelTypes(tmp);
  const store = fs.readFileSync(path.join(tmp, 'src', 'store', 'taskStore.ts'), 'utf-8');
  assert(/from ['"].*models\/task\.model['"]/.test(store), 'store imports Task from models');
  assert(!/export interface Task/.test(store), 'duplicate Task interface removed from store');

  assert(removeUnusedStoreShards(tmp) >= 2, 'unused NGXS shard files removed');

  repairReactWorkspace(tmp, {});
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies['react-hook-form'], 'react-hook-form added from imports');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Duplicate zustand stores, selector fields, missing open prop ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-zustand-'));
  fs.mkdirSync(path.join(tmp, 'src', 'store', 'task'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'pages', 'task-list'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'components', 'task-form-sidebar'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { zustand: '^5.0.3', react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export interface Task { id: string; title: string; description: string; status: 'todo' | 'in-progress' | 'done'; }\nexport type TaskDraft = Omit<Task, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'task', 'task.state.ts'),
    `import { useTaskStore } from './task.store';\nimport { create } from 'zustand';\nimport { Task } from '../../models/task.model';\nexport interface TaskStateModel { items: Task[]; addTask: (t: Omit<Task, 'id'>) => void; updateTask: (t: Task) => void; deleteTask: (id: string) => void; }\nexport const useTaskStore = create<TaskStateModel>(() => ({ items: [], addTask: () => {}, updateTask: () => {}, deleteTask: () => {} }));\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'task', 'task.store.ts'),
    `import { useTaskStore } from './task.state';\nimport { create } from 'zustand';\nimport { Task, TaskDraft } from '../../models/task.model';\nexport interface TaskStateModel { items: Task[]; addTask: (p: TaskDraft) => void; updateTask: (p: Task) => void; deleteTask: (id: string) => void; }\nexport const useTaskStore = create<TaskStateModel>(() => ({ items: [], addTask: () => {}, updateTask: () => {}, deleteTask: () => {} }));\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'task-list', 'TaskList.tsx'),
    `import { useState } from 'react';\nimport { useTaskStore } from '../../store/useTaskStore';\nimport { TaskFormSidebar } from '../../components/task-form-sidebar/TaskFormSidebar';\nexport function TaskList() {\n  const { tasks, addTask } = useTaskStore();\n  const [sidebarOpen, setSidebarOpen] = useState(false);\n  return (\n    <div>\n      <TaskFormSidebar open={sidebarOpen} task={null} onSave={() => {}} onCancel={() => {}} />\n    </div>\n  );\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'task-form-sidebar', 'TaskFormSidebar.tsx'),
    `export interface TaskFormSidebarProps { task?: unknown; onSave: (d: unknown) => void; onCancel: () => void; }\nexport function TaskFormSidebar({ task, onSave, onCancel }: TaskFormSidebarProps) { return <div />; }\n`
  );

  consolidateDuplicateZustandStores(tmp);
  assert(!fs.existsSync(path.join(tmp, 'src', 'store', 'task', 'task.state.ts')), 'duplicate task.state.ts removed');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'task', 'task.store.ts')), 'task.store.ts kept');
  const store = fs.readFileSync(path.join(tmp, 'src', 'store', 'task', 'task.store.ts'), 'utf-8');
  assert(!/import\s+\{\s*useTaskStore\s*\}/.test(store), 'circular useTaskStore import removed from store');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'useTaskStore.ts')), 'barrel useTaskStore.ts created');

  fixZustandSelectorFields(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'task-list', 'TaskList.tsx'), 'utf-8');
  assert(/items:\s*tasks/.test(page), 'destructured tasks aliased from items');
  assert(!/\btasks,\s*addTask/.test(page) || /items:\s*tasks/.test(page), 'bare tasks destructuring fixed');

  syncComponentCallSiteProps(tmp);
  const synced = fs.readFileSync(path.join(tmp, 'src', 'pages', 'task-list', 'TaskList.tsx'), 'utf-8');
  assert(!/<TaskFormSidebar[^>]*\bopen=/.test(synced), 'open prop stripped when not in TaskFormSidebarProps');

  const withOpenInterface = injectMissingComponentProps(
    `<TaskFormSidebar task={null} onSave={() => {}} onCancel={() => {}} />`,
    new Map([['TaskFormSidebar', new Set(['open', 'task', 'onSave', 'onCancel'])]])
  );
  assert(!/open=\{/.test(withOpenInterface) || /sidebarOpen/.test(withOpenInterface), 'open injected only when interface requires it');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Duplicate zustand hook lines, taskStore import, delete dialog onConfirm ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-zustand-hook-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { zustand: '^5.0.3', react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'useTaskStore.ts'),
    `import { create } from 'zustand';\nexport interface TaskStore { items: unknown[]; addTask: () => void; updateTask: () => void; deleteTask: () => void; }\nexport const useTaskStore = create<TaskStore>(() => ({ items: [], addTask: () => {}, updateTask: () => {}, deleteTask: () => {} }));\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `import { useTaskStore } from '../store/taskStore';\nexport default function TaskList() {\n  const deleteTaskAction = useTaskStore((state) => state.deleteTask);\n  const { items: tasks, addTask, deleteTask: deleteTaskAction } = useTaskStore();\n  const { addTask, deleteTask: deleteTaskAction } = useTaskStore();\n  const confirmDelete = () => {};\n  const closeDelete = () => {};\n  return (\n    <TaskDeleteDialog open={true} task={null} onClose={closeDelete} onConfirm={confirmDelete} />\n  );\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'TaskDeleteDialog.tsx'),
    `export interface TaskDeleteDialogProps { open: boolean; task: unknown; onClose: (confirmed: boolean) => void; }\nexport function TaskDeleteDialog(props: TaskDeleteDialogProps) { return null; }\n`
  );

  fixReactModuleImports(tmp);
  const pageImport = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(/from ['"]\.\.\/store\/useTaskStore['"]/.test(pageImport), 'taskStore import resolves to useTaskStore');

  fixZustandHookUsage(tmp);
  const pageHook = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert((pageHook.match(/=\s*useTaskStore\(\s*\)/g) || []).length === 1, 'single useTaskStore() destructuring remains');
  assert(/items:\s*tasks/.test(pageHook), 'consolidated destructuring keeps items alias');

  syncComponentCallSiteProps(tmp);
  const pageDialog = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(!/\bonConfirm=/.test(pageDialog), 'onConfirm stripped from delete dialog call site');
  assert(/\bonClose=\{\(confirmed\)/.test(pageDialog), 'onConfirm merged into onClose(confirmed)');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Task model completed → status alignment ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-task-model-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export type TaskStatus = 'todo' | 'in-progress' | 'done';\nexport interface Task { id: string; title: string; description: string; status: TaskStatus; }\nexport type TaskDraft = Omit<Task, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `import { Task, TaskDraft } from '../models/task.model';\nexport function add(draft: TaskDraft) {\n  const newTask: Task = { id: '1', ...draft, completed: false };\n  return newTask;\n}\n`
  );
  fixTaskModelFieldMismatches(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(!/\bcompleted\b/.test(page), 'completed field removed from Task literal');
  assert(/:\s*Task\s*=/.test(page), 'Task annotation preserved');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Missing store, phantom service import, status/priority alignment ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-store-scaffold-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { zustand: '^5.0.3', react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export type TaskStatus = 'todo' | 'in-progress' | 'done';\nexport interface Task { id: string; title: string; description: string; status: TaskStatus; }\nexport type TaskDraft = Omit<Task, 'id'>;\n`
  );
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'useTaskStore.ts'), `export { useTaskStore } from './taskStore';\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `import { useTaskStore } from '../store/useTaskStore';\nimport { Task, TaskDraft } from '../models/task.model';\nexport default function TaskList() {\n  const { tasks, addTask } = useTaskStore();\n  const draft: TaskDraft = { title: 'a', description: 'b', status: 'in_progress' as any, priority: 'low' as any };\n  return null;\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'TaskDeleteDialog.tsx'),
    `import { Task } from '../services/task.service';\nexport function TaskDeleteDialog({ task }: { task: Task | null }) { return null; }\n`
  );

  ensureZustandStoreScaffold(tmp);
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'taskStore.ts')), 'missing taskStore.ts scaffolded');
  const store = fs.readFileSync(path.join(tmp, 'src', 'store', 'taskStore.ts'), 'utf-8');
  assert(/export const useTaskStore = create/.test(store), 'scaffold exports useTaskStore');

  fixReactModuleImports(tmp);
  const dialog = fs.readFileSync(path.join(tmp, 'src', 'components', 'TaskDeleteDialog.tsx'), 'utf-8');
  assert(/models\/task\.model/.test(dialog), 'phantom task.service import fixed');
  assert(!/services\/task\.service/.test(dialog), 'phantom task.service path is gone');

  alignTaskStatusLiterals(tmp);
  const pageStatus = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(!/in_progress/.test(pageStatus), 'in_progress normalized to in-progress');

  fixTaskModelFieldMismatches(tmp);
  const pageFields = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(!/\bpriority\b/.test(pageFields), 'priority removed when not on Task model');

  fixZustandHookUsage(tmp);
  const pageHook = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(/items:\s*tasks/.test(pageHook), 'tasks destructuring aliased from items');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Hallucinated types/task import → models/task.model (TS2307) ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-types-task-'));
  fs.mkdirSync(path.join(tmp, 'src', 'components', 'task-delete-dialog'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export type TaskStatus = 'todo' | 'in-progress' | 'done';\nexport interface Task { id: string; title: string; description: string; status: TaskStatus; }\nexport type TaskDraft = Omit<Task, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'task-delete-dialog', 'TaskDeleteDialog.tsx'),
    `import { Task } from '../../types/task';\nexport function TaskDeleteDialog({ task }: { task: Task | null }) { return null; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'task-delete-dialog', 'TaskForm.tsx'),
    `import type { Task, TaskDraft } from '@/types/task';\nexport function TaskForm({ task }: { task: Task; draft: TaskDraft }) { return null; }\n`
  );

  fixReactModuleImports(tmp);
  const dialog = fs.readFileSync(
    path.join(tmp, 'src', 'components', 'task-delete-dialog', 'TaskDeleteDialog.tsx'),
    'utf-8'
  );
  assert(/models\/task\.model/.test(dialog), 'types/task rewrite to models/task.model');
  assert(!/types\/task/.test(dialog), 'fabricated types/task import is gone');
  const form = fs.readFileSync(
    path.join(tmp, 'src', 'components', 'task-delete-dialog', 'TaskForm.tsx'),
    'utf-8'
  );
  assert(/models\/task\.model/.test(form), '@/types/task rewrite to models/task.model');
  assert(!/types\/task/.test(form), 'fabricated @/types/task import is gone');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Pin source models + NGXS store; do not invent Task fields ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pin-source-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export interface Task { id: string; title: string; completed: boolean; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'useTaskStore.ts'),
    `export { useTaskStore } from './taskStore';\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `import { Task } from '../models/task.model';\nconst t: Task = { id: '1', title: 'a', status: 'in_progress' as any, priority: 'high' as any };\n`
  );
  const sourceFilesMap = {
    'src/app/models/task.model.ts':
      `export type TaskStatus = 'todo' | 'in-progress' | 'done';\nexport interface Task { id: string; title: string; description: string; status: TaskStatus; }\nexport type TaskDraft = Omit<Task, 'id'>;\n`,
    'src/app/store/task/task.state.ts':
      `import { Injectable } from '@angular/core';\nimport { Action, State, StateContext } from '@ngxs/store';\nimport { Task } from '../../models/task.model';\nexport interface TaskStateModel { items: Task[]; }\n@State<TaskStateModel>({ name: 'tasks', defaults: { items: [] } })\n@Injectable()\nexport class TaskState {\n  @Action(class AddTask {})\n  addTask(ctx: StateContext<TaskStateModel>, action: { payload: Task }) {\n    ctx.patchState({ items: [...ctx.getState().items, action.payload] });\n  }\n}\n`
  };
  pinSourceDomainArtifacts(tmp, sourceFilesMap);
  const model = fs.readFileSync(path.join(tmp, 'src', 'models', 'task.model.ts'), 'utf-8');
  assert(/status: TaskStatus/.test(model), 'source Task model overwrites AI model');
  assert(!/completed: boolean/.test(model), 'AI-invented completed field not kept on model');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'taskStore.ts')), 'zustand store written from NGXS source');

  alignTaskStatusLiterals(tmp);
  fixTaskModelFieldMismatches(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(!/in_progress/.test(page), 'status literal aligned from pinned model');
  assert(!/\bpriority\b/.test(page), 'invented priority stripped using pinned model');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Unit bundle matching: kebab vs PascalCase, optional scss/html ---
{
  assert(
    normalizeReactPlanPath('src/components/task-delete-dialog/TaskDeleteDialog.html') === null,
    'React plan drops leftover .html'
  );
  assert(
    normalizeReactPlanPath('src/index.html') === null,
    'React plan drops src/index.html (Vite root index.html is templated)'
  );
  assert(
    normalizeReactPlanPath('src/index.tsx') === null,
    'React plan drops src/index.tsx (entry is templated main.tsx)'
  );
  assert(
    normalizeReactPlanPath('src/main.ts') === null,
    'React plan drops Angular main.ts (templated main.tsx)'
  );
  assert(
    normalizeReactPlanPath('src/app/components/task-delete-dialog/task-delete-dialog.component.ts') ===
      'src/components/task-delete-dialog/TaskDeleteDialog.tsx',
    'Angular component.ts remaps to React PascalCase tsx under src/'
  );
  assert(
    normalizeReactPlanPath('src/components/task-form-sidebar/task-form-sidebar.component') ===
      'src/components/task-form-sidebar/TaskFormSidebar.tsx',
    'bare .component unit id remaps to TaskFormSidebar.tsx'
  );
  assert(
    normalizeReactPlanPath('src/app/components/task-form-sidebar/task-form-sidebar.component.scss') ===
      'src/components/task-form-sidebar/TaskFormSidebar.scss',
    'Angular component.scss remaps to PascalCase scss'
  );

  const bundle = [
    { path: 'src/components/task-delete-dialog.tsx', content: 'export function TaskDeleteDialog() { return null; }' }
  ];
  const match = matchUnitBundleFile(bundle, 'src/components/task-delete-dialog/TaskDeleteDialog.tsx');
  assert(match && match.content.includes('TaskDeleteDialog'), 'kebab filename matches PascalCase plan path');
  assert(
    matchUnitBundleFile(bundle, 'src/components/task-delete-dialog/TaskDeleteDialog.scss') === null,
    'scss is not matched from a tsx-only bundle'
  );
}

// --- Angular→React: leftover .component triad must not skip as incomplete ---
{
  const unitId = 'src/components/task-form-sidebar/task-form-sidebar.component';
  const planItems = [
    {
      newPath: `${unitId}.ts`,
      explanationOfSource: 'sidebar class',
      unit: unitId,
      complexity: 'medium',
      dependencies: []
    },
    {
      newPath: `${unitId}.html`,
      explanationOfSource: 'sidebar template',
      unit: unitId,
      complexity: 'medium',
      dependencies: []
    },
    {
      newPath: `${unitId}.scss`,
      explanationOfSource: 'sidebar styles',
      unit: unitId,
      complexity: 'low',
      dependencies: []
    }
  ];
  const units = groupPlanIntoMigrationUnits(planItems, 'React');
  assert(units.length === 1, 'React grouping collapses Angular triad into one unit');
  const paths = units[0].files.map((f) => f.newPath);
  assert(
    paths.includes('src/components/task-form-sidebar/TaskFormSidebar.tsx'),
    'React grouping remaps .component.ts to TaskFormSidebar.tsx'
  );
  assert(!paths.some((p) => /\.html$/i.test(p)), 'React grouping drops .html siblings');
  assert(!paths.some((p) => /\.component\./i.test(p)), 'React grouping has no leftover .component.* paths');

  const leftoverTriad = {
    id: unitId,
    label: unitId,
    files: planItems.map((item) => ({ newPath: item.newPath }))
  };
  const coerced = coerceReactMigrationUnit(leftoverTriad);
  assert(
    coerced.files.some((f) => f.newPath.endsWith('TaskFormSidebar.tsx')),
    'coerce remaps a leftover Angular triad to TaskFormSidebar.tsx'
  );
  assert(
    !coerced.files.some((f) => /\.html$/i.test(f.newPath)),
    'coerce drops invented .html from a leftover triad'
  );
  assert(
    !String(coerced.label).endsWith('.component'),
    'coerce does not keep the .component skip label'
  );

  const synthesized = synthesizeReactUnitFromAngular(coerced, {
    'src/app/components/task-form-sidebar/task-form-sidebar.component.ts': `
import { Component, EventEmitter, Input, Output } from '@angular/core';
@Component({ selector: 'app-task-form-sidebar', templateUrl: './task-form-sidebar.component.html' })
export class TaskFormSidebarComponent {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();
}
`,
    'src/app/components/task-form-sidebar/task-form-sidebar.component.html':
      '<form><input name="title" /></form>'
  });
  assert(synthesized.length > 0, 'synthesizer builds TaskFormSidebar from Angular source');
  assert(
    matchUnitBundleFile(synthesized, 'src/components/task-form-sidebar/TaskFormSidebar.tsx'),
    'synthesized tsx matches the remapped React plan path'
  );
  assert(
    /export default function TaskFormSidebar/.test(synthesized[0].content),
    'synthesized component is a React function named TaskFormSidebar'
  );
}

// --- Broken App.tsx interface leftover + page shell ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-app-shell-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages', 'task-list'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'task-list', 'TaskList.tsx'),
    `export default function TaskList() { return <div>list</div>; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export type TaskStatus = 'todo' | 'in-progress' | 'done';\nexport interface Task { id: string; title: string; description: string; status: TaskStatus; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'App.tsx'),
    `interface Task {\n  id: string;\n  title: string;\n  description: string; | 'medium' | 'high';\n  dueDate?: string;\n}\nexport default function App() { return <div>invented</div>; }\n`
  );

  fixTaskModelFieldMismatches(tmp);
  const afterStrip = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(!/;\s*\|/.test(afterStrip), 'broken union leftover after Task field is removed');

  ensureReactAppShell(tmp);
  const app = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(/TaskList/.test(app), 'App.tsx mounts converted TaskList page');
  assert(/react-router-dom/.test(app), 'App.tsx uses react-router-dom');
  assert(!/invented/.test(app), 'hallucinated App UI is replaced');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Field strip must not leave `task.` (TS1003); fat App.tsx is replaced ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-app-ts1003-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages', 'task-list'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export type TaskStatus = 'todo' | 'in-progress' | 'done';\nexport interface Task { id: string; title: string; description: string; status: TaskStatus; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'task-list', 'TaskList.tsx'),
    `import { Task } from '../../models/task.model';\nexport default function TaskList({ task }: { task: Task }) {\n  return <span>{task.priority}</span>;\n}\n`
  );
  let fatApp = `import TaskList from './pages/task-list/TaskList';\nexport default function App() {\n  return (\n    <div>\n      <TaskList />\n      <span>{task.}</span>\n    </div>\n  );\n}\n`;
  while (fatApp.split('\n').length < 90) fatApp += '// padding TaskList\n';
  fs.writeFileSync(path.join(tmp, 'src', 'App.tsx'), fatApp);

  fixTaskModelFieldMismatches(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'task-list', 'TaskList.tsx'), 'utf-8');
  assert(!/task\.\s*\}/.test(page), 'member access strip does not leave task.}');
  assert(/\{task\}/.test(page), 'task.priority becomes {task}');

  fixReactTypeErrors(
    tmp,
    'src/App.tsx(257,38): error TS1003: Identifier expected.'
  );
  const app = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(/react-router-dom/.test(app), 'TS1003 in App.tsx forces router shell');
  assert(app.split('\n').length < 40, 'fat invented App.tsx is replaced');
  assert(!/\{task\./.test(app), 'dangling task. expression is gone from App');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Status label `done` is a real TaskStatus key, not an invented field ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-status-labels-'));
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'task.model.ts'),
    `export type TaskStatus = 'todo' | 'in-progress' | 'done';
export interface Task { id: string; title: string; description: string; status: TaskStatus; }
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done'
};
`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'TaskList.tsx'),
    `import { Task } from '../models/task.model';
const t: Task = { id: '1', title: 'a', description: '', status: 'todo', priority: 'high' };
`
  );
  fixTaskModelFieldMismatches(tmp);
  const model = fs.readFileSync(path.join(tmp, 'src', 'models', 'task.model.ts'), 'utf-8');
  assert(/done:\s*'Done'/.test(model), 'TASK_STATUS_LABELS.done is not stripped as an invented field');
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'TaskList.tsx'), 'utf-8');
  assert(!/\bpriority\b/.test(page), 'invented priority still stripped from non-model files');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- NG1010: MatButtonModule / MatIconModule in imports[] without a value import ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng1010-material-'));
  const dir = path.join(tmp, 'src', 'app', 'pages', 'task-list');
  fs.mkdirSync(dir, { recursive: true });
  const brokenTs = `import { Component } from '@angular/core';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';

@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [MatSidenavModule, MatToolbarModule, MatButtonModule, MatIconModule],
  templateUrl: './task-list.component.html',
  styleUrl: './task-list.component.scss'
})
export class TaskListComponent {}
`;
  const brokenHtml = `<mat-sidenav-container>
  <mat-toolbar>
    <mat-icon>checklist</mat-icon>
    <button mat-flat-button type="button">Add task</button>
  </mat-toolbar>
</mat-sidenav-container>
`;
  fs.writeFileSync(path.join(dir, 'task-list.component.ts'), brokenTs);
  fs.writeFileSync(path.join(dir, 'task-list.component.html'), brokenHtml);
  fs.writeFileSync(path.join(dir, 'task-list.component.scss'), '/* */\n');

  repairAngularComponentFile(path.join(dir, 'task-list.component.ts'));
  const ts = fs.readFileSync(path.join(dir, 'task-list.component.ts'), 'utf-8');
  assert(/from '@angular\/material\/button'/.test(ts), 'NG1010 repair imports MatButtonModule');
  assert(/from '@angular\/material\/icon'/.test(ts), 'NG1010 repair imports MatIconModule');
  assert(
    /import\s*\{[^}]*\bMatButtonModule\b[^}]*\}\s*from\s*'@angular\/material\/button'/.test(ts),
    'MatButtonModule is a value import'
  );
  assert(
    /imports:\s*\[[^\]]*MatButtonModule/.test(ts),
    'MatButtonModule stays in the decorator imports array'
  );
  assert(!/import type\s*\{[^}]*MatButtonModule/.test(ts), 'MatButtonModule is not import type');

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng1010-fixfn-'));
  const dir2 = path.join(tmp2, 'src', 'app', 'pages', 'task-list');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'task-list.component.ts'), brokenTs);
  fs.writeFileSync(path.join(dir2, 'task-list.component.html'), brokenHtml);
  fs.writeFileSync(path.join(dir2, 'task-list.component.scss'), '/* */\n');
  const n = fixAngularCompileErrors(
    tmp2,
    `src/app/pages/task-list/task-list.component.ts:35:48: MatButtonModule Unknown reference. NG1010: 'imports' must be an array of components, directives, pipes, or NgModules. Value could not be determined statically. MatIconModule Unknown reference.`
  );
  assert(n >= 1, 'fixAngularCompileErrors reports a changed file');
  const ts2 = fs.readFileSync(path.join(dir2, 'task-list.component.ts'), 'utf-8');
  assert(/from '@angular\/material\/button'/.test(ts2), 'fixAngularCompileErrors restores MatButtonModule import');
  assert(/from '@angular\/material\/icon'/.test(ts2), 'fixAngularCompileErrors restores MatIconModule import');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// --- Declarable packages are inferred from names / templates, not an allowlist ---
{
  assert(
    inferDeclarablePackage('MatGridListModule') === '@angular/material/grid-list',
    'MatGridListModule → @angular/material/grid-list by convention'
  );
  assert(
    inferDeclarablePackage('MatTreeModule') === '@angular/material/tree',
    'MatTreeModule → @angular/material/tree by convention'
  );
  assert(
    inferDeclarablePackage('MatSidenavContainer') === '@angular/material/sidenav',
    'MatSidenavContainer shares the sidenav entry'
  );
  assert(
    inferDeclarablePackage('MatButtonModule') === '@angular/material/button',
    'MatButtonModule → @angular/material/button by convention'
  );
  assert(
    inferDeclarablePackage(
      'MatBannerModule',
      "import type { MatBannerModule } from '@angular/material/banner';"
    ) === '@angular/material/banner',
    'existing import path wins over name inference'
  );
  const htmlNeeded = declarablesNeededByHtml(
    `<mat-tree></mat-tree><mat-grid-list cols="2"></mat-grid-list><button mat-flat-button type="button">Go</button>`
  );
  assert(htmlNeeded.includes('MatTreeModule'), 'template <mat-tree> needs MatTreeModule');
  assert(htmlNeeded.includes('MatGridListModule'), 'template <mat-grid-list> needs MatGridListModule');
  assert(htmlNeeded.includes('MatButtonModule'), 'mat-flat-button attribute needs MatButtonModule');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-infer-'));
  const dir = path.join(tmp, 'src', 'app', 'pages', 'board');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'board.component.ts'),
    `import { Component } from '@angular/core';
import { type MatGridListModule } from '@angular/material/grid-list';
import type { MatTreeModule } from '@angular/material/tree';

@Component({
  selector: 'app-board',
  standalone: true,
  imports: [MatGridListModule, MatTreeModule],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss'
})
export class BoardComponent {}
`
  );
  fs.writeFileSync(
    path.join(dir, 'board.component.html'),
    `<mat-grid-list cols="2"><mat-tree></mat-tree></mat-grid-list>\n`
  );
  repairAngularComponentFile(path.join(dir, 'board.component.ts'));
  const ts = fs.readFileSync(path.join(dir, 'board.component.ts'), 'utf-8');
  assert(
    /import\s*\{[^}]*\bMatGridListModule\b[^}]*\}\s*from\s*'@angular\/material\/grid-list'/.test(ts) &&
      !/import\s*\{[^}]*\btype\s+MatGridListModule\b/.test(ts),
    'inferred MatGridListModule is a value import'
  );
  assert(
    /import\s*\{[^}]*\bMatTreeModule\b[^}]*\}\s*from\s*'@angular\/material\/tree'/.test(ts) &&
      !/import\s+type\s*\{[^}]*\bMatTreeModule\b/.test(ts),
    'inferred MatTreeModule is a value import'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-packages-from-src-'));
  fs.mkdirSync(path.join(tmp, 'src', 'app', 'pages', 'board'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify(
      {
        name: 'migrated-angular-project',
        dependencies: { '@angular/core': '22.0.8', '@angular/common': '22.0.8' }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(tmp, 'angular.json'),
    JSON.stringify(
      {
        projects: {
          app: {
            architect: {
              build: { options: { styles: ['src/styles.scss'] } }
            }
          }
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'index.html'),
    `<!doctype html><html><head></head><body><app-root></app-root></body></html>\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'pages', 'board', 'board.component.ts'),
    `import { Component } from '@angular/core';

@Component({
  selector: 'app-board',
  standalone: true,
  imports: [MatGridListModule],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss'
})
export class BoardComponent {}
`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'app', 'pages', 'board', 'board.component.html'),
    `<mat-grid-list cols="3"></mat-grid-list>\n`
  );

  repairAngularWorkspace(tmp, {
    sourcePackageJson: { dependencies: { react: '^19.0.0' } },
    sourceFilesMap: {}
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies['@angular/material'], 'generated mat-* usage adds @angular/material');
  assert(pkg.dependencies['@angular/cdk'], 'generated mat-* usage adds @angular/cdk');
  assert(!pkg.dependencies['@mui/material'], 'MUI is not injected without MUI source');
  const ts = fs.readFileSync(path.join(tmp, 'src', 'app', 'pages', 'board', 'board.component.ts'), 'utf-8');
  assert(/from '@angular\/material\/grid-list'/.test(ts), 'value import inferred for MatGridListModule');
  const added = ensureAngularMaterialPackages(tmp, {}, {});
  assert(added === 0, 'material package ensure is idempotent');
  const aj = JSON.parse(fs.readFileSync(path.join(tmp, 'angular.json'), 'utf-8'));
  const styles = aj.projects.app.architect.build.options.styles;
  assert(
    styles.some((s) => String(s).includes('@angular/material/prebuilt-themes')),
    'Material prebuilt theme is registered'
  );
  const indexHtml = fs.readFileSync(path.join(tmp, 'src', 'index.html'), 'utf-8');
  assert(/Material\+Icons/.test(indexHtml), 'Material Icons font is linked in Angular index.html');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- React→Angular: (onSave)/onRemove.emit vs @Output() save/remove ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-outputs-'));
  const tableDir = path.join(tmp, 'src', 'app', 'components', 'task-table');
  const formDir = path.join(tmp, 'src', 'app', 'components', 'task-form-sidebar');
  const listDir = path.join(tmp, 'src', 'app', 'pages', 'task-list');
  fs.mkdirSync(tableDir, { recursive: true });
  fs.mkdirSync(formDir, { recursive: true });
  fs.mkdirSync(listDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","dependencies":{"@angular/core":"20.0.0"}}\n');

  fs.writeFileSync(
    path.join(tableDir, 'task-table.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Task } from '../../models/task.model';
@Component({
  selector: 'app-task-table',
  standalone: true,
  templateUrl: './task-table.component.html'
})
export class TaskTableComponent {
  @Input() tasks: Task[] = [];
  @Output() remove = new EventEmitter<Task>();
  @Output() edit = new EventEmitter<Task>();
  onRemove(value: Task): void {
    this.remove.emit(value);
  }
  onEdit(value: Task): void {
    this.edit.emit(value);
  }
}
`
  );
  fs.writeFileSync(
    path.join(tableDir, 'task-table.component.html'),
    `<button type="button" class="hover:bg-gray-100 transition-colors" (click)="onRemove.emit(task)">Delete</button>
`
  );
  fs.writeFileSync(
    path.join(formDir, 'task-form-sidebar.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Task, TaskDraft } from '../../models/task.model';
@Component({
  selector: 'app-task-form-sidebar',
  standalone: true,
  templateUrl: './task-form-sidebar.component.html'
})
export class TaskFormSidebarComponent {
  @Input() task: Task | null = null;
  @Output() save = new EventEmitter<TaskDraft>();
  @Output() cancel = new EventEmitter<void>();
  onSave(value: TaskDraft): void {
    this.save.emit(value);
  }
}
`
  );
  fs.writeFileSync(path.join(formDir, 'task-form-sidebar.component.html'), `<form></form>\n`);
  fs.writeFileSync(
    path.join(listDir, 'task-list.component.ts'),
    `import { Component } from '@angular/core';
import { Task, TaskDraft } from '../../models/task.model';
import { TaskFormSidebarComponent } from '../../components/task-form-sidebar/task-form-sidebar.component';
import { TaskTableComponent } from '../../components/task-table/task-table.component';
@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [TaskFormSidebarComponent, TaskTableComponent],
  templateUrl: './task-list.component.html'
})
export class TaskListComponent {
  editingTask: Task | null = null;
  onSave(draft: TaskDraft): void {}
}
`
  );
  fs.writeFileSync(
    path.join(listDir, 'task-list.component.html'),
    `<app-task-form-sidebar [task]="editingTask" (onSave)="onSave($event)"></app-task-form-sidebar>
<app-task-table [tasks]="[]" (onRemove)="deletingTask = $event"></app-task-table>
`
  );

  repairAngularWorkspace(tmp, { sourceFilesMap: {}, sourcePackageJson: { dependencies: { react: '^19' } } });

  const tableHtml = fs.readFileSync(path.join(tableDir, 'task-table.component.html'), 'utf-8');
  const tableTs = fs.readFileSync(path.join(tableDir, 'task-table.component.ts'), 'utf-8');
  const listHtml = fs.readFileSync(path.join(listDir, 'task-list.component.html'), 'utf-8');
  assert(
    /\(click\)="onRemove\(task\)"/.test(tableHtml),
    'onRemove.emit(task) rewrites to method call when onRemove is a wrapper'
  );
  assert(!/onRemove\.emit/.test(tableHtml), 'task-table template does not keep onRemove.emit');
  assert(
    !/@Output\(\)\s+onRemove/.test(tableTs),
    'does not add a colliding @Output() onRemove next to @Output() remove'
  );
  assert(/\(save\)="onSave\(\$event\)"/.test(listHtml), 'parent (onSave) remaps to child @Output() save');
  assert(!/\(onSave\)=/.test(listHtml), 'parent no longer binds unknown (onSave) DOM event');
  assert(/\(remove\)=/.test(listHtml), 'parent (onRemove) remaps to child @Output() remove');

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-emit-fix-'));
  const t2 = path.join(tmp2, 'src', 'app', 'components', 'task-table');
  const l2 = path.join(tmp2, 'src', 'app', 'pages', 'task-list');
  fs.mkdirSync(t2, { recursive: true });
  fs.mkdirSync(l2, { recursive: true });
  fs.writeFileSync(
    path.join(t2, 'task-table.component.ts'),
    `import { Component, EventEmitter, Output } from '@angular/core';
import { Task } from '../../models/task.model';
@Component({ selector: 'app-task-table', standalone: true, templateUrl: './task-table.component.html' })
export class TaskTableComponent {
  @Output() remove = new EventEmitter<Task>();
  onRemove(value: Task): void { this.remove.emit(value); }
}
`
  );
  fs.writeFileSync(
    path.join(t2, 'task-table.component.html'),
    `<button (click)="onRemove.emit(task)">x</button>\n`
  );
  fs.writeFileSync(
    path.join(l2, 'task-list.component.ts'),
    `import { Component } from '@angular/core';
import { TaskDraft } from '../../models/task.model';
@Component({ selector: 'app-task-list', standalone: true, templateUrl: './task-list.component.html' })
export class TaskListComponent {
  onSave(draft: TaskDraft): void {}
}
`
  );
  fs.writeFileSync(
    path.join(l2, 'task-list.component.html'),
    `<app-task-form-sidebar (onSave)="onSave($event)"></app-task-form-sidebar>\n`
  );
  fs.mkdirSync(path.join(tmp2, 'src', 'app', 'components', 'task-form-sidebar'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp2, 'src', 'app', 'components', 'task-form-sidebar', 'task-form-sidebar.component.ts'),
    `import { Component, EventEmitter, Output } from '@angular/core';
import { TaskDraft } from '../../models/task.model';
@Component({ selector: 'app-task-form-sidebar', standalone: true, templateUrl: './task-form-sidebar.component.html' })
export class TaskFormSidebarComponent {
  @Output() save = new EventEmitter<TaskDraft>();
}
`
  );
  fs.writeFileSync(
    path.join(tmp2, 'src', 'app', 'components', 'task-form-sidebar', 'task-form-sidebar.component.html'),
    `<form></form>\n`
  );

  const errText = `
Error: src/app/components/task-table/task-table.component.html:37:173: Property 'emit' does not exist
  37 │ ...over:bg-gray-100 transition-colors" (click)="onRemove.emit(task)">
Error occurs in the template of component TaskTableComponent.
src/app/components/task-table/task-table.component.ts:9:15: templateUrl: './task-table.component.html'
TS2345: Argument of type 'Event' is not assignable to parameter of type 'TaskDraft'.
src/app/pages/task-list/task-list.component.html:47:25: (onSave)="onSave($event)"
Error occurs in the template of component TaskListComponent.
`;
  const n = fixAngularCompileErrors(tmp2, errText);
  assert(n >= 1, 'fixAngularCompileErrors repairs emit/$event template errors');
  const tableHtml2 = fs.readFileSync(path.join(t2, 'task-table.component.html'), 'utf-8');
  const listHtml2 = fs.readFileSync(path.join(l2, 'task-list.component.html'), 'utf-8');
  assert(/onRemove\(task\)/.test(tableHtml2), 'compile fixer strips method.emit');
  assert(/\(save\)="onSave\(\$event\)"/.test(listHtml2), 'compile fixer remaps (onSave) to (save)');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\nSome postprocess tests failed.');
} else {
  console.log('\nAll postprocess tests passed.');
}
