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
  collectMissingSourcePages
} from '../src/services/postprocess.js';
import { rewriteHtmlLucideToInlineSvg } from '../src/services/lucideInlineSvg.js';
import {
  sanitizeAngularComponentTs,
  sanitizeCssContent
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

if (process.exitCode) {
  console.error('\nSome postprocess tests failed.');
} else {
  console.log('\nAll postprocess tests passed.');
}
