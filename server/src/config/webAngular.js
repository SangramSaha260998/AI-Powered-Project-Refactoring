/**
 * Config for the server/web_angular shared template kit.
 *
 * The web_angular folder is the COMPLETE reference Angular workspace used to
 * bootstrap every migrated Angular project. The migration pipeline copies the
 * whole template, then only customizes: target framework version (from the
 * user prompt), project name, and base design colors. Everything else (shared
 * components/directives/pipes/validators/utilities, core services, guards,
 * interceptors, layouts, NGXS store, environments, scss design system) is kept
 * as-is so every generated project has the same structure, quality bar and
 * tooling as web_angular.
 */

/** NGXS major lines that are known to exist on npm. */
const NGXS_BY_MAJOR = {
  15: '^15.0.0',
  16: '^16.0.0',
  17: '^17.0.0',
  18: '^18.1.0',
  19: '^19.0.0',
  20: '^20.0.0',
  21: '^21.0.0',
  22: '^22.0.0'
};

function majorOf(angularCoreVersion) {
  return parseInt(String(angularCoreVersion || '22.0.8').split('.')[0], 10) || 22;
}

/**
 * npm packages required by the web_angular template, scaled to the resolved
 * Angular core major so `npm ci` succeeds on every supported major.
 *
 * Facts verified against the npm registry:
 *  - @angular/material|cdk publish a matching major (^<major>.0.0).
 *  - @ngxs/store + @ngxs/logger-plugin publish per-Angular-major lines.
 *  - ngx-toastr stopped at major 20; 19.x declares peer ranges ">=16.0.0-0"
 *    (forward compatible), so majors >= 19 pin ^19.0.0.
 *  - ngx-cookie-service publishes majors up to 22.
 *  - @ngx-loading-bar/core ^7.0.0 requires @angular/common >= 16.
 */
export function webAngularNpmDeps(angularCoreVersion = '22.0.8') {
  const major = majorOf(angularCoreVersion);
  const materialVer = `^${major}.0.0`;
  const ngxs = NGXS_BY_MAJOR[major] || (major > 22 ? '^22.0.0' : '^15.0.0');
  const toastr = major >= 19 ? '^19.0.0' : `^${Math.max(major, 15)}.0.0`;
  const cookie = `^${Math.min(Math.max(major, 15), 22)}.0.0`;
  const loadingBar = major >= 17 ? '^7.0.0' : '^6.0.0';

  return {
    dependencies: {
      '@angular/cdk': materialVer,
      '@angular/material': materialVer,
      '@ngxs/store': ngxs,
      '@ngxs/logger-plugin': ngxs,
      'ngx-toastr': toastr,
      'ngx-cookie-service': cookie,
      '@ngx-loading-bar/core': loadingBar,
      bowser: '^2.11.0',
      moment: '^2.30.1',
      'crypto-js': '^4.2.0',
      // lmdb (used by @angular-devkit/build-angular) requires lru-cache
      // as a peer dep; pinning v10 avoids 'LRUCache is not a constructor'
      'lru-cache': '^10.0.3'
    }
  };
}

/**
 * Path aliases used by web_angular imports (mirrors web_angular/tsconfig.json,
 * expressed with a ./ baseUrl so postprocess can merge them safely).
 */
export const WEB_ANGULAR_PATH_ALIASES = {
  '@app/*': ['src/app/*'],
  '@core/*': ['src/app/core/*'],
  '@pages/*': ['src/app/pages/*'],
  '@store/*': ['src/app/store/*'],
  '@env/*': ['src/environments/*'],
  '@shared/*': ['src/app/shared/*'],
  '@configs/*': ['src/app/config/*'],
  '@/*': ['src/*']
};

/**
 * Destination prefixes that belong to the web_angular template kit and must
 * not be overwritten by the AI file writer (they are already complete).
 */
export const WEB_ANGULAR_PROTECTED_PREFIXES = [
  'src/app/config/',
  'src/app/core/authentication/',
  'src/app/core/guards/',
  'src/app/core/http/',
  'src/app/core/interceptors/',
  'src/app/core/layouts/',
  'src/app/core/resolvers/',
  'src/app/core/services/',
  'src/app/shared/',
  'src/app/store/',
  'src/app/pages/common/',
  'src/app/pages/deeplink/'
];

/** Exact template src files the AI must never overwrite. */
export const WEB_ANGULAR_PROTECTED_FILES = new Set([
  'src/app/app.config.ts',
  'src/main.ts',
  'src/styles.scss',
  'src/index.html'
]);

export function isWebAngularProtectedPath(_relativePath) {
  // Starter-kit paths are no longer protected — convert every source file.
  return false;
}
