import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { ensureDirectoryExists } from '../utils/file.js';

/**
 * Visual QA service — implements the "Visual Verification" stage from the
 * ChatGPT workflow. Captures screenshots of the source and migrated projects,
 * compares them pixel-by-pixel, and produces a report.
 *
 * Uses Puppeteer for browser automation and pixelmatch for image comparison.
 */

const SCREENSHOT_DIR = 'visual-qa';
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 30000;
const SERVER_START_TIMEOUT_MS = 120000;

/**
 * Promise-based execFile wrapper.
 */
function runCommand(cmd, args, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Wait for a dev server to respond on a port.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForServer(port, timeoutMs = SERVER_START_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (res.ok || res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Find a free port on the system.
 * @returns {Promise<number>}
 */
async function findFreePort() {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Start a dev server for a project and return a cleanup function.
 * @param {string} projectPath
 * @param {string} tech - 'angular' | 'react'
 * @param {number} port
 * @returns {Promise<() => void>}
 */
async function startDevServer(projectPath, tech, port) {
  const isAngular = String(tech).toLowerCase().includes('angular');
  const args = isAngular
    ? ['ng', 'serve', '--port', String(port), '--host', '0.0.0.0', '--disable-host-check']
    : ['vite', '--port', String(port), '--host', '0.0.0.0', '--strictPort'];

  const child = spawn('npx', args, {
    cwd: projectPath,
    stdio: 'pipe',
    env: { ...process.env, BROWSER: 'none' },
  });

  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });

  const up = await waitForServer(port);
  if (!up) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    throw new Error(`Dev server failed to start for ${tech} project on port ${port}.\n${output.slice(-2000)}`);
  }

  return () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
}

/**
 * Capture screenshots of a running dev server for the given routes.
 * @param {number} port
 * @param {string[]} routes
 * @param {string} outputDir
 * @param {string} label - prefix for screenshot filenames
 * @returns {Promise<Array<{route: string, imagePath: string}>>}
 */
async function captureScreenshots(port, routes, outputDir, label) {
  ensureDirectoryExists(outputDir);
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const results = [];
  try {
    const page = await browser.newPage();
    await page.setViewport(DEFAULT_VIEWPORT);
    for (const route of routes) {
      const url = `http://localhost:${port}${route}`;
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
        await new Promise((r) => setTimeout(r, 1000));
        const safeName = (route === '/' ? 'home' : route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')) || 'route';
        const imagePath = path.join(outputDir, `${label}-${safeName}.png`);
        await page.screenshot({ path: imagePath, fullPage: true });
        results.push({ route, imagePath });
      } catch (err) {
        console.warn(`[visual-qa] Screenshot failed for ${url}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

/**
 * Compare two screenshots pixel-by-pixel and produce a diff image.
 * @param {string} sourceImage
 * @param {string} migratedImage
 * @param {string} diffImage
 * @returns {Promise<{similarity: number, diffPixels: number, totalPixels: number}>}
 */
async function compareImages(sourceImage, migratedImage, diffImage) {
  const { default: pixelmatch } = await import('pixelmatch');
  const pngjs = await import('pngjs');
  const PNG = pngjs.PNG || pngjs.default?.PNG;

  const img1 = PNG.sync.read(fs.readFileSync(sourceImage));
  const img2 = PNG.sync.read(fs.readFileSync(migratedImage));

  const width = Math.min(img1.width, img2.width);
  const height = Math.min(img1.height, img2.height);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: false,
  });

  fs.writeFileSync(diffImage, PNG.sync.write(diff));

  const totalPixels = width * height;
  const similarity = totalPixels > 0 ? Math.max(0, 1 - diffPixels / totalPixels) : 0;
  return { similarity, diffPixels, totalPixels };
}

/**
 * Run the full visual QA flow: start both dev servers, capture screenshots,
 * compare, and produce a report.
 *
 * @param {object} options
 * @param {string} options.sourcePath - Path to the source project (React)
 * @param {string} options.migratedPath - Path to the migrated project (Angular)
 * @param {string} options.sourceTech - 'react' | 'angular'
 * @param {string} options.migratedTech - 'angular' | 'react'
 * @param {string[]} [options.routes] - Routes to capture (defaults to ['/'])
 * @param {string} [options.outputDir] - Where to store screenshots + report
 * @returns {Promise<object>} Visual QA report
 */
export async function runVisualQa({ sourcePath, migratedPath, sourceTech, migratedTech, routes = ['/'], outputDir }) {
  const dir = outputDir || path.join(process.cwd(), SCREENSHOT_DIR);
  ensureDirectoryExists(dir);

  const sourcePort = await findFreePort();
  const migratedPort = await findFreePort();

  let stopSource = null;
  let stopMigrated = null;

  try {
    // Start both dev servers
    console.log(`[visual-qa] Starting source dev server on port ${sourcePort}...`);
    stopSource = await startDevServer(sourcePath, sourceTech, sourcePort);
    console.log(`[visual-qa] Starting migrated dev server on port ${migratedPort}...`);
    stopMigrated = await startDevServer(migratedPath, migratedTech, migratedPort);

    // Capture screenshots
    console.log(`[visual-qa] Capturing source screenshots for routes: ${routes.join(', ')}`);
    const sourceShots = await captureScreenshots(sourcePort, routes, dir, 'source');
    console.log(`[visual-qa] Capturing migrated screenshots for routes: ${routes.join(', ')}`);
    const migratedShots = await captureScreenshots(migratedPort, routes, dir, 'migrated');

    // Compare each route
    const comparisons = [];
    for (const src of sourceShots) {
      const mig = migratedShots.find((m) => m.route === src.route);
      if (!mig) continue;
      const diffImage = path.join(dir, `diff-${path.basename(src.imagePath).replace(/^source-/, '')}`);
      try {
        const result = await compareImages(src.imagePath, mig.imagePath, diffImage);
        comparisons.push({
          route: src.route,
          sourceImage: src.imagePath,
          migratedImage: mig.imagePath,
          diffImage,
          similarity: Math.round(result.similarity * 100) / 100,
          diffPixels: result.diffPixels,
          totalPixels: result.totalPixels,
          passed: result.similarity >= 0.9,
        });
      } catch (err) {
        console.warn(`[visual-qa] Comparison failed for ${src.route}: ${err.message}`);
        comparisons.push({
          route: src.route,
          sourceImage: src.imagePath,
          migratedImage: mig.imagePath,
          diffImage: null,
          similarity: 0,
          diffPixels: 0,
          totalPixels: 0,
          passed: false,
          error: err.message,
        });
      }
    }

    const passedCount = comparisons.filter((c) => c.passed).length;
    const report = {
      generatedAt: Date.now(),
      sourceTech,
      migratedTech,
      routes: comparisons.map((c) => c.route),
      comparisons,
      summary: {
        total: comparisons.length,
        passed: passedCount,
        failed: comparisons.length - passedCount,
        averageSimilarity: comparisons.length
          ? Math.round((comparisons.reduce((s, c) => s + c.similarity, 0) / comparisons.length) * 100) / 100
          : 0,
      },
    };

    // Persist the report as JSON
    const reportPath = path.join(dir, 'visual-qa-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[visual-qa] Report written to ${reportPath}`);

    return { ...report, reportPath };
  } finally {
    if (stopSource) stopSource();
    if (stopMigrated) stopMigrated();
  }
}