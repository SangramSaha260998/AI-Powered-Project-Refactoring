import fs from 'fs';
import path from 'path';
import { IGNORED_FOLDERS, TEXT_EXTENSIONS } from '../config/index.js';

/**
 * Analyzer service — implements the "Repository Analyzer" + "Architecture
 * Mapper" stages from the ChatGPT workflow.
 *
 * It inspects the uploaded source project (React) and the optional reference
 * project (Angular), builds a dependency graph, detects components/services/
 * routes, and produces a migration plan preview that maps source files onto
 * the reference architecture.
 */

/**
 * Recursively read text files from a directory (same filtering as migration.js).
 * @param {string} dirPath
 * @param {string} [baseDir]
 * @param {object} [fileList]
 * @returns {object} map of relativePath → content
 */
function readDirectoryRecursively(dirPath, baseDir = dirPath, fileList = {}) {
  if (!fs.existsSync(dirPath)) return fileList;
  const items = fs.readdirSync(dirPath);
  for (const item of items) {
    const fullPath = path.join(dirPath, item);
    const relativePath = path.relative(baseDir, fullPath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (IGNORED_FOLDERS.has(item) || item.startsWith('.')) continue;
      readDirectoryRecursively(fullPath, baseDir, fileList);
    } else {
      const ext = path.extname(item).toLowerCase();
      if (TEXT_EXTENSIONS.includes(ext)) {
        try {
          fileList[relativePath] = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return fileList;
}

/**
 * Find the best base search path (handles nested src folders and flat zips).
 * @param {string} extractPath
 * @returns {string}
 */
function findBaseSearchPath(extractPath) {
  if (fs.existsSync(path.join(extractPath, 'src'))) return extractPath;
  if (fs.existsSync(path.join(extractPath, 'package.json'))) return extractPath;
  try {
    const entries = fs.readdirSync(extractPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_FOLDERS.has(entry.name) && !entry.name.startsWith('.')) {
        const nestedSrc = path.join(extractPath, entry.name, 'src');
        if (fs.existsSync(nestedSrc)) return path.join(extractPath, entry.name);
        const nestedPkg = path.join(extractPath, entry.name, 'package.json');
        if (fs.existsSync(nestedPkg)) return path.join(extractPath, entry.name);
      }
    }
  } catch {
    /* ignore */
  }
  return extractPath;
}

/**
 * Detect the framework of a project from its package.json.
 * @param {object} filesMap
 * @returns {string} 'angular' | 'react' | 'unknown'
 */
function detectFramework(filesMap) {
  const pkg = filesMap['package.json'] || '';
  if (!pkg) return 'unknown';
  try {
    const parsed = JSON.parse(pkg);
    const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
    if (deps['@angular/core']) return 'angular';
    if (deps['react'] || deps['react-dom']) return 'react';
  } catch {
    /* ignore */
  }
  return 'unknown';
}

/**
 * Extract import/require statements from a source file.
 * @param {string} content
 * @returns {string[]} list of module specifiers
 */
function extractImports(content) {
  const imports = [];
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    imports.push(m[1] || m[2]);
  }
  return imports;
}

/**
 * Resolve a module specifier to a relative file path within the project.
 * @param {string} specifier
 * @param {string} fromFile
 * @param {object} filesMap
 * @returns {string|null}
 */
function resolveImportToFile(specifier, fromFile, filesMap) {
  if (!specifier) return null;
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null; // external package
  const fromDir = path.posix.dirname(fromFile);
  const candidates = [];
  const base = specifier.startsWith('/')
    ? specifier.slice(1)
    : path.posix.normalize(path.posix.join(fromDir, specifier));
  candidates.push(base);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
    candidates.push(base + ext);
  }
  candidates.push(path.posix.join(base, 'index.ts'));
  candidates.push(path.posix.join(base, 'index.tsx'));
  candidates.push(path.posix.join(base, 'index.js'));
  candidates.push(path.posix.join(base, 'index.jsx'));
  for (const c of candidates) {
    if (filesMap[c]) return c;
  }
  return null;
}

/**
 * Build a dependency graph of the project files.
 * @param {object} filesMap
 * @returns {object} { nodes: string[], edges: Array<{from, to}> }
 */
function buildDependencyGraph(filesMap) {
  const nodes = Object.keys(filesMap);
  const edges = [];
  for (const file of nodes) {
    const content = filesMap[file] || '';
    const imports = extractImports(content);
    for (const spec of imports) {
      const resolved = resolveImportToFile(spec, file, filesMap);
      if (resolved && resolved !== file) {
        edges.push({ from: file, to: resolved });
      }
    }
  }
  return { nodes, edges };
}

/**
 * Detect React components (function/class components) in a file.
 * @param {string} content
 * @param {string} filePath
 * @returns {string[]}
 */
function detectReactComponents(content, filePath) {
  const components = [];
  const fnRe = /(?:export\s+default\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/g;
  let m;
  while ((m = fnRe.exec(content)) !== null) components.push(m[1]);
  const arrowRe = /(?:export\s+default\s+)?const\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/g;
  while ((m = arrowRe.exec(content)) !== null) components.push(m[1]);
  const classRe = /(?:export\s+default\s+)?class\s+([A-Z][A-Za-z0-9]*)\s+extends\s+React\.Component/g;
  while ((m = classRe.exec(content)) !== null) components.push(m[1]);
  return [...new Set(components)];
}

/**
 * Detect Angular components in a file.
 * @param {string} content
 * @param {string} filePath
 * @returns {string[]}
 */
function detectAngularComponents(content, filePath) {
  const components = [];
  const re = /@Component\s*\([\s\S]*?\)\s*export\s+class\s+([A-Z][A-Za-z0-9]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) components.push(m[1]);
  return [...new Set(components)];
}

/**
 * Detect Angular services in a file.
 * @param {string} content
 * @returns {string[]}
 */
function detectAngularServices(content) {
  const services = [];
  const re = /@Injectable\s*\([\s\S]*?\)\s*export\s+class\s+([A-Z][A-Za-z0-9]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) services.push(m[1]);
  return [...new Set(services)];
}

/**
 * Detect route definitions in a file.
 * @param {string} content
 * @param {string} filePath
 * @returns {string[]}
 */
function detectRoutes(content, filePath) {
  const routes = [];
  const lower = filePath.toLowerCase();
  if (lower.includes('route') || lower.includes('router')) {
    const pathRe = /path\s*:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = pathRe.exec(content)) !== null) routes.push(m[1]);
  }
  return [...new Set(routes)];
}

