import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { injectAngularWorkspaceTemplates, extractDesignColors, extractProjectName, verifyNpmCiBuild } =
  await import('../src/services/migration.js');
const { resolveTargetVersions } = await import('../src/config/targetVersions.js');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wae2e-'));
const dest = path.join(workDir, 'app');

const prompt =
  'Create a hospital management system called CareFlow Admin. Use primary color #0F766E (teal) and secondary color #312E81 (indigo), tertiary #CFFAFE.';
const colors = extractDesignColors(prompt);
const projectName = extractProjectName(prompt, { name: 'careflow-admin' });

console.log('projectName =', projectName);
console.log('colors =', JSON.stringify(colors));

// Angular 22 stack via the real resolver (as runMigrationPipeline does)
const targetVersions = resolveTargetVersions('Angular 22', 'Angular');
const stack = targetVersions.angular;

injectAngularWorkspaceTemplates(dest, stack, { projectName, designColors: colors });

// sanity: customized files
const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf-8'));
console.log('pkg.name =', pkg.name);
console.log('core =', pkg.dependencies['@angular/core']);
console.log('material =', pkg.dependencies['@angular/material']);
console.log('ngxs =', pkg.dependencies['@ngxs/store']);
console.log('toastr =', pkg.dependencies['ngx-toastr']);
console.log('cookie =', pkg.dependencies['ngx-cookie-service']);
console.log('devkit =', pkg.devDependencies['@angular-devkit/build-angular']);
console.log('ts =', pkg.devDependencies.typescript);
console.log('prepare script present?', !!pkg.scripts?.prepare);

const aj = JSON.parse(fs.readFileSync(path.join(dest, 'angular.json'), 'utf-8'));
console.log('angular project key =', Object.keys(aj.projects)[0]);
console.log('outputPath =', aj.projects[projectName].architect.build.options.outputPath);

const indexHtml = fs.readFileSync(path.join(dest, 'src', 'index.html'), 'utf-8');
console.log('title match =', /<title>CareFlow Admin<\/title>/.test(indexHtml));

const tw = fs.readFileSync(path.join(dest, 'tailwind.config.js'), 'utf-8');
console.log('primary teal applied =', tw.includes("DEFAULT: '#0f766e'"));
console.log('secondary indigo applied =', tw.includes("DEFAULT: '#312e81'"));

console.log('--- running npm ci + build (Angular 22) ---');
const { ok, errors } = await verifyNpmCiBuild(dest, 'Angular', 'e2e');
console.log('npm ci + build OK?', ok);
if (!ok) {
  console.error('ERRORS:\n', errors);
  process.exit(1);
}
console.log('E2E PASSED ✅');
