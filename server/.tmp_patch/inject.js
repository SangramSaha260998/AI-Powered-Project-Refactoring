// ---------------------------------------------------------------------------
// Angular workspace template injection (from server/web_angular)
// ---------------------------------------------------------------------------

const WEB_ANGULAR_TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'web_angular');

/** Folders never copied from the web_angular template. */
const TEMPLATE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.angular']);

/**
 * Recursively copy the web_angular template into destPath.
 */
function copyWebAngularTemplate(destPath) {
  const src = WEB_ANGULAR_TEMPLATE_DIR;
  if (!fs.existsSync(src)) {
    throw new Error(
      `web_angular template directory not found at ${src}. ` +
        'The server/web_angular folder is required to create new Angular projects.'
    );
  }
  ensureDirectoryExists(destPath);
  const walk = (from, to) => {
    ensureDirectoryExists(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (TEMPLATE_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const srcFull = path.join(from, entry.name);
      const destFull = path.join(to, entry.name);
      if (entry.isDirectory()) {
        walk(srcFull, destFull);
      } else {
        ensureDirectoryExists(path.dirname(destFull));
        fs.copyFileSync(srcFull, destFull);
      }
    }
  };
  walk(src, destPath);
  console.log(`[web_angular] Copied template → ${destPath}`);
}

function toSafeProjectName(name, fallback = 'migrated-angular-project') {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 50);
  return n || fallback;
}