/**
 * Analyze a source project (React) and return its structure.
 * @param {string} extractPath
 * @returns {object}
 */
export function analyzeSourceProject(extractPath) {
  const baseSearchPath = findBaseSearchPath(extractPath);
  const filesMap = readDirectoryRecursively(baseSearchPath);
  const framework = detectFramework(filesMap);
  const graph = buildDependencyGraph(filesMap);

  const components = [];
  const services = [];
  const routes = [];
  const hooks = [];
  const contexts = [];

  for (const [file, content] of Object.entries(filesMap)) {
    const lower = file.toLowerCase();
    if (framework === 'react' || /\.(tsx|jsx)$/i.test(file)) {
      const comps = detectReactComponents(content, file);
      for (const c of comps) components.push({ name: c, file });
      if (lower.includes('hook') || /use[A-Z]/.test(content)) {
        const hookRe = /(?:export\s+default\s+)?(?:function|const)\s+(use[A-Z][A-Za-z0-9]*)/g;
        let m;
        while ((m = hookRe.exec(content)) !== null) hooks.push({ name: m[1], file });
      }
      if (lower.includes('context')) {
        const ctxRe = /(?:export\s+default\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9]*Context)/g;
        let m;
        while ((m = ctxRe.exec(content)) !== null) contexts.push({ name: m[1], file });
      }
    }
    if (framework === 'angular' || /\.ts$/i.test(file)) {
      const comps = detectAngularComponents(content, file);
      for (const c of comps) components.push({ name: c, file });
      const svcs = detectAngularServices(content);
      for (const s of svcs) services.push({ name: s, file });
    }
    const rt = detectRoutes(content, file);
    for (const r of rt) routes.push({ path: r, file });
  }

  return {
    framework,
    basePath: baseSearchPath,
    fileCount: Object.keys(filesMap).length,
    fileTree: Object.keys(filesMap),
    filesMap,
    dependencyGraph: graph,
    components: [...new Map(components.map((c) => [`${c.file}:${c.name}`, c])).values()],
    services: [...new Map(services.map((s) => [`${s.file}:${s.name}`, s])).values()],
    routes: [...new Map(routes.map((r) => `${r.file}:${r.path}`)).values()],
    hooks: [...new Map(hooks.map((h) => `${h.file}:${h.name}`, h)).values()],
    contexts: [...new Map(contexts.map((c) => `${c.file}:${c.name}`, c)).values()],
  };
}

