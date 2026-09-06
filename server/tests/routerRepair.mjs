import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairMisplacedAngularRouterFiles } from '../src/services/postprocess.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repair-'));
const appDir = path.join(tmp, 'src', 'app');
fs.mkdirSync(appDir, { recursive: true });

fs.writeFileSync(
  path.join(appDir, 'router.ts'),
  `import { Component } from '@angular/core';
import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';

@Component({
  selector: 'app-router',
  standalone: true,
  templateUrl: './router.html',
  styleUrl: './router.scss',
})
export class RouterComponent {
  routes: Routes = [
    { path: '', component: HomeComponent },
    { path: '**', redirectTo: '' },
  ];
}
`,
);

fs.writeFileSync(
  path.join(appDir, 'router.html'),
  `<router-outlet></router-outlet>`,
);

fs.writeFileSync(
  path.join(appDir, 'app.routes.ts'),
  `import { Routes } from '@angular/router';

export const routes: Routes = [];
`,
);

const changed = repairMisplacedAngularRouterFiles(tmp);
assert.ok(changed > 0);
assert.equal(fs.existsSync(path.join(appDir, 'router.ts')), false);
assert.equal(fs.existsSync(path.join(appDir, 'router.html')), false);

const routes = fs.readFileSync(path.join(appDir, 'app.routes.ts'), 'utf-8');
assert.match(routes, /export const routes: Routes = \[/);
assert.match(routes, /HomeComponent/);

console.log('routerRepair.mjs: all assertions passed');