function humanizeProjectName(name) {
  const n = toSafeProjectName(name, 'Migrated Angular Project');
  return n
    .replace(/[-_.]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function lightenHex(hex, amount = 0.55) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const to2 = (c) => c.toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

const NAMED_DESIGN_COLORS = {
  blue: '#0788C0', sky: '#0EA5E9', cyan: '#06B6D4', teal: '#14B8A6',
  emerald: '#10B981', green: '#22C55E', lime: '#84CC16', amber: '#F59E0B',
  orange: '#F97316', red: '#EF4444', rose: '#F43F5E', pink: '#EC4899',
  fuchsia: '#D946EF', purple: '#A855F7', violet: '#8B5CF6', indigo: '#6366F1',
  slate: '#64748B', gray: '#6B7280', navy: '#1D2A54', gold: '#C9A227'
};

/**
 * Extract base design colors from the user prompt. Returns
 * { primary, secondary, tertiary } hex values (template defaults when the
 * prompt does not name colors).
 */
function extractDesignColors(userPrompt) {
  const text = String(userPrompt || '');
  const hexRe = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  const hexes = [...new Set([...text.matchAll(hexRe)].map((m) => '#' + m[1].toLowerCase()))];
  const defaults = { primary: '#0788C0', secondary: '#1D2A54', tertiary: '#C1E1EF' };
  const roles = ['primary', 'secondary', 'tertiary'];
  const result = {};
  const usedHex = new Set();
  const usedName = new Set();

  const hexOf = (v) => (v && v.startsWith('#')) ? v : NAMED_DESIGN_COLORS[v] || null;

  // 1. Role-tagged mentions: "primary color blue", "secondary: #123456"
  for (const role of roles) {
    const re = new RegExp(
      `\\b${role}\\b[^\\n]{0,45}?(?:color|colour)?[^\\n]{0,10}?(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b|(${Object.keys(NAMED_DESIGN_COLORS).join('|')}))`,
      'i'
    );
    const m = text.match(re);
    if (m) {
      const value = m[1] ? m[1].toLowerCase() : m[2].toLowerCase();
      const hex = hexOf(value);
      if (hex) {
        result[role] = hex;
        usedHex.add(hex);
        if (!m[1]) usedName.add(m[2].toLowerCase());
      }
    }
  }

  // 2. Bare hex codes fill remaining roles in order
  for (const role of roles) {
    if (result[role]) continue;
    const next = hexes.find((h) => !usedHex.has(h));
    if (next) {
      result[role] = next;
      usedHex.add(next);
    }
  }

  // 3. Bare color-name words fill remaining roles
  for (const role of roles) {
    if (result[role]) continue;
    const named = Object.keys(NAMED_DESIGN_COLORS).find(
      (name) => !usedName.has(name) && new RegExp(`\\b${name}\\b`, 'i').test(text)
    );
    if (named) {
      result[role] = NAMED_DESIGN_COLORS[named];
      usedName.add(named);
    }
  }

  for (const role of roles) result[role] = result[role] || defaults[role];
  return result;
}

/**
 * Extract a project name from the user prompt; falls back to the source
 * package.json name, then a safe default.
 */
function extractProjectName(userPrompt, sourcePackageJson) {
  const text = String(userPrompt || '');
  const nameRe =
    /(?:project|app)\s+(?:name|called|named|titled|is)\s*[:\-]?\s*['"]?([A-Za-z0-9][A-Za-z0-9 _\-.]{1,40})/i;
  const nameItRe =
    /(?:name|call)\s+(?:it|this|the\s+project|the\s+app)\s+['"]?([A-Za-z0-9][A-Za-z0-9 _\-.]{1,40})/i;
  let name = null;
  for (const re of [nameRe, nameItRe]) {
    const m = text.match(re);
    if (m) {
      name = m[1].trim();
      break;
    }
  }
  if (name) return toSafeProjectName(name);
  const srcName =
    sourcePackageJson && typeof sourcePackageJson.name === 'string'
      ? sourcePackageJson.name.trim()
      : '';
  if (srcName && !/^(angular|react|my-app|demo|test|app|project|frontend|web)$/i.test(srcName)) {
    return toSafeProjectName(srcName);
  }
  return 'migrated-angular-project';
}

/**
 * Customize the copied template: project name, base design colors, titles.
 * Versions are locked separately by enforceAngularPackageVersions().
 */
function applyAngularTemplateCustomizations(destPath, options) {
  const { projectName = 'migrated-angular-project', designColors = {} } = options;
  const humanName = humanizeProjectName(projectName);

  // package.json: name (+ drop husky "prepare" so `npm ci` never needs a git repo)
  const pkgPath = path.join(destPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      pkg.name = projectName;
      if (pkg.scripts && typeof pkg.scripts.prepare === 'string') {
        delete pkg.scripts.prepare;
      }
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  // angular.json: project key + outputPath + buildTargets
  const angularJsonPath = path.join(destPath, 'angular.json');
  if (fs.existsSync(angularJsonPath)) {
    try {
      const raw = fs.readFileSync(angularJsonPath, 'utf-8');
      const normalized = raw.replace(/migrated-angular-project/g, projectName);
      fs.writeFileSync(angularJsonPath, `${normalized}\n`, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  // index.html title + favicon references
  const indexHtmlPath = path.join(destPath, 'src', 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    let html = fs.readFileSync(indexHtmlPath, 'utf-8');
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${humanName}</title>`);
    html = html.replace(/demo-admin-favicon/g, `${projectName}-favicon`);
    fs.writeFileSync(indexHtmlPath, html, 'utf-8');
  }

  // favicon copy
  const faviconSrc = path.join(WEB_ANGULAR_TEMPLATE_DIR, 'public', 'favicon', 'demo-admin-favicon.svg');
  const faviconDestDir = path.join(destPath, 'public', 'favicon');
  if (fs.existsSync(faviconSrc)) {
    ensureDirectoryExists(faviconDestDir);
    fs.copyFileSync(faviconSrc, path.join(faviconDestDir, `${projectName}-favicon.svg`));
    try {
      fs.unlinkSync(path.join(faviconDestDir, 'demo-admin-favicon.svg'));
    } catch {
      /* ignore */
    }
  }

  // app.component.ts title
  const appTsPath = path.join(destPath, 'src', 'app', 'app.component.ts');
  if (fs.existsSync(appTsPath)) {
    let ts = fs.readFileSync(appTsPath, 'utf-8');
    ts = ts.replace(
      /public\s+title\s*=\s*['"][^'"]*['"]/,
      `public title = '${humanName.replace(/'/g, "\\'")}';`
    );
    fs.writeFileSync(appTsPath, ts, 'utf-8');
  }

  // app.component.html loading-bar color → primary
  const appHtmlPath = path.join(destPath, 'src', 'app', 'app.component.html');
  if (fs.existsSync(appHtmlPath) && designColors.primary) {
    let html = fs.readFileSync(appHtmlPath, 'utf-8');
    html = html.replace(/(\[color\]=\s*['"])([^'"]*)(['"])/, `$1${designColors.primary}$3`);
    fs.writeFileSync(appHtmlPath, html, 'utf-8');
  }

  // config/app-settings.config.ts appTitle
  const settingsPath = path.join(destPath, 'src', 'app', 'config', 'app-settings.config.ts');
  if (fs.existsSync(settingsPath)) {
    let ts = fs.readFileSync(settingsPath, 'utf-8');
    ts = ts.replace(
      /appTitle\s*:\s*['"][^'"]*['"]/,
      `appTitle: '${humanName.replace(/'/g, "\\'")}'`
    );
    fs.writeFileSync(settingsPath, ts, 'utf-8');
  }

  // tailwind.config.js base colors
  const twPath = path.join(destPath, 'tailwind.config.js');
  if (fs.existsSync(twPath) && (designColors.primary || designColors.secondary || designColors.tertiary)) {
    let tw = fs.readFileSync(twPath, 'utf-8');
    if (designColors.primary) {
      tw = tw.replace(
        /primary:\s*\{[^}]*\}/,
        `primary: {\n        DEFAULT: '${designColors.primary}',\n        100: '${lightenHex(designColors.primary)}',\n      }`
      );
    }
    if (designColors.secondary) {
      tw = tw.replace(
        /secondary:\s*\{[^}]*\}/,
        `secondary: {\n        DEFAULT: '${designColors.secondary}',\n        100: '${lightenHex(designColors.secondary)}',\n      }`
      );
    }
    if (designColors.tertiary) {
      tw = tw.replace(
        /tertiary:\s*\{[^}]*\}/,
        `tertiary: {\n        DEFAULT: '${designColors.tertiary}',\n      }`
      );
    }
    fs.writeFileSync(twPath, tw, 'utf-8');
  }
}

/**
 * Copy the whole web_angular template into the migration workspace and apply
 * the only allowed customizations: target version, project name, base colors.
 * Every other template file (shared kit, core services, store, layouts, scss
 * design system, environments, configs) is kept as-is.
 */
function injectAngularWorkspaceTemplates(destPath, versionStack = null, options = {}) {
  const stack = versionStack || {
    core: '22.0.8',
    tooling: '22.0.7',
    typescript: '~5.9.2',
    zone: '~0.16.0'
  };
  const { projectName = 'migrated-angular-project', designColors = {} } = options;

  copyWebAngularTemplate(destPath);
  applyAngularTemplateCustomizations(destPath, { projectName, designColors });
  enforceAngularPackageVersions(destPath, stack);

  // Ensure the Angular app structure folders exist (template already provides them)
  ensureDirectoryExists(path.join(destPath, 'src', 'app'));
  ensureDirectoryExists(path.join(destPath, 'public'));
  ensureDirectoryExists(path.join(destPath, 'public', 'scss'));
}

/**
 * Restore pristine template root/config files after AI generation (pipeline
 * step 4b) so the delivered project always ships with the exact web_angular
 * tooling. Re-applies project name / colors / version customizations.
 * src/app/pages + src/app/core + src/app/shared + src/app/store are NEVER
 * touched here — the AI owns the feature pages, the template owns the kit.
 */
function restoreAngularRootConfigs(destPath, stack, options = {}) {
  const { projectName = 'migrated-angular-project', designColors = {} } = options;
  const rootFiles = [
    'package.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json',
    'tsconfig.spec.json', 'tailwind.config.js', 'eslint.config.js', '.prettierrc',
    '.gitignore', '.editorconfig', '.husky/pre-commit'
  ];
  for (const rel of rootFiles) {
    const src = path.join(WEB_ANGULAR_TEMPLATE_DIR, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destPath, rel);
    ensureDirectoryExists(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  for (const rel of ['src/index.html', 'src/main.ts', 'src/styles.scss', 'src/app/app.config.ts']) {
    const src = path.join(WEB_ANGULAR_TEMPLATE_DIR, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destPath, rel);
    ensureDirectoryExists(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  applyAngularTemplateCustomizations(destPath, { projectName, designColors });
  enforceAngularPackageVersions(destPath, stack);
  console.log('[web_angular] Restored pristine root config files + customizations');
}

// ---------------------------------------------------------------------------
// Token-efficient source reading (only essential files for a web_angular app)
// ---------------------------------------------------------------------------

const ESSENTIAL_STOPLIST = new Set([
  'list', 'form', 'edit', 'add', 'detail', 'view', 'index', 'route', 'routes',
  'service', 'component', 'app', 'page', 'pages', 'home', 'login', 'dashboard',
  'common', 'config', 'data', 'model', 'type', 'types', 'utils', 'util',
  'helper', 'const', 'constants', 'styles', 'style', 'test', 'spec', 'main',
  'shared', 'core', 'store', 'layout', 'auth'
]);

/**
 * Keep only the source files that are essential to functionalize a
 * web_angular-style app (auth + dashboard + shell + shared plumbing). Feature
 * pages that are NOT auth/dashboard related are dropped to save tokens.
 */
function filterEssentialSourceFiles(filesMap, userPrompt = '') {
  const promptLower = String(userPrompt || '').toLowerCase();
  const result = {};
  for (const [rel, content] of Object.entries(filesMap)) {
    const n = rel.replace(/\\/g, '/');
    if (isEssentialSourcePath(n, promptLower)) {
      result[rel] = content;
    }
  }
  // Never strip everything — fall back to the full map if the filter was too aggressive
  if (Object.keys(result).length === 0) return filesMap;
  return result;
}

function isEssentialSourcePath(n, promptLower) {
  // Root-level config / tooling files (small, always useful)
  if (!n.startsWith('src/')) return true;

  // Assets are never source code
  if (/^src\/assets\//.test(n)) return false;

  // Entry points + global styles
  if (/^src\/(main|app|index|styles|polyfills|test|environments)\b/.test(n)) return true;
  if (n.includes('/environments/')) return true;

  // Shared plumbing / framework folders (services, stores, guards, libs, …)
  if (
    /\/(core|shared|common|store|state|models?|types|interfaces|interceptors?|guards?|http|api|services?|lib|hooks?|utils?|helpers?|constants?|configs?|context|validators?|pipes?|directives?|animations?|data|assets|theme)\//.test(n)
  ) {
    return true;
  }

  // Auth + dashboard related features
  if (
    /\/(auth|login|register|signin|signup|sign-in|sign-up|forgot|reset|otp|password|credential|token|account|profile|logout)\//.test(n)
  ) {
    return true;
  }
  if (
    /\/(dashboard|home|overview|analytics|shell|layout|sidebar|header|navbar|topbar|footer|sidenav)\//.test(n)
  ) {
    return true;
  }

  // Loose src-root files
  if (!n.includes('/')) return true;

  // Feature files whose basename is explicitly mentioned in the user prompt
  const base = (n.split('/').pop() || '')
    .replace(/\.(ts|tsx|js|jsx|html|scss|css|json)$/i, '')
    .replace(/\.component$|\.service$|\.page$|\.view$/i, '')
    .toLowerCase();
  if (base.length > 3 && !ESSENTIAL_STOPLIST.has(base) && promptLower.includes(base)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Final npm ci sanity check
// ---------------------------------------------------------------------------

/**
 * Verify the delivered project installs and builds from a clean `npm ci`
 * (the exact command a user will run on the downloaded ZIP). Regenerates the
 * lock file first when missing or out of sync, then runs `npm ci` + build.
 * Returns { ok: boolean, errors: string }.
 */
async function verifyNpmCiBuild(workspacePath, targetTech, sessionId) {
  const isAngular = String(targetTech).toLowerCase().includes('angular');
  const buildCmd = isAngular ? 'npx' : 'npm';
  const buildArgs = isAngular ? ['ng', 'build'] : ['run', 'build'];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const lockPath = path.join(workspacePath, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      console.log(`[${sessionId}] npm ci check: no package-lock.json — generating via npm install...`);
      const gen = await runCommand('npm', ['install', '--prefer-offline'], workspacePath, 300000);
      if (gen.exitCode !== 0) {
        return {
          ok: false,
          errors: `npm install (lock generation) failed:\n${(gen.stderr || gen.stdout || '').slice(-2000)}`
        };
      }
    }

    console.log(`[${sessionId}] npm ci check (attempt ${attempt}/2): npm ci ...`);
    const ci = await runCommand('npm', ['ci', '--prefer-offline'], workspacePath, 300000);
    if (ci.exitCode !== 0) {
      const errOut = (ci.stderr || ci.stdout || '').slice(-1500);
      console.error(`[${sessionId}] npm ci failed (attempt ${attempt}):\n${errOut}`);
      if (attempt === 1) {
        // Out-of-sync lock (postprocess may have touched package.json) — regen + retry
        const regen = await runCommand('npm', ['install', '--prefer-offline'], workspacePath, 300000);
        if (regen.exitCode !== 0) {
          return {
            ok: false,
            errors: `npm ci failed, lock regeneration also failed:\n${errOut}\n${(regen.stderr || regen.stdout || '').slice(-1500)}`
          };
        }
        continue;
      }
      return { ok: false, errors: `npm ci failed:\n${errOut}` };
    }

    console.log(`[${sessionId}] npm ci succeeded. Running ${buildCmd} ${buildArgs.join(' ')}...`);
    const build = await runCommand(buildCmd, buildArgs, workspacePath, 300000);
    if (build.exitCode === 0) {
      console.log(`[${sessionId}] npm ci + build ✅ PASSED`);
      return { ok: true, errors: '' };
    }
    const buildErr = (build.stderr || build.stdout || '').slice(-2500);
    console.error(`[${sessionId}] npm ci build failed:\n${buildErr}`);
    return { ok: false, errors: `npm ci build failed:\n${buildErr}` };
  }

  return { ok: false, errors: 'npm ci verification exhausted retries.' };
}