/**
 * Analyze a reference project (Angular) and return its architecture.
 * @param {string} referencePath
 * @returns {object}
 */
export function analyzeReferenceProject(referencePath) {
  const baseSearchPath = findBaseSearchPath(referencePath);
  const filesMap = readDirectoryRecursively(baseSearchPath);
  const framework = detectFramework(filesMap);

  // Detect folder structure under src/app
  const folders = new Set();
  const components = [];
  const sharedComponents = [];
  const services = [];
  const guards = [];
  const interceptors = [];
  const pipes = [];
  const directives = [];

  for (const [file, content] of Object.entries(filesMap)) {
    const lower = file.toLowerCase();
    const parts = file.split('/');
    if (parts.length >= 2) folders.add(parts.slice(0, -1).join('/'));

    if (/\.component\.ts$/i.test(file)) {
      const comps = detectAngularComponents(content, file);
      for (const c of comps) {
        const entry = { name: c, file };
        if (lower.includes('/shared/')) sharedComponents.push(entry);
        else components.push(entry);
      }
    }
    if (/\.service\.ts$/i.test(file)) {
      const svcs = detectAngularServices(content);
      for (const s of svcs) services.push({ name: s, file });
    }
    if (/\.guard\.ts$/i.test(file)) {
      const re = /export\s+(?:const|function|class)\s+([A-Za-z0-9_]*)/g;
      let m;
      while ((m = re.exec(content)) !== null) guards.push({ name: m[1], file });
    }
    if (/\.interceptor\.ts$/i.test(file)) {
      const re = /export\s+(?:const|function|class)\s+([A-Za-z0-9_]*)/g;
      let m;
      while ((m = re.exec(content)) !== null) interceptors.push({ name: m[1], file });
    }
    if (/\.pipe\.ts$/i.test(file)) {
      const re = /export\s+class\s+([A-Za-z0-9_]*)/g;
      let m;
      while ((m = re.exec(content)) !== null) pipes.push({ name: m[1], file });
    }
    if (/\.directive\.ts$/i.test(file)) {
      const re = /export\s+class\s+([A-Za-z0-9_]*)/g;
      let m;
      while ((m = re.exec(content)) !== null) directives.push({ name: m[1], file });
    }
  }

  // Detect styling system
  const hasTailwind = Object.keys(filesMap).some((f) => /tailwind\.config/i.test(f));
  const hasScss = Object.keys(filesMap).some((f) => /\.scss$/i.test(f));
  const hasMaterial = Object.keys(filesMap).some((f) => /material/i.test(f));
  const hasNgxs = Object.keys(filesMap).some((f) => /store|ngxs/i.test(f));

  return {
    framework,
    basePath: baseSearchPath,
    fileCount: Object.keys(filesMap).length,
    fileTree: Object.keys(filesMap),
    filesMap,
    folders: [...folders].sort(),
    sharedComponents,
    services,
    guards,
    interceptors,
    pipes,
    directives,
    styling: {
      tailwind: hasTailwind,
      scss: hasScss,
      material: hasMaterial,
      ngxs: hasNgxs,
    },
  };
}

