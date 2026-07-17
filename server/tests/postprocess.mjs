import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  repairAngularWorkspace,
  repairReactWorkspace,
  repairAngularComponentFile,
  stripCssLeakedIntoTs,
  componentClassNameFromFile
} from '../src/services/postprocess.js';
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
    fs.existsSync(path.join(tmp, 'accordion-trigger.component.html')),
    'creates missing referenced template file'
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
        'lucide-react': '^0.468.0'
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
  assert(pkg.dependencies['@lucide/angular'], 'lucide-react mapped to @lucide/angular');
  assert(!pkg.dependencies['lucide-angular'], 'legacy lucide-angular must not be added');
  assert(pkg.dependencies['tailwind-merge'], 'tailwind-merge merged');

  assert(fs.existsSync(path.join(tmp, 'src', 'lib', 'utils.ts')), 'source lib/utils.ts copied');

  const avatarCss = fs.readFileSync(path.join(srcApp, 'avatar.component.css'), 'utf-8');
  assert(avatarCss.trim().length > 0, 'empty CSS repaired to non-empty comment');

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

if (process.exitCode) {
  console.error('\nSome postprocess tests failed.');
} else {
  console.log('\nAll postprocess tests passed.');
}
