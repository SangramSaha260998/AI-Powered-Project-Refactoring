/**
 * npm packages required by server/angular_required shared kit.
 * Versions for @angular/material|cdk track the resolved Angular core major.
 */

export function angularRequiredNpmDeps(angularCoreVersion = '22.0.8') {
  const major = parseInt(String(angularCoreVersion).split('.')[0], 10) || 22;
  const materialVer = `^${major}.0.0`;

  let ngxs = '^21.0.0';
  if (major <= 18) ngxs = '^18.1.0';
  else if (major === 19) ngxs = '^19.0.0';
  else if (major === 20) ngxs = '^20.0.0';
  else ngxs = '^21.0.0';

  return {
    '@angular/cdk': materialVer,
    '@angular/material': materialVer,
    '@ngxs/store': ngxs,
    '@ngx-loading-bar/core': '^7.0.0',
    bowser: '^2.11.0'
  };
}

/** Path aliases expected by angular_required imports. */
export const ANGULAR_REQUIRED_PATH_ALIASES = {
  '@/*': ['src/*'],
  '@app/*': ['src/app/*'],
  '@core/*': ['src/app/core/*'],
  '@env/*': ['src/environments/*'],
  '@shared/*': ['src/app/shared/*']
};

/**
 * Destination prefixes that come from angular_required and must not be
 * overwritten by the AI file writer.
 */
export const ANGULAR_REQUIRED_PROTECTED_PREFIXES = [
  'src/app/shared/animations/',
  'src/app/shared/components/',
  'src/app/shared/directives/',
  'src/app/shared/models/',
  'src/app/shared/pipes/',
  'src/app/shared/utilities/',
  'src/app/shared/validators/',
  'src/app/core/interceptors/',
  'src/app/store/'
  // NOTE: src/environments/ is intentionally NOT protected — incremental units
  // (e.g. app.settings) often need to extend environment with theme/appTitle/etc.
];

export function isAngularRequiredProtectedPath(relativePath) {
  const p = String(relativePath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (ANGULAR_REQUIRED_PROTECTED_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    return true;
  }
  // Barrel files at shared root that belong to the kit
  if (
    p === 'src/app/shared/components/index.ts' ||
    p === 'src/app/shared/directives/index.ts' ||
    p === 'src/app/shared/pipes/index.ts' ||
    p === 'src/app/shared/validators/index.ts' ||
    p === 'src/app/shared/utilities/index.ts' ||
    p === 'src/app/shared/animations/index.ts' ||
    p === 'src/app/store/index.ts' ||
    p === 'src/app/core/interceptors/index.ts'
  ) {
    return true;
  }
  return false;
}