/**
 * Build a migration plan preview mapping source files onto the reference
 * architecture. This is a deterministic heuristic — the AI refines it later
 * in the blueprint stage.
 * @param {object} sourceAnalysis
 * @param {object} referenceAnalysis
 * @param {string} fromTech
 * @param {string} toTech
 * @returns {object}
 */
export function buildMigrationPlan(sourceAnalysis, referenceAnalysis, fromTech, toTech) {
  const toLower = String(toTech || '').toLowerCase();
  const isAngularTarget = toLower.includes('angular');
  const isReactTarget = toLower.includes('react');

  const mappings = [];
  const plan = [];

  if (isAngularTarget) {
    // Map React components → Angular pages under src/app/pages/admin
    for (const comp of sourceAnalysis.components || []) {
      const base = path.posix.basename(comp.file).replace(/\.(tsx|jsx|ts)$/i, '');
      const kebab = base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9-]+/g, '-')
        .toLowerCase();
      const targetDir = `src/app/pages/admin/${kebab}`;
      const targetBase = `${targetDir}/${kebab}.component`;
      mappings.push({
        source: comp.file,
        sourceName: comp.name,
        target: `${targetBase}.ts`,
        type: 'component',
      });
      plan.push(
        { newPath: `${targetBase}.ts`, complexity: 'medium', unit: targetBase },
        { newPath: `${targetBase}.html`, complexity: 'medium', unit: targetBase },
        { newPath: `${targetBase}.scss`, complexity: 'low', unit: targetBase },
      );
    }
    // Map React hooks → Angular services
    for (const hook of sourceAnalysis.hooks || []) {
      const base = path.posix.basename(hook.file).replace(/\.(tsx|ts|jsx|js)$/i, '');
      const kebab = base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/^use-?/i, '')
        .replace(/[^a-zA-Z0-9-]+/g, '-')
        .toLowerCase();
      const targetPath = `src/app/core/services/${kebab}.service.ts`;
      mappings.push({
        source: hook.file,
        sourceName: hook.name,
        target: targetPath,
        type: 'service',
      });
      plan.push({ newPath: targetPath, complexity: 'medium', unit: targetPath });
    }
  } else if (isReactTarget) {
    // Map Angular components → React components under src/features
    for (const comp of sourceAnalysis.components || []) {
      const base = path.posix.basename(comp.file).replace(/\.component\.ts$/i, '');
      const pascal = base
        .split(/[-_]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
      const targetPath = `src/features/${base}/${pascal}.tsx`;
      mappings.push({
        source: comp.file,
        sourceName: comp.name,
        target: targetPath,
        type: 'component',
      });
      plan.push({ newPath: targetPath, complexity: 'medium', unit: targetPath });
    }
    for (const svc of sourceAnalysis.services || []) {
      const base = path.posix.basename(svc.file).replace(/\.service\.ts$/i, '');
      const targetPath = `src/services/${base}.ts`;
      mappings.push({
        source: svc.file,
        sourceName: svc.name,
        target: targetPath,
        type: 'service',
      });
      plan.push({ newPath: targetPath, complexity: 'medium', unit: targetPath });
    }
  }

  return {
    fromTech,
    toTech,
    mappings,
    plan,
    referenceArchitecture: referenceAnalysis
      ? {
          folders: referenceAnalysis.folders,
          sharedComponents: referenceAnalysis.sharedComponents,
          services: referenceAnalysis.services,
          guards: referenceAnalysis.guards,
          interceptors: referenceAnalysis.interceptors,
          styling: referenceAnalysis.styling,
        }
      : null,
  };
}