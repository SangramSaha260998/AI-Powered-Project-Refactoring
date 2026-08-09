/**
 * Final lock so package.json cannot drift to a different Angular major after
 * AI/postprocess. Rewrites @angular/* core packages to stack.core, the
 * web_angular kit deps to major-scaled ranges, and dev tooling to the stack.
 */
function enforceAngularPackageVersions(destPath, stack) {
  if (!stack?.core) return;
  const pkgPath = path.join(destPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.devDependencies = pkg.devDependencies || {};
  const major = parseInt(String(stack.core).split('.')[0], 10) || 22;

  // Core framework packages
  const corePkgs = [
    '@angular/animations',
    '@angular/common',
    '@angular/compiler',
    '@angular/core',
    '@angular/forms',
    '@angular/platform-browser',
    '@angular/platform-browser-dynamic',
    '@angular/router'
  ];
  for (const name of corePkgs) {
    if (pkg.dependencies[name] || name === '@angular/core') {
      pkg.dependencies[name] = `^${stack.core}`;
    }
  }

  // web_angular kit deps (major-scaled)
  const kit = webAngularNpmDeps(stack.core);
  for (const [name, version] of Object.entries(kit.dependencies)) {
    pkg.dependencies[name] = version;
  }

  // Runtime essentials from the template
  if (stack.zone) pkg.dependencies['zone.js'] = stack.zone;
  if (!pkg.dependencies.rxjs) pkg.dependencies.rxjs = '~7.8.0';
  if (!pkg.dependencies.tslib) pkg.dependencies.tslib = '^2.3.0';
  if (!pkg.dependencies['normalize.css']) pkg.dependencies['normalize.css'] = '^8.0.1';

  // Tooling
  if (stack.tooling) {
    pkg.devDependencies['@angular-devkit/build-angular'] = `^${stack.tooling}`;
    pkg.devDependencies['@angular/cli'] = `^${stack.tooling}`;
  }
  pkg.devDependencies['@angular/compiler-cli'] = `^${stack.core}`;
  if (stack.typescript) pkg.devDependencies.typescript = stack.typescript;
  pkg.devDependencies['angular-eslint'] = `^${Math.max(major, 15)}.0.0`;

  // Ensure template runtime deps that may have been dropped by postprocess
  for (const name of ['moment', 'crypto-js', 'bowser']) {
    if (!pkg.dependencies[name] && kit.dependencies[name]) {
      pkg.dependencies[name] = kit.dependencies[name];
    }
  }

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  console.log(
    `[versions] Locked Angular package.json to ^${stack.core} (source=${stack.source}); web_angular kit major-aligned`
  );
}
