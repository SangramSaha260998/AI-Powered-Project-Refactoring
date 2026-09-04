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
  repairAngularStrictNullAndStatusTypes,
  ensureAngularMaterialPackages,
  inferDeclarablePackage,
  declarablesNeededByHtml,
  repairSelfClosingNonVoidTags,
  repairMismatchedHtmlClosingTags,
  repairZeroArgTemplateCalls,
  ensureAngularAppModels,
  dedupeDuplicateClassMembers
} from '../src/services/postprocess.js';
import { rewriteHtmlLucideToInlineSvg } from '../src/services/lucideInlineSvg.js';
import {
  sanitizeAngularComponentTs,
  sanitizeCssContent,
  matchUnitBundleFile,
  normalizeReactPlanPath,
  groupPlanIntoMigrationUnits,
  coerceReactMigrationUnit,
  synthesizeReactUnitFromAngular,
  injectAngularWorkspaceTemplates,
  enforceAngularPackageVersions,
  splitReworkItems
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
    path.join(tmp, 'src', 'pages', 'HostPage.ts'),
    `export default function HostPage() {\n  return (\n    <div className="layout">\n      <h1>Host</h1>\n    </div>\n  );\n}\n`
  );
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'item.state.ts'), `export const tasks = [];\n`);

  repairReactWorkspace(tmp, {});

  assert(!fs.existsSync(path.join(tmp, 'src', 'pages', 'HostPage.ts')), 'JSX HostPage.ts is removed');
  assert(fs.existsSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx')), 'JSX HostPage.ts renamed to .tsx');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'item.state.ts')), 'plain .ts store file is not renamed');

  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'ids.types.ts'),
    `export type Result = Promise<User>;\nexport function wrap<T>(x: T): T { return x; }\n`
  );
  repairReactWorkspace(tmp, {});
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'ids.types.ts')), 'generic Promise<User> .ts is not renamed to .tsx');
  assert(!fs.existsSync(path.join(tmp, 'src', 'store', 'ids.types.tsx')), 'generic types file has no .tsx twin');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- React leftovers: NGXS → zustand, Material → MUI, packages, truncation ---
{
  const ngxs = `import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { Item } from '../../models/item.model';
import { AddItem, DeleteItem, UpdateItem } from './item.actions';

export interface ItemStateModel {
  items: Item[];
}

const INITIAL_ITEMS: Item[] = [{ id: '1', title: 'A', description: '', status: 'todo' }];

@State<ItemStateModel>({
  name: 'tasks',
  defaults: {
    items: INITIAL_ITEMS
  }
})
@Injectable()
export class ItemState {
  @Selector()
  static items(state: ItemStateModel): Item[] {
    return state.items;
  }

  @Action(AddItem)
  addItem(ctx: StateContext<ItemStateModel>, action: AddItem): void {
    const item: Item = {
      ...action.payload,
      id: crypto.randomUUID()
    };
    ctx.patchState({
      items: [...ctx.getState().items, task]
    });
  }

  @Action(DeleteItem)
  deleteItem(ctx: StateContext<ItemStateModel>, action: DeleteItem): void {
    ctx.patchState({
      items: ctx.getState().items.filter((task) => task.id !== action.id)
    });
  }
}
`;
  const zustand = rewriteNgxsStateToZustand(ngxs);
  assert(/from 'zustand'/.test(zustand), 'NGXS state file imports zustand');
  assert(/export const useItemStore = create/.test(zustand), 'NGXS ItemState becomes useItemStore');
  assert(/addItem: \(payload\)/.test(zustand), 'AddItem action becomes addItem(payload)');
  assert(/deleteItem: \(id\)/.test(zustand), 'DeleteItem action becomes deleteItem(id)');
  assert(!/@State/.test(zustand), 'NGXS @State decorator is gone');
  assert(!/@angular\//.test(zustand), 'Angular imports stripped from converted store');

  const leftoverUi = `import { Store } from '@ngxs/store';
import { MatButtonModule } from '@angular/material/button';
import { ItemTableComponent } from '../../components/item-table/item-table.component';

export function HostPage() {
  private readonly store = inject(Store);
  readonly tasks$ = this.store.select(ItemState.items);

  onSave(draft) {
    this.store.dispatch(new AddItem(draft));
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
        <app-item-table [tasks]="tasks" (edit)="openEdit($event)" />
      }
    </mat-sidenav-container>
  );
}
`;
  const rewritten = rewriteReactAngularLeftovers(leftoverUi);
  assert(!/@angular\//.test(rewritten), 'leftover @angular imports stripped');
  assert(!/@ngxs\//.test(rewritten), 'leftover @ngxs imports stripped');
  assert(/useItemStore\(\(s\) => s\.items\)/.test(rewritten), 'NGXS select → zustand hook');
  assert(/useItemStore\.getState\(\)\.addItem\(draft\)/.test(rewritten), 'dispatch(new AddItem) → zustand method');
  assert(/<AppBar/.test(rewritten) && /<Toolbar>/.test(rewritten), 'mat-toolbar → AppBar+Toolbar');
  assert(/<Icon>checklist<\/Icon>/.test(rewritten), 'mat-icon → Icon');
  assert(/<Button variant="contained"/.test(rewritten), 'mat-flat-button → MUI Button');
  assert(/onClick=\{openAdd\}/.test(rewritten), '(click)="openAdd()" → onClick={openAdd}');
  assert(/<ItemTableComponent/.test(rewritten) || /<ItemTable/.test(rewritten), 'app-item-table → PascalCase component');
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
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'item.state.ts'), ngxs);
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.ts'),
    leftoverUi
  );

  repairReactWorkspace(tmp, {
    sourcePackageJson: {
      dependencies: { '@ngxs/store': '^20.0.0', '@angular/material': '^20.0.0' }
    },
    sourceFilesMap: {
      'src/app/store/item/item.state.ts': ngxs,
      'src/app/pages/host-page/host-page.component.html': '<mat-toolbar></mat-toolbar>'
    }
  });

  const storeOut = fs.readFileSync(path.join(tmp, 'src', 'store', 'item.state.ts'), 'utf-8');
  assert(/useItemStore/.test(storeOut), 'workspace repair converts NGXS store file');
  assert(fs.existsSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx')), 'JSX leftovers renamed to .tsx');
  const pageOut = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(/import \{ useItemStore \} from/.test(pageOut), 'useItemStore import injected into page');
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
  const caller = `import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog';
import { Item } from '../../models/item.model';

export function HostPage() {
  const openDelete = (item: Item) => {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      width: '400px',
      data: { item }
    });
    dialogRef.afterClosed().subscribe((confirmed) => {
      if (confirmed) {
        useItemStore.getState().deleteItem(task.id);
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
  assert(/<ConfirmDialogComponent/.test(convertedCaller), 'dialog component is rendered');
  assert(/open=\{Boolean\(/.test(convertedCaller), 'rendered dialog gets open prop');
  assert(/onClose=\{/.test(convertedCaller), 'rendered dialog gets onClose prop');
  assert(/deleteItem\(task\.id\)/.test(convertedCaller), 'afterClosed body is kept in onClose');
  assert(!/\bthis\./.test(convertedCaller), 'this. stripped in function component');

  const dialogComp = `import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

export class ConfirmDialogComponent {
  constructor(
    private readonly dialogRef: MatDialogRef<ConfirmDialogComponent, boolean>,
    @Inject(MAT_DIALOG_DATA) public data: { item: { title: string } }
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
  assert(/export function ConfirmDialogComponent\(\{ open/.test(convertedDialog), 'dialog class becomes function with open prop');
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
    path.join(tmp, 'src', 'components', 'ConfirmDialog.tsx'),
    `export function ConfirmDialog({ open, onClose, data }) {\n  return <div>{data?.item?.title}</div>;\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `export function HostPage() {\n  const [open, setOpen] = useState(false);\n  return <ConfirmDialog open={open} onClose={() => setOpen(false)} />;\n}\n`
  );
  const n = fixReactTypeErrors(
    tmp,
    [
      `src/pages/HostPage.tsx(2,26): error TS2304: Cannot find name 'useState'.`,
      `src/pages/HostPage.tsx(3,11): error TS2304: Cannot find name 'ConfirmDialog'.`
    ].join('\n')
  );
  assert(n >= 1, 'mechanical type-error fixer updates the file');
  const fixed = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(/import \{ useState \} from 'react'/.test(fixed), 'adds missing useState import');
  assert(/import \{ ConfirmDialog \} from/.test(fixed), 'adds missing local component import');

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
  fs.mkdirSync(path.join(tmp, 'src', 'store', 'item'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `export default function HostPage() { return <div />; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'App.tsx'),
    `import { HostPage } from './pages/host-page';\nexport default function App() { return <HostPage />; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export interface Item { id: string; title: string; description: string; status: 'todo' | 'in-progress' | 'done'; }\nexport type ItemDraft = Omit<Item, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'itemStore.ts'),
    `import { create } from 'zustand';\nexport interface Item { id: string; title: string; description?: string; status: 'todo' | 'in-progress' | 'done'; }\nexport type ItemDraft = Omit<Item, 'id'>;\nexport const useItemStore = create(() => ({ items: [] as Item[] }));\n`
  );
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'item', 'item.state.ts'), `export const useItemStateStore = () => ({});\n`);
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'item', 'item.actions.ts'), `export type AddItem = unknown;\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'Form.tsx'),
    `import { useForm } from 'react-hook-form';\nexport function Form() { useForm(); return null; }\n`
  );

  fixReactModuleImports(tmp);
  const app = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(/import HostPage from '\.\/pages\/HostPage'/.test(app), 'wrong path + named import fixed to default import');
  assert(!/host-page/.test(app), 'kebab import path is corrected');

  dedupeStoreModelTypes(tmp);
  const store = fs.readFileSync(path.join(tmp, 'src', 'store', 'itemStore.ts'), 'utf-8');
  assert(/from ['"].*models\/item\.model['"]/.test(store), 'store imports Item from models');
  assert(!/export interface Item/.test(store), 'duplicate Item interface removed from store');

  assert(removeUnusedStoreShards(tmp) >= 2, 'unused NGXS shard files removed');

  repairReactWorkspace(tmp, {});
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies['react-hook-form'], 'react-hook-form added from imports');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Duplicate zustand stores, selector fields, missing open prop ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-zustand-'));
  fs.mkdirSync(path.join(tmp, 'src', 'store', 'item'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'pages', 'host-page'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'components', 'item-editor'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'migrated-react-project', dependencies: { zustand: '^5.0.3', react: '^19.0.0' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export interface Item { id: string; title: string; description: string; status: 'todo' | 'in-progress' | 'done'; }\nexport type ItemDraft = Omit<Item, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'item', 'item.state.ts'),
    `import { useItemStore } from './item.store';\nimport { create } from 'zustand';\nimport { Item } from '../../models/item.model';\nexport interface ItemStateModel { items: Item[]; addItem: (t: Omit<Item, 'id'>) => void; updateItem: (t: Item) => void; deleteItem: (id: string) => void; }\nexport const useItemStore = create<ItemStateModel>(() => ({ items: [], addItem: () => {}, updateItem: () => {}, deleteItem: () => {} }));\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'item', 'item.store.ts'),
    `import { useItemStore } from './item.state';\nimport { create } from 'zustand';\nimport { Item, ItemDraft } from '../../models/item.model';\nexport interface ItemStateModel { items: Item[]; addItem: (p: ItemDraft) => void; updateItem: (p: Item) => void; deleteItem: (id: string) => void; }\nexport const useItemStore = create<ItemStateModel>(() => ({ items: [], addItem: () => {}, updateItem: () => {}, deleteItem: () => {} }));\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'host-page', 'HostPage.tsx'),
    `import { useState } from 'react';\nimport { useItemStore } from '../../store/useItemStore';\nimport { ItemEditor } from '../../components/item-editor/ItemEditor';\nexport function HostPage() {\n  const { tasks, addItem } = useItemStore();\n  const [sidebarOpen, setSidebarOpen] = useState(false);\n  return (\n    <div>\n      <ItemEditor open={sidebarOpen} task={null} onSave={() => {}} onCancel={() => {}} />\n    </div>\n  );\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'item-editor', 'ItemEditor.tsx'),
    `export interface ItemEditorProps { item?: unknown; onSave: (d: unknown) => void; onCancel: () => void; }\nexport function ItemEditor({ item, onSave, onCancel }: ItemEditorProps) { return <div />; }\n`
  );

  consolidateDuplicateZustandStores(tmp);
  assert(!fs.existsSync(path.join(tmp, 'src', 'store', 'item', 'item.state.ts')), 'duplicate item.state.ts removed');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'item', 'item.store.ts')), 'item.store.ts kept');
  const store = fs.readFileSync(path.join(tmp, 'src', 'store', 'item', 'item.store.ts'), 'utf-8');
  assert(!/import\s+\{\s*useItemStore\s*\}/.test(store), 'circular useItemStore import removed from store');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'useItemStore.ts')), 'barrel useItemStore.ts created');

  fixZustandSelectorFields(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'host-page', 'HostPage.tsx'), 'utf-8');
  assert(/items:\s*tasks/.test(page), 'destructured tasks aliased from items');
  assert(!/\btasks,\s*addItem/.test(page) || /items:\s*tasks/.test(page), 'bare tasks destructuring fixed');

  syncComponentCallSiteProps(tmp);
  const synced = fs.readFileSync(path.join(tmp, 'src', 'pages', 'host-page', 'HostPage.tsx'), 'utf-8');
  assert(!/<ItemEditor[^>]*\bopen=/.test(synced), 'open prop stripped when not in ItemEditorProps');

  const withOpenInterface = injectMissingComponentProps(
    `<ItemEditor task={null} onSave={() => {}} onCancel={() => {}} />`,
    new Map([['ItemEditor', new Set(['open', 'task', 'onSave', 'onCancel'])]])
  );
  assert(!/open=\{/.test(withOpenInterface) || /sidebarOpen/.test(withOpenInterface), 'open injected only when interface requires it');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Duplicate zustand hook lines, itemStore import, delete dialog onConfirm ---
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
    path.join(tmp, 'src', 'store', 'useItemStore.ts'),
    `import { create } from 'zustand';\nexport interface ItemStore { items: unknown[]; addItem: () => void; updateItem: () => void; deleteItem: () => void; }\nexport const useItemStore = create<ItemStore>(() => ({ items: [], addItem: () => {}, updateItem: () => {}, deleteItem: () => {} }));\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `import { useItemStore } from '../store/itemStore';\nexport default function HostPage() {\n  const deleteItemAction = useItemStore((state) => state.deleteItem);\n  const { items: tasks, addItem, deleteItem: deleteItemAction } = useItemStore();\n  const { addItem, deleteItem: deleteItemAction } = useItemStore();\n  const confirmDelete = () => {};\n  const closeDelete = () => {};\n  return (\n    <ConfirmDialog open={true} task={null} onClose={closeDelete} onConfirm={confirmDelete} />\n  );\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'ConfirmDialog.tsx'),
    `export interface ConfirmDialogProps { open: boolean; item: unknown; onClose: (confirmed: boolean) => void; }\nexport function ConfirmDialog(props: ConfirmDialogProps) { return null; }\n`
  );

  fixReactModuleImports(tmp);
  const pageImport = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(/from ['"]\.\.\/store\/useItemStore['"]/.test(pageImport), 'itemStore import resolves to useItemStore');

  fixZustandHookUsage(tmp);
  const pageHook = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert((pageHook.match(/=\s*useItemStore\(\s*\)/g) || []).length === 1, 'single useItemStore() destructuring remains');
  assert(/items:\s*tasks/.test(pageHook), 'consolidated destructuring keeps items alias');

  syncComponentCallSiteProps(tmp);
  const pageDialog = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(!/\bonConfirm=/.test(pageDialog), 'onConfirm stripped from delete dialog call site');
  assert(/\bonClose=\{\(confirmed\)/.test(pageDialog), 'onConfirm merged into onClose(confirmed)');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Item model completed → status alignment ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-task-model-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';\nexport interface Item { id: string; title: string; description: string; status: ItemStatus; }\nexport type ItemDraft = Omit<Item, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `import { Item, ItemDraft } from '../models/item.model';\nexport function add(draft: ItemDraft) {\n  const newItem: Item = { id: '1', ...draft, completed: false };\n  return newItem;\n}\n`
  );
  fixTaskModelFieldMismatches(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(!/\bcompleted\b/.test(page), 'completed field removed from Item literal');
  assert(/:\s*Item\s*=/.test(page), 'Item annotation preserved');

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
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';\nexport interface Item { id: string; title: string; description: string; status: ItemStatus; }\nexport type ItemDraft = Omit<Item, 'id'>;\n`
  );
  fs.writeFileSync(path.join(tmp, 'src', 'store', 'useItemStore.ts'), `export { useItemStore } from './itemStore';\n`);
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `import { useItemStore } from '../store/useItemStore';\nimport { Item, ItemDraft } from '../models/item.model';\nexport default function HostPage() {\n  const { tasks, addItem } = useItemStore();\n  const draft: ItemDraft = { title: 'a', description: 'b', status: 'in_progress' as any, priority: 'low' as any };\n  return null;\n}\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'ConfirmDialog.tsx'),
    `import { Item } from '../services/item.service';\nexport function ConfirmDialog({ item }: { item: Item | null }) { return null; }\n`
  );

  ensureZustandStoreScaffold(tmp);
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'itemStore.ts')), 'missing itemStore.ts scaffolded');
  const store = fs.readFileSync(path.join(tmp, 'src', 'store', 'itemStore.ts'), 'utf-8');
  assert(/export const useItemStore = create/.test(store), 'scaffold exports useItemStore');

  fixReactModuleImports(tmp);
  const dialog = fs.readFileSync(path.join(tmp, 'src', 'components', 'ConfirmDialog.tsx'), 'utf-8');
  assert(/models\/item\.model/.test(dialog), 'phantom item.service import fixed');
  assert(!/services\/item\.service/.test(dialog), 'phantom item.service path is gone');

  alignTaskStatusLiterals(tmp);
  const pageStatus = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(!/in_progress/.test(pageStatus), 'in_progress normalized to in-progress');

  fixTaskModelFieldMismatches(tmp);
  const pageFields = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(!/\bpriority\b/.test(pageFields), 'priority removed when not on Item model');

  fixZustandHookUsage(tmp);
  const pageHook = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(/items:\s*tasks/.test(pageHook), 'tasks destructuring aliased from items');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Hallucinated types/item import → models/item.model (TS2307) ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-types-task-'));
  fs.mkdirSync(path.join(tmp, 'src', 'components', 'confirm-dialog'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';\nexport interface Item { id: string; title: string; description: string; status: ItemStatus; }\nexport type ItemDraft = Omit<Item, 'id'>;\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'confirm-dialog', 'ConfirmDialog.tsx'),
    `import { Item } from '../../types/item';\nexport function ConfirmDialog({ item }: { item: Item | null }) { return null; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'components', 'confirm-dialog', 'ItemForm.tsx'),
    `import type { Item, ItemDraft } from '@/types/item';\nexport function ItemForm({ item }: { item: Item; draft: ItemDraft }) { return null; }\n`
  );

  fixReactModuleImports(tmp);
  const dialog = fs.readFileSync(
    path.join(tmp, 'src', 'components', 'confirm-dialog', 'ConfirmDialog.tsx'),
    'utf-8'
  );
  assert(/models\/item\.model/.test(dialog), 'types/item rewrite to models/item.model');
  assert(!/types\/item/.test(dialog), 'fabricated types/item import is gone');
  const form = fs.readFileSync(
    path.join(tmp, 'src', 'components', 'confirm-dialog', 'ItemForm.tsx'),
    'utf-8'
  );
  assert(/models\/item\.model/.test(form), '@/types/item rewrite to models/item.model');
  assert(!/types\/item/.test(form), 'fabricated @/types/item import is gone');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Pin source models + NGXS store; do not invent Item fields ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pin-source-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'store'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export interface Item { id: string; title: string; completed: boolean; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'store', 'useItemStore.ts'),
    `export { useItemStore } from './itemStore';\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `import { Item } from '../models/item.model';\nconst t: Item = { id: '1', title: 'a', status: 'in_progress' as any, priority: 'high' as any };\n`
  );
  const sourceFilesMap = {
    'src/app/models/item.model.ts':
      `export type ItemStatus = 'todo' | 'in-progress' | 'done';\nexport interface Item { id: string; title: string; description: string; status: ItemStatus; }\nexport type ItemDraft = Omit<Item, 'id'>;\n`,
    'src/app/store/item/item.state.ts':
      `import { Injectable } from '@angular/core';\nimport { Action, State, StateContext } from '@ngxs/store';\nimport { Item } from '../../models/item.model';\nexport interface ItemStateModel { items: Item[]; }\n@State<ItemStateModel>({ name: 'tasks', defaults: { items: [] } })\n@Injectable()\nexport class ItemState {\n  @Action(class AddItem {})\n  addItem(ctx: StateContext<ItemStateModel>, action: { payload: Item }) {\n    ctx.patchState({ items: [...ctx.getState().items, action.payload] });\n  }\n}\n`
  };
  pinSourceDomainArtifacts(tmp, sourceFilesMap);
  const model = fs.readFileSync(path.join(tmp, 'src', 'models', 'item.model.ts'), 'utf-8');
  assert(/status: ItemStatus/.test(model), 'source Item model overwrites AI model');
  assert(!/completed: boolean/.test(model), 'AI-invented completed field not kept on model');
  assert(fs.existsSync(path.join(tmp, 'src', 'store', 'itemStore.ts')), 'zustand store written from NGXS source');

  alignTaskStatusLiterals(tmp);
  fixTaskModelFieldMismatches(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(!/in_progress/.test(page), 'status literal aligned from pinned model');
  assert(!/\bpriority\b/.test(page), 'invented priority stripped using pinned model');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Unit bundle matching: kebab vs PascalCase, optional scss/html ---
{
  assert(
    normalizeReactPlanPath('src/components/confirm-dialog/ConfirmDialog.html') === null,
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
    normalizeReactPlanPath('src/app/components/confirm-dialog/confirm-dialog.component.ts') ===
      'src/components/confirm-dialog/ConfirmDialog.tsx',
    'Angular component.ts remaps to React PascalCase tsx under src/'
  );
  assert(
    normalizeReactPlanPath('src/components/item-editor/item-editor.component') ===
      'src/components/item-editor/ItemEditor.tsx',
    'bare .component unit id remaps to ItemEditor.tsx'
  );
  assert(
    normalizeReactPlanPath('src/app/components/item-editor/item-editor.component.scss') ===
      'src/components/item-editor/ItemEditor.scss',
    'Angular component.scss remaps to PascalCase scss'
  );

  const bundle = [
    { path: 'src/components/confirm-dialog.tsx', content: 'export function ConfirmDialog() { return null; }' }
  ];
  const match = matchUnitBundleFile(bundle, 'src/components/confirm-dialog/ConfirmDialog.tsx');
  assert(match && match.content.includes('ConfirmDialog'), 'kebab filename matches PascalCase plan path');
  assert(
    matchUnitBundleFile(bundle, 'src/components/confirm-dialog/ConfirmDialog.scss') === null,
    'scss is not matched from a tsx-only bundle'
  );
}

// --- Angular→React: leftover .component triad must not skip as incomplete ---
{
  const unitId = 'src/components/item-editor/item-editor.component';
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
    paths.includes('src/components/item-editor/ItemEditor.tsx'),
    'React grouping remaps .component.ts to ItemEditor.tsx'
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
    coerced.files.some((f) => f.newPath.endsWith('ItemEditor.tsx')),
    'coerce remaps a leftover Angular triad to ItemEditor.tsx'
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
    'src/app/components/item-editor/item-editor.component.ts': `
import { Component, EventEmitter, Input, Output } from '@angular/core';
@Component({ selector: 'app-item-editor', templateUrl: './item-editor.component.html' })
export class ItemEditorComponent {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();
}
`,
    'src/app/components/item-editor/item-editor.component.html':
      '<form><input name="title" /></form>'
  });
  assert(synthesized.length > 0, 'synthesizer builds ItemEditor from Angular source');
  assert(
    matchUnitBundleFile(synthesized, 'src/components/item-editor/ItemEditor.tsx'),
    'synthesized tsx matches the remapped React plan path'
  );
  assert(
    /export default function ItemEditor/.test(synthesized[0].content),
    'synthesized component is a React function named ItemEditor'
  );
}

// --- Broken App.tsx interface leftover + page shell ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-app-shell-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages', 'host-page'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'host-page', 'HostPage.tsx'),
    `export default function HostPage() { return <div>list</div>; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';\nexport interface Item { id: string; title: string; description: string; status: ItemStatus; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'App.tsx'),
    `interface Item {\n  id: string;\n  title: string;\n  description: string; | 'medium' | 'high';\n  dueDate?: string;\n}\nexport default function App() { return <div>invented</div>; }\n`
  );

  fixTaskModelFieldMismatches(tmp);
  const afterStrip = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(!/;\s*\|/.test(afterStrip), 'broken union leftover after Item field is removed');

  ensureReactAppShell(tmp);
  const app = fs.readFileSync(path.join(tmp, 'src', 'App.tsx'), 'utf-8');
  assert(/HostPage/.test(app), 'App.tsx mounts converted HostPage page');
  assert(/react-router-dom/.test(app), 'App.tsx uses react-router-dom');
  assert(!/invented/.test(app), 'hallucinated App UI is replaced');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Field strip must not leave `task.` (TS1003); fat App.tsx is replaced ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-app-ts1003-'));
  fs.mkdirSync(path.join(tmp, 'src', 'pages', 'host-page'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';\nexport interface Item { id: string; title: string; description: string; status: ItemStatus; }\n`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'host-page', 'HostPage.tsx'),
    `import { Item } from '../../models/item.model';\nexport default function HostPage({ item }: { item: Item }) {\n  return <span>{task.priority}</span>;\n}\n`
  );
  let fatApp = `import HostPage from './pages/host-page/HostPage';\nexport default function App() {\n  return (\n    <div>\n      <HostPage />\n      <span>{task.}</span>\n    </div>\n  );\n}\n`;
  while (fatApp.split('\n').length < 90) fatApp += '// padding HostPage\n';
  fs.writeFileSync(path.join(tmp, 'src', 'App.tsx'), fatApp);

  fixTaskModelFieldMismatches(tmp);
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'host-page', 'HostPage.tsx'), 'utf-8');
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

// --- Status label `done` is a real ItemStatus key, not an invented field ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-status-labels-'));
  fs.mkdirSync(path.join(tmp, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'src', 'models', 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';
export interface Item { id: string; title: string; description: string; status: ItemStatus; }
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done'
};
`
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'pages', 'HostPage.tsx'),
    `import { Item } from '../models/item.model';
const t: Item = { id: '1', title: 'a', description: '', status: 'todo', priority: 'high' };
`
  );
  fixTaskModelFieldMismatches(tmp);
  const model = fs.readFileSync(path.join(tmp, 'src', 'models', 'item.model.ts'), 'utf-8');
  assert(/done:\s*'Done'/.test(model), 'ITEM_STATUS_LABELS.done is not stripped as an invented field');
  const page = fs.readFileSync(path.join(tmp, 'src', 'pages', 'HostPage.tsx'), 'utf-8');
  assert(!/\bpriority\b/.test(page), 'invented priority still stripped from non-model files');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- NG1010: MatButtonModule / MatIconModule in imports[] without a value import ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng1010-material-'));
  const dir = path.join(tmp, 'src', 'app', 'pages', 'host-page');
  fs.mkdirSync(dir, { recursive: true });
  const brokenTs = `import { Component } from '@angular/core';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';

@Component({
  selector: 'app-host-page',
  standalone: true,
  imports: [MatSidenavModule, MatToolbarModule, MatButtonModule, MatIconModule],
  templateUrl: './host-page.component.html',
  styleUrl: './host-page.component.scss'
})
export class HostPageComponent {}
`;
  const brokenHtml = `<mat-sidenav-container>
  <mat-toolbar>
    <mat-icon>checklist</mat-icon>
    <button mat-flat-button type="button">Add task</button>
  </mat-toolbar>
</mat-sidenav-container>
`;
  fs.writeFileSync(path.join(dir, 'host-page.component.ts'), brokenTs);
  fs.writeFileSync(path.join(dir, 'host-page.component.html'), brokenHtml);
  fs.writeFileSync(path.join(dir, 'host-page.component.scss'), '/* */\n');

  repairAngularComponentFile(path.join(dir, 'host-page.component.ts'));
  const ts = fs.readFileSync(path.join(dir, 'host-page.component.ts'), 'utf-8');
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
  const dir2 = path.join(tmp2, 'src', 'app', 'pages', 'host-page');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'host-page.component.ts'), brokenTs);
  fs.writeFileSync(path.join(dir2, 'host-page.component.html'), brokenHtml);
  fs.writeFileSync(path.join(dir2, 'host-page.component.scss'), '/* */\n');
  const n = fixAngularCompileErrors(
    tmp2,
    `src/app/pages/host-page/host-page.component.ts:35:48: MatButtonModule Unknown reference. NG1010: 'imports' must be an array of components, directives, pipes, or NgModules. Value could not be determined statically. MatIconModule Unknown reference.`
  );
  assert(n >= 1, 'fixAngularCompileErrors reports a changed file');
  const ts2 = fs.readFileSync(path.join(dir2, 'host-page.component.ts'), 'utf-8');
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
  const tableDir = path.join(tmp, 'src', 'app', 'components', 'item-table');
  const formDir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  const hostDir = path.join(tmp, 'src', 'app', 'pages', 'host-page');
  fs.mkdirSync(tableDir, { recursive: true });
  fs.mkdirSync(formDir, { recursive: true });
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t","dependencies":{"@angular/core":"20.0.0"}}\n');

  fs.writeFileSync(
    path.join(tableDir, 'item-table.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
export interface Item { id: string; }
@Component({
  selector: 'app-item-table',
  standalone: true,
  templateUrl: './item-table.component.html'
})
export class ItemTableComponent {
  @Input() items: Item[] = [];
  @Output() remove = new EventEmitter<Item>();
  @Output() edit = new EventEmitter<Item>();
  onRemove(value: Item): void {
    this.remove.emit(value);
  }
  onEdit(value: Item): void {
    this.edit.emit(value);
  }
}
`
  );
  fs.writeFileSync(
    path.join(tableDir, 'item-table.component.html'),
    `<button type="button" class="hover:bg-gray-100 transition-colors" (click)="onRemove.emit(item)">Delete</button>
`
  );
  fs.writeFileSync(
    path.join(formDir, 'item-editor.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
export interface ItemDraft { title: string; }
export interface Item { id: string; }
@Component({
  selector: 'app-item-editor',
  standalone: true,
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent {
  @Input() item: Item | null = null;
  @Output() save = new EventEmitter<ItemDraft>();
  @Output() cancel = new EventEmitter<void>();
  onSave(value: ItemDraft): void {
    this.save.emit(value);
  }
}
`
  );
  fs.writeFileSync(path.join(formDir, 'item-editor.component.html'), `<form></form>\n`);
  fs.writeFileSync(
    path.join(hostDir, 'host-page.component.ts'),
    `import { Component } from '@angular/core';
import { Item, ItemDraft, ItemEditorComponent } from '../../components/item-editor/item-editor.component';
import { ItemTableComponent } from '../../components/item-table/item-table.component';
@Component({
  selector: 'app-host-page',
  standalone: true,
  imports: [ItemEditorComponent, ItemTableComponent],
  templateUrl: './host-page.component.html'
})
export class HostPageComponent {
  editingItem: Item | null = null;
  onSave(draft: ItemDraft): void {}
}
`
  );
  fs.writeFileSync(
    path.join(hostDir, 'host-page.component.html'),
    `<app-item-editor [item]="editingItem" (onSave)="onSave($event)"></app-item-editor>
<app-item-table [items]="[]" (onRemove)="deletingItem = $event"></app-item-table>
`
  );

  repairAngularWorkspace(tmp, { sourceFilesMap: {}, sourcePackageJson: { dependencies: { react: '^19' } } });

  const tableHtml = fs.readFileSync(path.join(tableDir, 'item-table.component.html'), 'utf-8');
  const tableTs = fs.readFileSync(path.join(tableDir, 'item-table.component.ts'), 'utf-8');
  const hostHtml = fs.readFileSync(path.join(hostDir, 'host-page.component.html'), 'utf-8');
  assert(
    /\(click\)="onRemove\(item\)"/.test(tableHtml),
    'onRemove.emit(item) rewrites to method call when onRemove is a wrapper'
  );
  assert(!/onRemove\.emit/.test(tableHtml), 'item-table template does not keep onRemove.emit');
  assert(
    !/@Output\(\)\s+onRemove/.test(tableTs),
    'does not add a colliding @Output() onRemove next to @Output() remove'
  );
  assert(/\(save\)="onSave\(\$event\)"/.test(hostHtml), 'parent (onSave) remaps to child @Output() save');
  assert(!/\(onSave\)=/.test(hostHtml), 'parent no longer binds unknown (onSave) DOM event');
  assert(/\(remove\)=/.test(hostHtml), 'parent (onRemove) remaps to child @Output() remove');

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-emit-fix-'));
  const t2 = path.join(tmp2, 'src', 'app', 'components', 'item-table');
  const l2 = path.join(tmp2, 'src', 'app', 'pages', 'host-page');
  fs.mkdirSync(t2, { recursive: true });
  fs.mkdirSync(l2, { recursive: true });
  fs.writeFileSync(
    path.join(t2, 'item-table.component.ts'),
    `import { Component, EventEmitter, Output } from '@angular/core';
export interface Item { id: string; }
@Component({ selector: 'app-item-table', standalone: true, templateUrl: './item-table.component.html' })
export class ItemTableComponent {
  @Output() remove = new EventEmitter<Item>();
  onRemove(value: Item): void { this.remove.emit(value); }
}
`
  );
  fs.writeFileSync(
    path.join(t2, 'item-table.component.html'),
    `<button (click)="onRemove.emit(item)">x</button>\n`
  );
  fs.writeFileSync(
    path.join(l2, 'host-page.component.ts'),
    `import { Component } from '@angular/core';
export interface ItemDraft { title: string; }
@Component({ selector: 'app-host-page', standalone: true, templateUrl: './host-page.component.html' })
export class HostPageComponent {
  onSave(draft: ItemDraft): void {}
}
`
  );
  fs.writeFileSync(
    path.join(l2, 'host-page.component.html'),
    `<app-item-editor (onSave)="onSave($event)"></app-item-editor>\n`
  );
  fs.mkdirSync(path.join(tmp2, 'src', 'app', 'components', 'item-editor'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp2, 'src', 'app', 'components', 'item-editor', 'item-editor.component.ts'),
    `import { Component, EventEmitter, Output } from '@angular/core';
export interface ItemDraft { title: string; }
@Component({ selector: 'app-item-editor', standalone: true, templateUrl: './item-editor.component.html' })
export class ItemEditorComponent {
  @Output() save = new EventEmitter<ItemDraft>();
}
`
  );
  fs.writeFileSync(
    path.join(tmp2, 'src', 'app', 'components', 'item-editor', 'item-editor.component.html'),
    `<form></form>\n`
  );

  const errText = `
Error: src/app/components/item-table/item-table.component.html:37:173: Property 'emit' does not exist
  37 │ ...over:bg-gray-100 transition-colors" (click)="onRemove.emit(item)">
Error occurs in the template of component ItemTableComponent.
src/app/components/item-table/item-table.component.ts:9:15: templateUrl: './item-table.component.html'
TS2345: Argument of type 'Event' is not assignable to parameter of type 'ItemDraft'.
src/app/pages/host-page/host-page.component.html:47:25: (onSave)="onSave($event)"
Error occurs in the template of component HostPageComponent.
`;
  const n = fixAngularCompileErrors(tmp2, errText);
  assert(n >= 1, 'fixAngularCompileErrors repairs emit/$event template errors');
  const tableHtml2 = fs.readFileSync(path.join(t2, 'item-table.component.html'), 'utf-8');
  const hostHtml2 = fs.readFileSync(path.join(l2, 'host-page.component.html'), 'utf-8');
  assert(/onRemove\(item\)/.test(tableHtml2), 'compile fixer strips method.emit');
  assert(/\(save\)="onSave\(\$event\)"/.test(hostHtml2), 'compile fixer remaps (onSave) to (save)');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
}

{
  // Fixture names are arbitrary — the fixer matches @Output() vs parent (save)/(onSave)
  // on any component pair, not a specific sample app.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-save-onSave-'));
  const hostDir = path.join(tmp, 'src', 'app', 'pages', 'host-page');
  const childDir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(
    path.join(childDir, 'item-editor.component.ts'),
    `import { Component, EventEmitter, Output } from '@angular/core';
export interface ItemDraft { title: string; }
@Component({ selector: 'app-item-editor', standalone: true, templateUrl: './item-editor.component.html' })
export class ItemEditorComponent {
  @Output() onSave = new EventEmitter<ItemDraft>();
  @Output() onCancel = new EventEmitter<void>();
}
`
  );
  fs.writeFileSync(path.join(childDir, 'item-editor.component.html'), `<form></form>\n`);
  fs.writeFileSync(
    path.join(hostDir, 'host-page.component.ts'),
    `import { Component } from '@angular/core';
import { ItemDraft, ItemEditorComponent } from '../../components/item-editor/item-editor.component';
@Component({
  selector: 'app-host-page',
  standalone: true,
  imports: [ItemEditorComponent],
  templateUrl: './host-page.component.html'
})
export class HostPageComponent {
  onSave(draft: ItemDraft): void {}
  closeEditor(): void {}
}
`
  );
  fs.writeFileSync(
    path.join(hostDir, 'host-page.component.html'),
    `<app-item-editor (save)="onSave($event)" (cancel)="closeEditor()"></app-item-editor>\n`
  );

  const n = fixAngularCompileErrors(
    tmp,
    `TS2345: Argument of type 'Event' is not assignable to parameter of type 'ItemDraft'.
src/app/pages/host-page/host-page.component.html:2:25: (save)="onSave($event)"
Error occurs in the template of component HostPageComponent.
src/app/pages/host-page/host-page.component.ts:8:15: templateUrl: './host-page.component.html'
`
  );
  assert(n >= 1, 'fixAngularCompileErrors remaps (save) to child @Output() onSave');
  const html = fs.readFileSync(path.join(hostDir, 'host-page.component.html'), 'utf-8');
  assert(/\(onSave\)="onSave\(\$event\)"/.test(html), 'parent (save) remaps to (onSave)');
  assert(/\(onCancel\)="closeEditor\(\)"/.test(html), 'parent (cancel) remaps to (onCancel)');
  assert(!/\(save\)=/.test(html), 'native (save) host binding is gone');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const broken = `
<td class="actions">
  <button mat-icon-button type="button" aria-label="Edit task" (click)="onEdit(task)" />
    <mat-icon>edit</mat-icon>
  </button>
  <button mat-icon-button type="button" aria-label="Delete task" (click)="onRemove(task)" />
    <mat-icon>delete</mat-icon>
  </button>
</td>
`;
  const fixed = repairSelfClosingNonVoidTags(broken);
  assert(!/<button\b[^>]*\/>/.test(fixed), 'false self-closing buttons lose />');
  assert(
    (fixed.match(/<button\b/g) || []).length === (fixed.match(/<\/button>/g) || []).length,
    'repaired buttons are balanced'
  );
  assert(/<button[^>]*>\s*<mat-icon>delete<\/mat-icon>\s*<\/button>/s.test(fixed), 'Delete icon stays inside the button');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng5002-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-table');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-table.component.ts'),
    `import { Component } from '@angular/core';
@Component({ selector: 'app-item-table', standalone: true, templateUrl: './item-table.component.html' })
export class ItemTableComponent {}
`
  );
  fs.writeFileSync(path.join(dir, 'item-table.component.html'), broken);
  const n = fixAngularCompileErrors(
    tmp,
    `NG5002: Unexpected closing tag "button".
src/app/components/item-table/item-table.component.html:35:16: </button>
Error occurs in the template of component ItemTableComponent.
src/app/components/item-table/item-table.component.ts:10:15: templateUrl: './item-table.component.html'
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs NG5002 self-closed buttons');
  const html = fs.readFileSync(path.join(dir, 'item-table.component.html'), 'utf-8');
  assert(!/<button\b[^>]*\/>/.test(html), 'NG5002 repair expands self-closed buttons');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const broken = `
<td class="actions">
  <button mat-icon-button type="button" aria-label="Edit" (click)="onEdit(task)"">
    <mat-icon>edit</mat-icon>
  </button>
  <button mat-icon-button type="button" aria-label="Delete" (click)="onRemove(task)"">
    <mat-icon>delete</mat-icon>
  </button>
</td>
</div>)}
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng5002-quotes-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-table');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-table.component.ts'),
    `import { Component } from '@angular/core';
@Component({ selector: 'app-item-table', standalone: true, templateUrl: './item-table.component.html' })
export class ItemTableComponent {}
`
  );
  fs.writeFileSync(path.join(dir, 'item-table.component.html'), broken);
  const n = fixAngularCompileErrors(
    tmp,
    `NG5002: Unexpected closing tag "button".
src/app/components/item-table/item-table.component.html:5:2: </button>
Error occurs in the template of component ItemTableComponent.
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs doubled click quotes (NG5002)');
  const html = fs.readFileSync(path.join(dir, 'item-table.component.html'), 'utf-8');
  assert(!/\)""/.test(html), 'doubled attribute quotes are removed');
  assert(/\(click\)="onEdit\(task\)"/.test(html), 'onEdit binding is valid');
  assert(!/\)\}/.test(html), 'leftover JSX )} closer is removed');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const broken = `<mat-sidenav-container class="layout">
<div class="layout">
      <mat-sidenav position="end" mode="over" [opened]="sidebarOpen">
        <app-item-editor></app-item-editor>
      </mat-sidenav>
<mat-sidenav-content>
      <mat-toolbar></mat-toolbar>
      <main class="content"></main>
    </div>
</mat-sidenav-content>
</mat-sidenav-container>
`;
  const fixed = repairMismatchedHtmlClosingTags(broken);
  assert(
    !/<\/div>\s*<\/mat-sidenav-content>/s.test(fixed),
    'layout </div> is not left inside mat-sidenav-content'
  );
  assert(
    /<mat-sidenav-container[\s\S]*<mat-sidenav\b[\s\S]*<\/mat-sidenav>\s*<mat-sidenav-content>[\s\S]*<\/mat-sidenav-content>\s*<\/mat-sidenav-container>/s.test(
      fixed
    ),
    'sidenav tags are direct children of the container'
  );
  const opensDiv = (fixed.match(/<div\b/g) || []).length;
  const closesDiv = (fixed.match(/<\/div>/g) || []).length;
  assert(opensDiv === closesDiv, 'div open/close tags are balanced after sidenav repair');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng5002-sidenav-'));
  const dir = path.join(tmp, 'src', 'app', 'pages', 'item-list');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-list.component.ts'),
    `import { Component } from '@angular/core';
@Component({ selector: 'app-item-list', standalone: true, templateUrl: './item-list.component.html' })
export class ItemListComponent {}
`
  );
  fs.writeFileSync(path.join(dir, 'item-list.component.html'), broken);
  const n = fixAngularCompileErrors(
    tmp,
    `NG5002: Unexpected closing tag "div". It may happen when the tag has already been closed by another tag.
src/app/pages/item-list/item-list.component.html:31:4: </div>
Error occurs in the template of component ItemListComponent.
src/app/pages/item-list/item-list.component.ts:36:15: templateUrl: './item-list.component.html'
NG5002: Unexpected closing tag "mat-sidenav-content".
src/app/pages/item-list/item-list.component.html:32:0: </mat-sidenav-content>
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs NG5002 sidenav layout closes');
  const html = fs.readFileSync(path.join(dir, 'item-list.component.html'), 'utf-8');
  assert(/<mat-sidenav-content>/.test(html), 'mat-sidenav-content remains');
  assert(!/<\/div>\s*<\/mat-sidenav-content>/s.test(html), 'compile repair moves the stray layout close');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const voidHtml = `<mat-form-field appearance="outline"><mat-label>Title</mat-label><input matInput [value]="title"></input></mat-form-field>`;
  const fixedVoid = repairSelfClosingNonVoidTags(voidHtml);
  assert(!/<\/input>/.test(fixedVoid), 'void input end tags are stripped');
  assert(/<input\b/.test(fixedVoid), 'input open tag remains');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ts2300-'));
  const dialogDir = path.join(tmp, 'src', 'app', 'components', 'confirm-dialog');
  const formDir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(dialogDir, { recursive: true });
  fs.mkdirSync(formDir, { recursive: true });
  fs.writeFileSync(
    path.join(dialogDir, 'confirm-dialog.component.ts'),
    `import { Component, EventEmitter, Input, Output } from '@angular/core';
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  templateUrl: './confirm-dialog.component.html'
})
export class ConfirmDialogComponent {
  @Input() open = false;
  @Output() onClose = new EventEmitter<boolean>();
  onClose(value: boolean): void {
    this.onClose.emit(value);
  }
}
`
  );
  fs.writeFileSync(
    path.join(dialogDir, 'confirm-dialog.component.html'),
    `<button type="button" (click)="onClose(false)">Cancel</button>\n`
  );
  fs.writeFileSync(
    path.join(formDir, 'item-editor.component.ts'),
    `import { Component } from '@angular/core';
@Component({
  selector: 'app-item-editor',
  standalone: true,
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent {}
`
  );
  fs.writeFileSync(
    path.join(formDir, 'item-editor.component.html'),
    `<mat-form-field appearance="outline"><mat-label>Title</mat-label><input matInput [value]="title"></input></mat-form-field>\n`
  );

  const n = fixAngularCompileErrors(
    tmp,
    `TS2300: Duplicate identifier 'onClose'.
[plugin angular-compiler] src/app/components/confirm-dialog/confirm-dialog.component.ts:37:0: onClose(value: boolean): void {
NG5002: Void elements do not have end tags "input"
[plugin angular-compiler] src/app/components/item-editor/item-editor.component.html:13:9: ></input></mat-form-field>
Error occurs in the template of component ItemEditorComponent.
src/app/components/item-editor/item-editor.component.ts:21:15: templateUrl: './item-editor.component.html'
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs TS2300 onClose and NG5002 </input>');
  const dialogTs = fs.readFileSync(path.join(dialogDir, 'confirm-dialog.component.ts'), 'utf-8');
  const dialogHtml = fs.readFileSync(path.join(dialogDir, 'confirm-dialog.component.html'), 'utf-8');
  const formHtml = fs.readFileSync(path.join(formDir, 'item-editor.component.html'), 'utf-8');
  assert(/@Output\(\)\s+onClose/.test(dialogTs), 'onClose Output is kept');
  assert(!/^\s*onClose\s*\(/m.test(dialogTs), 'duplicate onClose method is removed');
  assert(/onClose\.emit\(false\)/.test(dialogHtml), 'template calls onClose.emit after method drop');
  assert(!/<\/input>/.test(formHtml), 'compile repair strips </input>');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-form-stubs-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.ts'),
    `import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
export interface Item { title: string; description: string; status: string; }
export type ItemDraft = Omit<Item, never>;
@Component({
  selector: 'app-item-editor',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent implements OnChanges {
  handleCancel(..._args: any[]) { return _args[0] ?? null; }
  handleSubmit(..._args: any[]) { return _args[0] ?? null; }
  onTitleInput(..._args: any[]) { return _args[0] ?? null; }
  onTitleBlur(..._args: any[]) { return _args[0] ?? null; }
  onDescriptionInput(..._args: any[]) { return _args[0] ?? null; }
  onStatusChange(..._args: any[]) { return _args[0] ?? null; }
  titleError: any = null;
  @Input() item: Item | null = null;
  @Output() save = new EventEmitter<ItemDraft>();
  @Output() cancel = new EventEmitter<unknown>();
  title: string = '';
  description: string = '';
  status: string = 'todo';
  titleTouched: boolean = false;
  ngOnChanges(changes: SimpleChanges): void {}
  onSubmit(event: Event): void {
    event.preventDefault();
    this.save.emit({ title: this.title.trim(), description: this.description, status: this.status });
  }
  onCancel(): void {
    this.cancel.emit();
  }
}
`
  );
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.html'),
    `<div class="editor">
  <button type="button" (click)="handleCancel()">Close</button>
  <form (submit)="handleSubmit($event)" (ngSubmit)="onSubmit($event)">
    <input [value]="title" (input)="onTitleInput($event)" (blur)="onTitleBlur()" />
    <textarea [value]="description" (input)="onDescriptionInput($event)"></textarea>
    <select [value]="status" (change)="onStatusChange($event)"></select>
    @if (titleError) { <span>Title is required</span> }
    <button type="button" (click)="handleCancel()">Cancel</button>
    <button type="submit">Save</button>
  </form>
</div>
`
  );

  repairAngularComponentFile(path.join(dir, 'item-editor.component.ts'), {});
  const ts = fs.readFileSync(path.join(dir, 'item-editor.component.ts'), 'utf-8');
  const html = fs.readFileSync(path.join(dir, 'item-editor.component.html'), 'utf-8');
  assert(/\(click\)="onCancel\(\)"/.test(html), 'handleCancel is retargeted to onCancel');
  assert(!/handleCancel\(/.test(html), 'stub handleCancel is gone from template');
  assert(/\[formGroup\]="form"/.test(html), 'form uses reactive [formGroup]');
  assert(/formControlName="title"/.test(html), 'title input uses formControlName');
  assert(/formControlName="description"/.test(html), 'description uses formControlName');
  assert(/formControlName="status"/.test(html), 'status select uses formControlName');
  assert(!/\[\(ngModel\)\]/.test(html), 'ngModel is not used');
  assert(/titleTouched|markAsTouched/.test(html), 'blur marks title touched');
  assert(!/\(submit\)=/.test(html), 'native submit is dropped when ngSubmit exists');
  assert(/get titleError\(\)/.test(ts), 'titleError becomes a getter from form control');
  assert(/ReactiveFormsModule/.test(ts), 'ReactiveFormsModule is imported');
  assert(/readonly form\s*=/.test(ts) || /form\s*=\s*this\.fb/.test(ts), 'FormGroup is declared');
  assert(!/handleCancel\(\.\.\._args/.test(ts), 'unused handleCancel stub is removed');
  assert(!/onTitleInput\(\.\.\._args/.test(ts), 'unused onTitleInput stub is removed');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-strict-null-status-'));
  const pageDir = path.join(tmp, 'src', 'app', 'pages', 'item-list');
  const modelDir = path.join(tmp, 'src', 'app', 'models');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(
    path.join(modelDir, 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'in-progress' | 'done';
export interface Item { id: string; title: string; description: string; status: ItemStatus; }
export type ItemDraft = Omit<Item, 'id'>;
`
  );
  fs.writeFileSync(
    path.join(pageDir, 'item-list.component.ts'),
    `import { Component } from '@angular/core';
import { Item, ItemDraft } from '../../models/item.model';

const INITIAL_ITEMS = [
  { id: '1', title: 'A', description: '', status: 'done' },
  { id: '2', title: 'B', description: '', status: 'todo' }
];

@Component({
  selector: 'app-item-list',
  standalone: true,
  templateUrl: './item-list.component.html'
})
export class ItemListComponent {
  items: Item[] = [...INITIAL_ITEMS];
  editingItem: Item | null = null;

  onSave(draft: ItemDraft): void {
    if (this.editingItem) {
      this.items = this.items.map((item) =>
        item.id === this.editingItem.id ? { ...item, ...draft } : item
      );
    } else {
      this.items = [...this.items, { ...draft, id: crypto.randomUUID() }];
    }
  }
}
`
  );
  fs.writeFileSync(path.join(pageDir, 'item-list.component.html'), `<div></div>\n`);

  const errText = `TS2322: Type '{ id: string; title: string; description: string; status: string; }[]' is not assignable to type 'Item[]'.
Type '{ id: string; title: string; description: string; status: string; }' is not assignable to type 'Item'.
Types of property 'status' are incompatible. Type 'string' is not assignable to type 'ItemStatus'.
[plugin angular-compiler] src/app/pages/item-list/item-list.component.ts:18:2:
  items: Item[] = [...INITIAL_ITEMS];
TS2531: Object is possibly 'null'.
[plugin angular-compiler] src/app/pages/item-list/item-list.component.ts:24:20:
  item.id === this.editingItem.id ? { ...item, ...draft } : item
`;
  const n = fixAngularCompileErrors(tmp, errText);
  assert(n >= 1, 'fixAngularCompileErrors repairs TS2322/TS2531 status and null issues');
  const ts = fs.readFileSync(path.join(pageDir, 'item-list.component.ts'), 'utf-8');
  assert(/const INITIAL_ITEMS:\s*Item\[\]\s*=/.test(ts), 'INITIAL_ITEMS is annotated as Item[]');
  assert(
    /const currentEditingItem\s*=\s*this\.editingItem/.test(ts),
    'nullable this.editingItem is captured locally'
  );
  assert(
    /item\.id === currentEditingItem\.id/.test(ts),
    'map callback uses narrowed local instead of this.editingItem'
  );
  assert(!/this\.editingItem\.id/.test(ts), 'this.editingItem.id is gone from nested callback');

  const n2 = repairAngularStrictNullAndStatusTypes(tmp, errText);
  assert(n2 === 0, 'strict-null/status repair is idempotent');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-reactive-bogus-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.ts'),
    `import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { FormBuilder, Reactive, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { Item, ItemDraft } from '../../models/item.model';

@Component({
  selector: 'app-item-editor',
  standalone: true,
  imports: [MatInputModule, Reactive, ReactiveFormsModule, FormsModule],
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent implements OnChanges {
  @Input() item: Item | null = null;
  @Output() save = new EventEmitter<ItemDraft>();
  @Output() cancel = new EventEmitter<unknown>();
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({ title: [''], description: [''], status: ['todo'] });
  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['item']) return;
    if (this.item) this.form.patchValue(this.item);
    else this.form.reset({ title: '', description: '', status: 'todo' });
  }
}
`
  );
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.html'),
    `<form [formGroup]="form" (ngSubmit)="save.emit(form.getRawValue())">
  <input matInput formControlName="title" />
  <button type="submit">Save</button>
</form>
`
  );

  const n = fixAngularCompileErrors(
    tmp,
    `TS2305: Module '"@angular/forms"' has no exported member 'Reactive'.
[plugin angular-compiler] src/app/components/item-editor/item-editor.component.ts:2:22:
  import { FormBuilder, Reactive, ReactiveFormsModule, FormsModule } from '@angular/forms';
NG1010: 'imports' must be an array of components, directives, pipes, or NgModules. Value could not be determined statically.
[plugin angular-compiler] src/app/components/item-editor/item-editor.component.ts:10:30:
  imports: [MatInputModule, Reactive, ReactiveFormsModule, FormsModule],
Unknown reference.
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs bogus Reactive import');
  const ts = fs.readFileSync(path.join(dir, 'item-editor.component.ts'), 'utf-8');
  assert(!/\bReactive\b/.test(ts.replace(/ReactiveFormsModule/g, '')), 'bare Reactive symbol is removed');
  assert(/ReactiveFormsModule/.test(ts), 'ReactiveFormsModule remains');
  assert(!/imports:\s*\[[^\]]*Reactive\s*,/.test(ts), 'bare Reactive is gone from decorator imports');

  // Regression: upgrading to reactive forms must not mangle ReactiveFormsModule → Reactive
  repairAngularComponentFile(path.join(dir, 'item-editor.component.ts'), {});
  const ts2 = fs.readFileSync(path.join(dir, 'item-editor.component.ts'), 'utf-8');
  assert(/ReactiveFormsModule/.test(ts2), 'repair keeps ReactiveFormsModule intact');
  assert(!/\bReactive\b/.test(ts2.replace(/ReactiveFormsModule/g, '')), 'repair does not reintroduce bare Reactive');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ts2554-arity-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.ts'),
    `import { Component } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
@Component({
  selector: 'app-item-editor',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent {
  protected onSubmit(): void {}
  onSave(value: unknown): void {}
}
`
  );
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.html'),
    `<form [formGroup]="form" (ngSubmit)="onSubmit($event)">
  <button type="button" (click)="onSave($event)">Save</button>
</form>
`
  );
  const n = fixAngularCompileErrors(
    tmp,
    `TS2554: Expected 0 arguments, but got 1.
[plugin angular-compiler] src/app/components/item-editor/item-editor.component.html:8:55:
  (ngSubmit)="onSubmit($event)"
Error occurs in the template of component ItemEditorComponent.
src/app/components/item-editor/item-editor.component.ts:15:15:
  templateUrl: './item-editor.component.html'
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs TS2554 extra $event');
  const html = fs.readFileSync(path.join(dir, 'item-editor.component.html'), 'utf-8');
  assert(/\(ngSubmit\)="onSubmit\(\)"/.test(html), 'zero-arg onSubmit drops $event');
  assert(/\(click\)="onSave\(\$event\)"/.test(html), 'one-arg onSave keeps $event');
  const n2 = repairZeroArgTemplateCalls(tmp, '');
  assert(n2 === 0, 'zero-arg template repair is idempotent');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng21-pkgs-'));
  injectAngularWorkspaceTemplates(tmp, {
    major: 21,
    core: '21.2.18',
    tooling: '21.2.12',
    typescript: '~5.9.2',
    zone: '~0.15.0'
  }, { projectName: 'host-app' });
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(pkg.dependencies['@angular/core'] === '21.2.18', 'Angular 21 core is pinned');
  assert(
    !pkg.dependencies['@angular/platform-browser-dynamic'],
    'Angular 21 workspace omits deprecated platform-browser-dynamic'
  );
  assert(
    pkg.dependencies['@angular/animations'] === '21.2.18',
    'Angular 21 still includes @angular/animations for provideAnimationsAsync'
  );
  assert(pkg.dependencies['@angular/platform-browser'] === '21.2.18', 'platform-browser remains');

  pkg.dependencies['@angular/platform-browser-dynamic'] = '21.2.18';
  pkg.dependencies['@angular/animations'] = '21.2.18';
  fs.writeFileSync(path.join(tmp, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  enforceAngularPackageVersions(tmp, {
    major: 21,
    core: '21.2.18',
    tooling: '21.2.12',
    typescript: '~5.9.2',
    zone: '~0.15.0'
  });
  const pkg2 = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(
    !pkg2.dependencies['@angular/platform-browser-dynamic'],
    'enforce strips platform-browser-dynamic on Angular 21'
  );
  assert(
    pkg2.dependencies['@angular/animations'] === '21.2.18',
    'enforce keeps @angular/animations on Angular 21'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng20-anims-'));
  injectAngularWorkspaceTemplates(tmp, {
    major: 20,
    core: '20.3.9',
    tooling: '20.3.16',
    typescript: '~5.9.2',
    zone: '~0.15.0'
  }, { projectName: 'host-app' });
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  assert(
    pkg.dependencies['@angular/animations'] === '20.3.9',
    'Angular 20 still lists @angular/animations'
  );
  assert(
    !pkg.dependencies['@angular/platform-browser-dynamic'],
    'standalone workspaces omit platform-browser-dynamic even on Angular 20'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const numbered = splitReworkItems(`1. Fix the form submit handler
2. Wire the delete dialog close event
3. Type the seed list as Item[]`);
  assert(numbered.length === 3, 'numbered rework prompt splits into 3 items');
  assert(/form submit/.test(numbered[0]), 'first numbered item is kept');
  assert(/delete dialog/.test(numbered[1]), 'second numbered item is kept');
  assert(/seed list/.test(numbered[2]), 'third numbered item is kept');

  const bullets = splitReworkItems(`- Fix title validation
- Reset the sidebar on close`);
  assert(bullets.length === 2, 'bulleted rework prompt splits into 2 items');

  const single = splitReworkItems('TS2554: Expected 0 arguments, but got 1 in onSubmit($event).');
  assert(single.length === 1, 'a single error paste is not split');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ng-models-layout-'));
  const reactModels = path.join(tmp, 'src', 'models');
  const appDir = path.join(tmp, 'src', 'app', 'components', 'item-table');
  fs.mkdirSync(reactModels, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(reactModels, 'item.model.ts'),
    `export type ItemStatus = 'todo' | 'done';\nexport interface Item { id: string; title: string; status: ItemStatus; }\n`
  );
  fs.writeFileSync(
    path.join(appDir, 'item-table.component.ts'),
    `import { Component } from '@angular/core';\nimport { Item } from '../../models/item.model';\n@Component({ selector: 'app-item-table', standalone: true, template: '' })\nexport class ItemTableComponent { items: Item[] = []; }\n`
  );

  const n = fixAngularCompileErrors(
    tmp,
    `Could not resolve "../../models/item.model"
src/app/components/item-table/item-table.component.ts:2:41:
TS2307: Cannot find module '../../models/item.model' or its corresponding type declarations.`
  );
  assert(n >= 1, 'fixAngularCompileErrors moves models into src/app/models');
  assert(
    fs.existsSync(path.join(tmp, 'src', 'app', 'models', 'item.model.ts')),
    'model file is under src/app/models'
  );
  assert(
    !fs.existsSync(path.join(tmp, 'src', 'models', 'item.model.ts')),
    'React-shaped src/models copy is removed'
  );
  const n2 = ensureAngularAppModels(tmp);
  assert(n2 === 0, 'ensureAngularAppModels is idempotent');
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-dup-resetform-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.ts'),
    `import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Item, ItemDraft } from '../../models/item.model';

@Component({
  selector: 'app-item-editor',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent implements OnChanges {
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    title: [''],
    description: [''],
    status: ['']
  });
  resetForm(): void {
    this.form.reset({ title: '', description: '', status: '' });
  }

  private readonly fb = inject(FormBuilder);

  @Input() item: Item | null = null;
  @Output() save = new EventEmitter<ItemDraft>();
  @Output() cancel = new EventEmitter<void>();

  taskForm: FormGroup;

  constructor() {
    this.taskForm = this.fb.group({
      title: ['', Validators.required],
      description: [''],
      status: ['todo']
    });
  }

  resetForm(): void {
    this.taskForm.reset({ title: '', description: '', status: 'todo' });
  }

  onSubmit(): void {
    this.save.emit(this.taskForm.value as ItemDraft);
  }
}
`
  );
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.html'),
    `<form [formGroup]="form" (ngSubmit)="onSubmit()">
  <input formControlName="title" />
</form>
`
  );

  const n = fixAngularCompileErrors(
    tmp,
    `TS2393: Duplicate function implementation.
src/app/components/item-editor/item-editor.component.ts:26:2: resetForm(): void {
The original member "resetForm" is here:
src/app/components/item-editor/item-editor.component.ts:41:4: resetForm(): void {
TS2300: Duplicate identifier 'fb'.
src/app/components/item-editor/item-editor.component.ts:35:19: private readonly fb = inject(FormBuilder);
`
  );
  assert(n >= 1, 'fixAngularCompileErrors repairs duplicate resetForm/fb');
  const ts = fs.readFileSync(path.join(dir, 'item-editor.component.ts'), 'utf-8');
  assert(
    (ts.match(/\bresetForm\s*\(/g) || []).length === 1,
    'only one resetForm method remains'
  );
  assert(
    (ts.match(/\bfb\s*=\s*inject\(\s*FormBuilder\s*\)/g) || []).length === 1,
    'only one FormBuilder inject remains'
  );
  assert(!/\btaskForm\b/.test(ts) || /\bform\b/.test(ts), 'form group is consolidated');
  const n2 = dedupeDuplicateClassMembers(ts);
  assert(
    (n2.match(/\bresetForm\s*\(/g) || []).length === 1,
    'dedupeDuplicateClassMembers is stable on cleaned source'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  // Existing taskForm must not get a second fb/form/resetForm injected
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-keep-taskform-'));
  const dir = path.join(tmp, 'src', 'app', 'components', 'item-editor');
  fs.mkdirSync(dir, { recursive: true });
  const original = `import { Component, inject } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
@Component({
  selector: 'app-item-editor',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './item-editor.component.html'
})
export class ItemEditorComponent {
  private readonly fb = inject(FormBuilder);
  taskForm: FormGroup = this.fb.group({ title: [''], status: ['todo'] });
  resetForm(): void { this.taskForm.reset({ title: '', status: 'todo' }); }
  onSubmit(): void {}
}
`;
  fs.writeFileSync(path.join(dir, 'item-editor.component.ts'), original);
  fs.writeFileSync(
    path.join(dir, 'item-editor.component.html'),
    `<form [formGroup]="taskForm" (ngSubmit)="onSubmit()">
  <input formControlName="title" />
  <select formControlName="status"></select>
</form>
`
  );
  repairAngularComponentFile(path.join(dir, 'item-editor.component.ts'), {});
  const ts = fs.readFileSync(path.join(dir, 'item-editor.component.ts'), 'utf-8');
  const html = fs.readFileSync(path.join(dir, 'item-editor.component.html'), 'utf-8');
  assert(
    (ts.match(/\bfb\s*=\s*inject\(\s*FormBuilder\s*\)/g) || []).length === 1,
    'existing taskForm does not get a second fb'
  );
  assert(
    (ts.match(/\bresetForm\s*\(/g) || []).length === 1,
    'existing resetForm is not duplicated'
  );
  assert(/\[formGroup\]="taskForm"/.test(html), 'template keeps taskForm binding');
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\nSome postprocess tests failed.');
} else {
  console.log('\nAll postprocess tests passed.');
}
