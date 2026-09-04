import { Router } from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { upload } from '../middleware/upload.js';
import { validateProjectFramework } from '../services/validator.js';
import { removeDirectoryRecursive, removeFile, ensureDirectoryExists } from '../utils/file.js';
import { EXTRACT_DIR, UPLOAD_DIR, getProviderIds, PROVIDERS } from '../config/index.js';
import { runMigrationPipeline, runReworkPipeline, ConversionPausedError, AllProvidersRateLimitedError, readCheckpoint, clearCheckpoint } from '../services/migration.js';
import { analyzeSourceProject, analyzeReferenceProject, buildMigrationPlan } from '../services/analyzer.js';

// Ensure the extract and upload directories exist at startup
ensureDirectoryExists(EXTRACT_DIR);
ensureDirectoryExists(UPLOAD_DIR);

/**
 * Clear leftover uploads and extracted work that does not belong to a live project.
 *
 * A live created project (anything matching {sessionId}-project.json) is kept.
 * Those artifacts can only be removed via DELETE /api/project/:sessionId.
 *
 * @param {string[]} [keepUploadPaths] - Upload files to keep (the ZIP just received).
 */
function clearWorkFolders(keepUploadPaths = []) {
  if (fs.existsSync(EXTRACT_DIR)) {
    try {
      const liveSessions = new Set(
        fs.readdirSync(EXTRACT_DIR)
          .filter((name) => name.endsWith('-project.json'))
          .map((name) => name.replace(/-project\.json$/, ''))
      );
      const items = fs.readdirSync(EXTRACT_DIR);
      for (const item of items) {
        const isLive =
          liveSessions.has(item) ||
          [...liveSessions].some((id) => item.startsWith(`${id}-`));
        if (isLive) continue;
        const fullPath = path.join(EXTRACT_DIR, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (err) {
      console.warn('[Cleanup] Failed to clear extracted/:', err.message);
    }
  }

  if (fs.existsSync(UPLOAD_DIR)) {
    try {
      const keep = new Set(
        keepUploadPaths.filter(Boolean).map((p) => path.resolve(p).toLowerCase())
      );
      for (const name of fs.readdirSync(UPLOAD_DIR)) {
        const fullPath = path.join(UPLOAD_DIR, name);
        if (keep.has(path.resolve(fullPath).toLowerCase())) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (err) {
      console.warn('[Cleanup] Failed to clear uploads/:', err.message);
    }
  }

  console.log('[Cleanup] Cleared leftover uploads and extracted folders (live projects kept)');
}

clearWorkFolders();

/**
 * Validates a sessionId supplied via the URL so it cannot escape EXTRACT_DIR
 * (e.g. "../../outside") via path.join. Only safe id-like strings pass.
 */
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !id.includes('..');
}

/**
 * Reads the project name from a converted workspace's package.json.
 * Standard migrated workspaces surface as "Migrated Angular/React Project".
 */
function deriveProjectName(convertedPath, toTech) {
  try {
    const pkgPath = path.join(convertedPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) {
        const name = pkg.name.trim();
        if (/^migrated-react-project$/i.test(name)) return 'Migrated React Project';
        if (/^migrated-angular-project$/i.test(name)) return 'Migrated Angular Project';
        return name;
      }
    }
  } catch {
    /* ignore */
  }
  const tech = String(toTech || '').toLowerCase();
  if (tech.includes('react')) return 'Migrated React Project';
  if (tech.includes('angular')) return 'Migrated Angular Project';
  return `${toTech || 'Migrated'} Project`;
}

/**
 * Persist lightweight project metadata to disk so a previously-created
 * project survives server restarts and the UI can detect it on first load.
 */
function getProjectMetaPath(sessionId) {
  return path.join(EXTRACT_DIR, `${sessionId}-project.json`);
}

function readProjectMeta(sessionId) {
  try {
    const raw = fs.readFileSync(getProjectMetaPath(sessionId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeProjectMeta(sessionId, meta) {
  try {
    fs.writeFileSync(getProjectMetaPath(sessionId), JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[project] Failed to persist meta for ${sessionId}:`, err.message);
  }
}

function resumeInfo(sessionId, meta = {}) {
  const cp = readCheckpoint(sessionId) || {};
  const live = sessionStatus.get(sessionId);
  const unitTotal = (Array.isArray(cp.units) && cp.units.length) || meta.unitTotal || 0;
  const completedUnitIndex = cp.completedUnitIndex ?? meta.completedUnitIndex ?? -1;
  const running = live && (live.status === 'queued' || live.status === 'running');
  const resumable =
    !running &&
    unitTotal > 0 &&
    completedUnitIndex < unitTotal - 1;
  return {
    resumable,
    paused: Boolean(cp.paused || meta.paused || live?.status === 'paused') && resumable,
    completedUnitIndex,
    unitTotal,
  };
}

function isResumablePauseError(sessionId, error) {
  if (error instanceof ConversionPausedError) return true;
  if (!(error instanceof AllProvidersRateLimitedError)) return false;
  const cp = readCheckpoint(sessionId);
  return Array.isArray(cp?.units) && cp.units.length > 0;
}

function markSessionPaused(sessionId, error, extra = {}) {
  const cp = readCheckpoint(sessionId) || {};
  const errMsg = error?.message || 'Free-tier limit reached. Progress is saved.';
  const completedUnitIndex = error?.completedUnitIndex ?? cp.completedUnitIndex ?? -1;
  const unitTotal = error?.unitTotal || cp.units?.length || 0;
  setSession(sessionId, {
    status: 'paused',
    message: errMsg,
    phase: 'paused',
    error: errMsg,
    unitIndex: completedUnitIndex + 1,
    unitTotal,
  });
  writeProjectMeta(sessionId, {
    sessionId,
    fromTech: extra.fromTech,
    toTech: extra.toTech,
    aiProvider: extra.aiProvider,
    aiModel: extra.aiModel,
    projectName: extra.projectName || deriveProjectName(extra.convertedPath, extra.toTech),
    createdAt: extra.createdAt || Date.now(),
    updatedAt: Date.now(),
    resumable: true,
    paused: true,
    completedUnitIndex,
    unitTotal,
  });
  console.warn(`[${sessionId}] Conversion paused (resumable):`, errMsg);
}

/**
 * In-memory map of session IDs to their final ZIP paths.
 * Populated when a migration completes successfully so the
 * GET /api/download/:sessionId endpoint can serve downloads.
 * @type {Map<string, string>}
 */
const sessionDownloads = new Map();

/**
 * Sessions whose last migration/rework attempt failed. The generated project
 * stays on disk and can still be downloaded as long as the converted folder
 * exists — only the explicit "Clear" action deletes it.
 */
const sessionFailed = new Set();

/**
 * Live migration job status for async POST /migrate + GET /migrate/:id/status.
 * @typedef {{
 *   status: 'queued' | 'running' | 'completed' | 'failed' | 'paused',
 *   message: string,
 *   phase?: string,
 *   unitIndex?: number,
 *   unitTotal?: number,
 *   error?: string,
 *   startedAt: number,
 *   updatedAt: number,
 *   zipPath?: string,
 *   zipFile?: string,
 *   extractPath?: string,
 *   convertedPath?: string,
 * }} SessionStatus
 * @type {Map<string, SessionStatus>}
 */
const sessionStatus = new Map();

const SESSION_TTL_MS = 60 * 60 * 1000;

function setSession(id, patch) {
  const prev = sessionStatus.get(id) || {
    status: 'queued',
    message: 'Queued',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const next = {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
    startedAt: prev.startedAt || Date.now(),
  };
  sessionStatus.set(id, next);
  return next;
}

function scheduleSessionExpiry(id) {
  setTimeout(() => {
    sessionDownloads.delete(id);
    sessionFailed.delete(id);
    sessionStatus.delete(id);
  }, SESSION_TTL_MS);
}

const router = Router();

/**
 * POST /api/upload
 * Accepts a ZIP file (field: 'projectZip'), extracts it, validates the
 * extracted project against the expected source framework, and returns
 * session metadata.
 *
 * Body fields:
 *   - projectZip (file, required): The uploaded ZIP
 *   - fromTech (string, optional): Expected source framework (Angular / React)
 *   - toTech   (string, optional): Target framework
 *   - prompt   (string, optional): Additional user prompt
 */
router.post('/upload', upload.single('projectZip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a valid ZIP file.' });
  }

  // Drop leftover uploads/extracts before this new extraction
  clearWorkFolders([req.file.path]);

  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';
  const prompt = req.body.prompt || '';

  console.log(`\nNew Migration Request Received!`);
  console.log(`Pipeline Path: Converting from [${fromTech}] to [${toTech}]`);
  console.log(`User Prompt: ${prompt}`);
  console.log(`File Saved As: ${req.file.filename}`);

  const sourceZipPath = req.file.path;
  const projectSessionName = path.parse(req.file.filename).name;
  const currentTargetExtractPath = path.join(EXTRACT_DIR, projectSessionName);

  try {
    let zip;
    try {
      zip = new AdmZip(sourceZipPath);
    } catch (zipError) {
      console.error('ZIP read error:', zipError);
      removeDirectoryRecursive(currentTargetExtractPath);
      removeFile(sourceZipPath);

      const errorMsg = zipError.message || 'Unknown ZIP error';
      if (errorMsg.includes('Invalid filename')) {
        return res.status(400).json({
          error: 'The uploaded ZIP file contains entries with invalid filenames. Please re-create your ZIP file avoiding special characters in file/folder names (e.g., colons, backslashes, or absolute paths).'
        });
      }
      return res.status(400).json({ error: 'Could not read the uploaded ZIP file. Ensure it is a valid, non-corrupted ZIP archive.' });
    }

    try {
      zip.extractAllTo(currentTargetExtractPath, true);
    } catch (extractError) {
      console.error('Extraction error:', extractError);
      removeDirectoryRecursive(currentTargetExtractPath);
      removeFile(sourceZipPath);
      return res.status(400).json({
        error: 'Could not extract the ZIP file. The archive may contain invalid entries or be corrupted. Please re-create your ZIP file.'
      });
    }

    console.log(`Extracted to: ${currentTargetExtractPath}`);

    const validation = validateProjectFramework(currentTargetExtractPath, fromTech);

    if (!validation.valid) {
      console.error(`Validation failed: ${validation.reason}`);
      removeDirectoryRecursive(currentTargetExtractPath);
      removeFile(sourceZipPath);
      return res.status(400).json({ error: `Project validation failed: ${validation.reason}` });
    }

    console.log(`Project validated as ${fromTech}.`);

    res.json({
      message: `Workspace successfully unpacked! Ready to migrate from ${fromTech} to ${toTech}.`,
      sessionId: projectSessionName,
      extractedLocation: currentTargetExtractPath,
      fromTech,
      toTech
    });
  } catch (error) {
    console.error('Extraction error:', error);
    removeDirectoryRecursive(currentTargetExtractPath);
    removeFile(sourceZipPath);
    res.status(500).json({ error: 'Failed to extract package files.' });
  }
});

/**
 * POST /api/analyze
 * Analyzes the uploaded source project (and optional reference project)
 * WITHOUT running the AI migration. Returns the source analysis, reference
 * architecture, and a migration plan preview. This is the "Analyzer" stage
 * from the ChatGPT workflow.
 *
 * Body fields:
 *   - zipFile (file, required): The uploaded ZIP of the source project
 *   - referenceZip (file, optional): The uploaded ZIP of the reference project
 *   - fromTech (string, optional): Source framework
 *   - toTech   (string, optional): Target framework
 */
router.post('/analyze', upload.fields([{ name: 'zipFile', maxCount: 1 }, { name: 'referenceZip', maxCount: 1 }]), (req, res) => {
  const zipFile = req.files?.zipFile?.[0];
  const referenceZip = req.files?.referenceZip?.[0];
  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';

  if (!zipFile) {
    return res.status(400).json({ error: 'Please upload a valid source project ZIP.' });
  }

  const id = `analyze-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const extractPath = path.join(EXTRACT_DIR, id);
  ensureDirectoryExists(extractPath);

  try {
    const zip = new AdmZip(zipFile.path);
    zip.extractAllTo(extractPath, true);
    const sourceAnalysis = analyzeSourceProject(extractPath);

    let referenceAnalysis = null;
    if (referenceZip) {
      const refExtractPath = path.join(EXTRACT_DIR, `${id}-reference`);
      ensureDirectoryExists(refExtractPath);
      try {
        const refZip = new AdmZip(referenceZip.path);
        refZip.extractAllTo(refExtractPath, true);
        referenceAnalysis = analyzeReferenceProject(refExtractPath);
      } catch (refErr) {
        console.warn(`[analyze] Failed to analyze reference project: ${refErr.message}`);
      }
    }

    const planPreview = buildMigrationPlan(sourceAnalysis, referenceAnalysis, fromTech, toTech);

    // Clean up temp extraction
    removeDirectoryRecursive(extractPath);
    if (referenceZip) removeFile(referenceZip.path);
    removeFile(zipFile.path);

    res.json({
      sessionId: id,
      fromTech,
      toTech,
      sourceAnalysis: {
        framework: sourceAnalysis.framework,
        fileCount: sourceAnalysis.fileCount,
        fileTree: sourceAnalysis.fileTree,
        components: sourceAnalysis.components,
        services: sourceAnalysis.services,
        routes: sourceAnalysis.routes,
        hooks: sourceAnalysis.hooks,
        contexts: sourceAnalysis.contexts,
      },
      referenceAnalysis: referenceAnalysis ? {
        framework: referenceAnalysis.framework,
        fileCount: referenceAnalysis.fileCount,
        folders: referenceAnalysis.folders,
        sharedComponents: referenceAnalysis.sharedComponents,
        services: referenceAnalysis.services,
        guards: referenceAnalysis.guards,
        interceptors: referenceAnalysis.interceptors,
        styling: referenceAnalysis.styling,
      } : null,
      migrationPlan: planPreview,
    });
  } catch (error) {
    removeDirectoryRecursive(extractPath);
    if (referenceZip) removeFile(referenceZip.path);
    removeFile(zipFile.path);
    console.error(`[analyze] Analysis failed:`, error);
    res.status(500).json({ error: `Analysis failed: ${error.message}` });
  }
});

/**
 * POST /api/analyze/:sessionId
 * Analyzes an already-extracted session by its sessionId. No file upload
 * required — uses the source files already on disk from the upload step.
 *
 * Body fields:
 *   - referenceZip (file, optional): The uploaded ZIP of the reference project
 *   - fromTech (string, optional): Source framework
 *   - toTech   (string, optional): Target framework
 */
router.post('/analyze/:sessionId', upload.single('referenceZip'), (req, res) => {
  const { sessionId } = req.params;
  const referenceZip = req.file;
  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const extractPath = path.join(EXTRACT_DIR, sessionId);
  if (!fs.existsSync(extractPath)) {
    return res.status(404).json({ error: `Session "${sessionId}" not found or already cleaned up.` });
  }

  try {
    const sourceAnalysis = analyzeSourceProject(extractPath);

    let referenceAnalysis = null;
    if (referenceZip) {
      const refExtractPath = path.join(EXTRACT_DIR, `${sessionId}-reference`);
      ensureDirectoryExists(refExtractPath);
      try {
        const refZip = new AdmZip(referenceZip.path);
        refZip.extractAllTo(refExtractPath, true);
        referenceAnalysis = analyzeReferenceProject(refExtractPath);
      } catch (refErr) {
        console.warn(`[analyze] Failed to analyze reference project: ${refErr.message}`);
      }
    }

    const planPreview = buildMigrationPlan(sourceAnalysis, referenceAnalysis, fromTech, toTech);

    res.json({
      sessionId,
      fromTech,
      toTech,
      sourceAnalysis: {
        framework: sourceAnalysis.framework,
        fileCount: sourceAnalysis.fileCount,
        fileTree: sourceAnalysis.fileTree,
        components: sourceAnalysis.components,
        services: sourceAnalysis.services,
        routes: sourceAnalysis.routes,
        hooks: sourceAnalysis.hooks,
        contexts: sourceAnalysis.contexts,
      },
      referenceAnalysis: referenceAnalysis ? {
        framework: referenceAnalysis.framework,
        fileCount: referenceAnalysis.fileCount,
        folders: referenceAnalysis.folders,
        sharedComponents: referenceAnalysis.sharedComponents,
        services: referenceAnalysis.services,
        guards: referenceAnalysis.guards,
        interceptors: referenceAnalysis.interceptors,
        styling: referenceAnalysis.styling,
      } : null,
      migrationPlan: planPreview,
    });
  } catch (error) {
    console.error(`[analyze] Analysis failed for session ${sessionId}:`, error);
    res.status(500).json({ error: `Analysis failed: ${error.message}` });
  }
});

/**
 * GET /api/download/:sessionId
 * Download the ZIP of a created project by its session ID. Works for
 * completed AND failed sessions alike, as long as the generated project
 * still exists on disk (it is only removed via the "Clear" action).
 */
router.get('/download/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);

  // A failed session is only non-downloadable when the migration never
  // produced a converted project. If the generated project exists on disk it
  // is served — the server NEVER deletes generated projects on error; only the
  // explicit "Clear Extracted Folder" action removes them.
  if (sessionFailed.has(sessionId) && !fs.existsSync(convertedPath)) {
    const failed = sessionStatus.get(sessionId);
    return res.status(410).json({
      error: failed?.error
        || `Session "${sessionId}" failed during migration and no project was generated. Please re-upload and try again.`,
    });
  }

  const live = sessionStatus.get(sessionId);
  if (live && (live.status === 'queued' || live.status === 'running')) {
    return res.status(409).json({
      error: 'Migration is still running. Please wait until it completes.',
      status: live.status,
      message: live.message,
    });
  }

  if (!fs.existsSync(convertedPath)) {
    return res.status(404).json({
      error: `Session "${sessionId}" not found or already downloaded/cleaned up. Please re-upload and try again.`,
    });
  }

  // Always create a fresh ZIP on demand, excluding node_modules.
  // The temp ZIP is auto-deleted after the download finishes to save disk space.
  const tempZipPath = path.join(EXTRACT_DIR, `${sessionId}-download.zip`);

  try {
    console.log(`[${sessionId}] Creating download ZIP (excluding node_modules)...`);
    const zip = new AdmZip();

    // Recursively add files, skipping node_modules directories
    function addFolderToZip(dirPath, zipInstance, basePath) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const fullPath = path.join(dirPath, entry.name);
        const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          addFolderToZip(fullPath, zipInstance, relPath);
        } else {
          zipInstance.addLocalFile(fullPath, path.dirname(relPath));
        }
      }
    }

    addFolderToZip(convertedPath, zip, '');
    zip.writeZip(tempZipPath);
    console.log(`[${sessionId}] Fresh ZIP created → ${tempZipPath}`);
  } catch (err) {
    console.error(`[${sessionId}] Failed to create download ZIP:`, err);
    return res.status(500).json({ error: 'Failed to create project ZIP. Please try again.' });
  }

  res.download(tempZipPath, 'migrated_project.zip', (err) => {
    // Always clean up the temp ZIP after download finishes (or fails)
    try {
      if (fs.existsSync(tempZipPath)) {
        fs.unlinkSync(tempZipPath);
        console.log(`[${sessionId}] Temp download ZIP deleted → ${tempZipPath}`);
      }
    } catch (cleanupErr) {
      console.warn(`[${sessionId}] Failed to delete temp ZIP:`, cleanupErr.message);
    }

    if (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('aborted')) {
        console.warn(`[${sessionId}] Download aborted (client disconnected).`);
      } else {
        console.error(`[${sessionId}] Download error:`, err);
      }
    } else {
      console.log(`[${sessionId}] Download complete.`);
    }
  });
});

/**
 * GET /api/visual-qa/:sessionId
 * Returns the persisted Visual QA report JSON for a completed migration.
 * The report is written to disk by the visual QA stage in visualQa.js.
 */
router.get('/visual-qa/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }
  const qaDir = path.join(EXTRACT_DIR, `${sessionId}-visual-qa`);
  const reportPath = path.join(qaDir, 'visual-qa-report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({
      error: `No visual QA report found for session "${sessionId}".`,
    });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    // Paths must be relative to the QA dir — GET /files/:sessionId/:filePath
    // already joins under {sessionId}-visual-qa/.
    const toRelativeUrl = (p) => {
      if (!p) return null;
      const abs = path.resolve(String(p));
      let rel = path.relative(qaDir, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) {
        rel = path.basename(abs);
      }
      return `/api/files/${sessionId}/${rel}`;
    };
    const enriched = {
      ...report,
      comparisons: (report.comparisons || []).map((c) => ({
        ...c,
        sourceImage: c.sourceImage ? toRelativeUrl(c.sourceImage) : null,
        migratedImage: c.migratedImage ? toRelativeUrl(c.migratedImage) : null,
        diffImage: c.diffImage ? toRelativeUrl(c.diffImage) : null,
      })),
    };
    res.json(enriched);
  } catch (err) {
    console.error(`[visual-qa] Failed to read report:`, err);
    res.status(500).json({ error: 'Failed to read visual QA report.' });
  }
});

/**
 * GET /api/files/:sessionId/:filePath(*)
 * Serves screenshot image assets from a session's visual-qa output directory.
 */
router.get('/files/:sessionId/:filePath(.*)', (req, res) => {
  const { sessionId, filePath } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }
  const qaDir = path.join(EXTRACT_DIR, `${sessionId}-visual-qa`);
  const fullPath = path.join(qaDir, filePath);
  // Prevent path traversal outside the QA dir
  if (!fullPath.startsWith(qaDir + path.sep) && fullPath !== qaDir) {
    return res.status(400).json({ error: 'Invalid file path.' });
  }
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found.' });
  }
  res.sendFile(fullPath);
});

/**
 * GET /api/migrate/:sessionId/status
 * Poll migration progress for an async job started by POST /migrate.
 */
router.get('/migrate/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const live = sessionStatus.get(sessionId);

  if (!live) {
    if (sessionFailed.has(sessionId)) {
      return res.json({
        sessionId,
        status: 'failed',
        message: 'Migration failed.',
        error: 'Session failed and is no longer available.',
      });
    }
    if (sessionDownloads.has(sessionId)) {
      return res.json({
        sessionId,
        status: 'completed',
        message: 'Migration complete. Ready to download.',
        downloadUrl: `/api/download/${sessionId}`,
      });
    }
    const meta = readProjectMeta(sessionId) || {};
    const info = resumeInfo(sessionId, meta);
    if (info.resumable) {
      return res.json({
        sessionId,
        status: 'paused',
        message: 'Free-tier limit reached. Progress is saved. Click Continue to resume.',
        phase: 'paused',
        resumable: true,
        unitIndex: info.completedUnitIndex + 1,
        unitTotal: info.unitTotal,
        completedUnitIndex: info.completedUnitIndex,
      });
    }
    return res.status(404).json({ error: `Session "${sessionId}" not found.` });
  }

  const payload = {
    sessionId,
    status: live.status,
    message: live.message,
    phase: live.phase || null,
    unitIndex: live.unitIndex ?? null,
    unitTotal: live.unitTotal ?? null,
    startedAt: live.startedAt,
    updatedAt: live.updatedAt,
    elapsedMs: Date.now() - live.startedAt,
  };

  if (live.status === 'completed') {
    payload.downloadUrl = `/api/download/${sessionId}`;
  }
  if (live.status === 'failed') {
    payload.error = live.error || 'Migration failed.';
  }
  if (live.status === 'paused') {
    payload.resumable = true;
    payload.error = live.error || live.message;
    payload.completedUnitIndex = Math.max(-1, (live.unitIndex || 1) - 1);
  }

  return res.json(payload);
});

/**
 * POST /api/migrate
 * Starts the AI migration pipeline asynchronously.
 * Returns 202 + sessionId immediately; poll GET /migrate/:sessionId/status,
 * then download via GET /download/:sessionId when status is completed.
 *
 * Body fields:
 *   - zipFile (file, required): The uploaded ZIP of the source project
 *   - prompt (string, required): Migration instructions
 *   - fromTech (string, optional): Source framework (Angular / React / Vue)
 *   - toTech   (string, optional): Target framework
 *   - aiProvider (string, optional): AI provider (e.g. 'openrouter', 'genai')
 *   - aiModel   (string, optional): AI model override
 *   - targetVersion (string, optional): Explicit target major version (e.g. '22', '19')
 *   - sessionId (string, optional): Client-provided session id
 */
router.post('/migrate', upload.fields([{ name: 'zipFile', maxCount: 1 }, { name: 'referenceZip', maxCount: 1 }]), async (req, res) => {
  const userPrompt = (req.body.prompt || '').trim();
  const zipFile = req.files?.zipFile?.[0];
  const referenceZip = req.files?.referenceZip?.[0];
  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';
  const aiProvider = (req.body.aiProvider || '').trim();
  const aiModel = req.body.aiModel || '';
  const targetVersion = (req.body.targetVersion || '').trim();
  const priorityRulesMode = (req.body.priorityRulesMode || 'react-ui').trim();
  const enableVisualQa = String(req.body.enableVisualQa || '').toLowerCase() === 'true';
  const visualQaRoutes = (req.body.visualQaRoutes || '/').split(',').map((r) => r.trim()).filter(Boolean);

  if (!zipFile || !userPrompt) {
    return res.status(400).json({ error: 'ZIP file and migration prompt are required.' });
  }
  if (!fromTech || fromTech === 'Unknown' || !toTech || toTech === 'Unknown') {
    return res.status(400).json({ error: 'Both source and target frameworks are required.' });
  }
  if (!aiProvider) {
    return res.status(400).json({ error: 'Please select an AI provider.' });
  }
  if (!PROVIDERS[aiProvider]) {
    return res.status(400).json({
      error: `Unknown AI provider "${aiProvider}". Valid options: ${getProviderIds().join(', ')}.`,
    });
  }

  const id = req.body.sessionId || `mig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const extractPath = path.join(EXTRACT_DIR, id);
  const convertedPath = path.join(EXTRACT_DIR, `${id}-converted`);
  const outputZipPath = path.join(EXTRACT_DIR, `${id}-final.zip`);

  clearWorkFolders([zipFile.path, referenceZip?.path].filter(Boolean));

  // Quick pre-check: unpack just enough to validate source framework before spending AI tokens
  const preExtractPath = path.join(EXTRACT_DIR, `${id}-precheck`);
  try {
    ensureDirectoryExists(preExtractPath);
    let zip;
    try {
      zip = new AdmZip(zipFile.path);
    } catch (zipError) {
      removeDirectoryRecursive(preExtractPath);
      removeFile(zipFile?.path);
      sessionFailed.add(id);

      const errorMsg = zipError.message || 'Unknown ZIP error';
      if (errorMsg.includes('Invalid filename')) {
        console.error(`[${id}] Pre-validation failed: ZIP contains invalid filenames.`, errorMsg);
        return res.status(400).json({
          error: 'The uploaded ZIP file contains entries with invalid filenames. Please re-create your ZIP file avoiding special characters in file/folder names (e.g., colons, backslashes, or absolute paths).'
        });
      }
      console.error(`[${id}] Pre-validation failed: Could not read ZIP.`, zipError);
      return res.status(400).json({ error: 'Could not read the uploaded ZIP file. Ensure it is a valid, non-corrupted ZIP archive.' });
    }

    try {
      zip.extractAllTo(preExtractPath, true);
    } catch (extractError) {
      removeDirectoryRecursive(preExtractPath);
      removeFile(zipFile?.path);
      sessionFailed.add(id);
      console.error(`[${id}] Pre-validation failed: Could not extract ZIP.`, extractError);
      return res.status(400).json({
        error: 'Could not extract the ZIP file. The archive may contain invalid entries or be corrupted. Please re-create your ZIP file.'
      });
    }

    const validation = validateProjectFramework(preExtractPath, fromTech);
    removeDirectoryRecursive(preExtractPath);

    if (!validation.valid) {
      removeFile(zipFile.path);
      sessionFailed.add(id);
      return res.status(400).json({ error: `Project validation failed: ${validation.reason}` });
    }
  } catch (error) {
    removeDirectoryRecursive(preExtractPath);
    removeFile(zipFile?.path);
    sessionFailed.add(id);
    console.error(`[${id}] Pre-validation failed:`, error);
    return res.status(400).json({ error: 'Could not validate the uploaded ZIP. Ensure it is a valid project archive.' });
  }

  setSession(id, {
    status: 'queued',
    message: 'Upload validated. Migration queued...',
    phase: 'queued',
    zipFile: zipFile.path,
    extractPath,
    convertedPath,
  });
  scheduleSessionExpiry(id);

  // Persist project meta EARLY so the project survives clearWorkFolders()
  // even if the migration fails or the server restarts before completion.
  writeProjectMeta(id, {
    sessionId: id,
    fromTech,
    toTech,
    aiProvider,
    aiModel,
    projectName: deriveProjectName(convertedPath, toTech),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Return immediately — do not hold the HTTP request open for the whole pipeline
  res.status(202).json({
    sessionId: id,
    status: 'queued',
    message: 'Migration started. Poll /api/migrate/:sessionId/status for progress.',
    statusUrl: `/api/migrate/${id}/status`,
    downloadUrl: `/api/download/${id}`,
  });

  // Background job
  setImmediate(async () => {
    try {
      setSession(id, {
        status: 'running',
        message: 'Starting migration pipeline...',
        phase: 'starting',
      });

      const resultZipPath = await runMigrationPipeline(
        zipFile.path,
        userPrompt,
        id,
        {
          fromTech,
          toTech,
          aiProvider,
          aiModel: aiModel || undefined,
          targetVersion: targetVersion || undefined,
          referenceZipPath: referenceZip ? referenceZip.path : null,
          priorityRulesMode,
          enableVisualQa,
          visualQaRoutes,
          onProgress: (progress) => {
            setSession(id, {
              status: 'running',
              message: progress.message || 'Migrating...',
              phase: progress.phase || 'running',
              unitIndex: progress.unitIndex,
              unitTotal: progress.unitTotal,
            });
          },
        }
      );

      sessionDownloads.set(id, resultZipPath);
      setSession(id, {
        status: 'completed',
        message: 'Migration complete. Ready to download.',
        phase: 'completed',
        zipPath: resultZipPath,
      });
      writeProjectMeta(id, {
        sessionId: id,
        fromTech,
        toTech,
        aiProvider,
        aiModel,
        projectName: deriveProjectName(convertedPath, toTech),
        referencePath: referenceZip ? referenceZip.path : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resumable: false,
        paused: false,
      });
      console.log(`[${id}] Migration completed asynchronously. Download at GET /api/download/${id}`);
      if (zipFile?.path) removeFile(zipFile.path);
      if (referenceZip?.path) removeFile(referenceZip.path);
    } catch (error) {
      if (isResumablePauseError(id, error)) {
        markSessionPaused(id, error, { fromTech, toTech, aiProvider, aiModel, convertedPath });
        if (zipFile?.path) removeFile(zipFile.path);
        if (referenceZip?.path) removeFile(referenceZip.path);
        return;
      }
      sessionFailed.add(id);
      const errMsg = error?.message || 'The Agentic processing loop failed.';
      setSession(id, {
        status: 'failed',
        message: 'Migration failed.',
        phase: 'failed',
        error: errMsg,
      });
      console.error(`[${id}] Migration pipeline failed:`, error);

      // NEVER auto-delete the generated project on error. Whatever the AI
      // produced so far stays on disk (extracted source + converted project +
      // any ZIPs) so the user can download it, inspect it, or fix it through
      // the changes/errors interface. Only the temporary uploaded source ZIP
      // is removed here. Everything else is cleared exclusively via
      // DELETE /api/project/:sessionId — the "Clear Extracted Folder" button.
      if (zipFile?.path) removeFile(zipFile.path);

      // Persist project meta so the (possibly partial) project is recognized
      // as live: it survives the startup/upload cleanup, shows in
      // /api/project/latest, and keeps supporting downloads + rework.
      writeProjectMeta(id, {
        sessionId: id,
        fromTech,
        toTech,
        aiProvider,
        aiModel,
        projectName: deriveProjectName(convertedPath, toTech),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        migrationError: errMsg,
      });
    }
  });
});

/**
 * GET /api/project/latest
 * Returns the most recently created project that still exists on disk,
 * or { exists: false } when there is none. Lets the UI choose between the
 * creation form and the follow-up (changes/errors) interface on first load.
 */
router.get('/project/latest', (req, res) => {
  let latest = null;
  let latestTime = 0;
  let files = [];
  try {
    files = fs.readdirSync(EXTRACT_DIR);
  } catch {
    /* ignore */
  }
  for (const name of files) {
    if (!name.endsWith('-project.json')) continue;
    const sessionId = name.replace(/-project\.json$/, '');
    const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
    if (!fs.existsSync(convertedPath)) continue;
    const meta = readProjectMeta(sessionId);
    if (!meta) continue;
    const t = Number(meta.updatedAt) || Number(meta.createdAt) || 0;
    if (t >= latestTime) {
      latestTime = t;
      latest = {
        exists: true,
        sessionId,
        projectName: meta.projectName || sessionId,
        fromTech: meta.fromTech || 'Unknown',
        toTech: meta.toTech || 'Unknown',
        aiProvider: meta.aiProvider || '',
        aiModel: meta.aiModel || '',
        createdAt: meta.createdAt || null,
        updatedAt: meta.updatedAt || null,
        ...resumeInfo(sessionId, meta),
      };
    }
  }
  res.json(latest || { exists: false });
});

/**
 * GET /api/project/:sessionId
 * Returns whether a specific project session still exists on disk.
 */
router.get('/project/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }
  const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
  if (!fs.existsSync(convertedPath)) {
    return res.json({ exists: false, sessionId });
  }
  const meta = readProjectMeta(sessionId) || {};
  res.json({
    exists: true,
    sessionId,
    projectName: meta.projectName || sessionId,
    fromTech: meta.fromTech || 'Unknown',
    toTech: meta.toTech || 'Unknown',
    aiProvider: meta.aiProvider || '',
    aiModel: meta.aiModel || '',
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
    ...resumeInfo(sessionId, meta),
  });
});

/**
 * POST /api/project/:sessionId/resume
 * Continues a conversion paused by a free-tier 429. No new ZIP required.
 * Body: { aiProvider?: string, aiModel?: string }
 */
router.post('/project/:sessionId/resume', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const checkpoint = readCheckpoint(sessionId);
  if (!checkpoint || !Array.isArray(checkpoint.units) || checkpoint.units.length === 0) {
    return res.status(400).json({
      error: 'Nothing to resume. Start a new conversion.',
    });
  }

  const extractPath = path.join(EXTRACT_DIR, sessionId);
  const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
  if (!fs.existsSync(extractPath) || !fs.existsSync(convertedPath)) {
    return res.status(404).json({
      error: `No paused conversion found for session "${sessionId}".`,
    });
  }

  const live = sessionStatus.get(sessionId);
  if (live && (live.status === 'queued' || live.status === 'running')) {
    return res.status(409).json({
      error: 'Conversion is already running for this project.',
      status: live.status,
      message: live.message,
    });
  }

  const meta = readProjectMeta(sessionId) || {};
  const fromTech = checkpoint.fromTech || meta.fromTech || 'Unknown';
  const toTech = checkpoint.toTech || meta.toTech || 'Unknown';
  const aiProvider = (req.body.aiProvider || checkpoint.aiProvider || meta.aiProvider || 'genai').trim();
  const aiModel = req.body.aiModel || checkpoint.aiModel || meta.aiModel || '';
  const userPrompt = checkpoint.userPrompt || '';
  const targetVersion = checkpoint.targetVersion || '';
  const priorityRulesMode = checkpoint.priorityRulesMode || 'react-ui';

  sessionFailed.delete(sessionId);
  sessionDownloads.delete(sessionId);

  setSession(sessionId, {
    status: 'queued',
    message: 'Resuming conversion...',
    phase: 'queued',
    zipFile: null,
    extractPath,
    convertedPath,
  });
  scheduleSessionExpiry(sessionId);

  writeProjectMeta(sessionId, {
    ...meta,
    sessionId,
    fromTech,
    toTech,
    aiProvider,
    aiModel,
    updatedAt: Date.now(),
    resumable: true,
    paused: false,
    completedUnitIndex: checkpoint.completedUnitIndex ?? -1,
    unitTotal: checkpoint.units.length,
  });

  res.status(202).json({
    sessionId,
    status: 'queued',
    message: 'Resuming conversion from the last saved unit.',
    statusUrl: `/api/migrate/${sessionId}/status`,
    downloadUrl: `/api/download/${sessionId}`,
  });

  setImmediate(async () => {
    try {
      setSession(sessionId, {
        status: 'running',
        message: 'Resuming conversion from checkpoint...',
        phase: 'resume',
      });

      const resultZipPath = await runMigrationPipeline(null, userPrompt, sessionId, {
        fromTech,
        toTech,
        aiProvider,
        aiModel: aiModel || undefined,
        targetVersion: targetVersion || undefined,
        priorityRulesMode,
        resume: true,
        onProgress: (progress) => {
          setSession(sessionId, {
            status: 'running',
            message: progress.message || 'Migrating...',
            phase: progress.phase || 'running',
            unitIndex: progress.unitIndex,
            unitTotal: progress.unitTotal,
          });
        },
      });

      sessionDownloads.set(sessionId, resultZipPath);
      setSession(sessionId, {
        status: 'completed',
        message: 'Migration complete. Ready to download.',
        phase: 'completed',
        zipPath: resultZipPath,
      });
      writeProjectMeta(sessionId, {
        sessionId,
        fromTech,
        toTech,
        aiProvider,
        aiModel,
        projectName: deriveProjectName(convertedPath, toTech),
        createdAt: meta.createdAt || Date.now(),
        updatedAt: Date.now(),
        resumable: false,
        paused: false,
      });
      console.log(`[${sessionId}] Resume completed. Download at GET /api/download/${sessionId}`);
    } catch (error) {
      if (isResumablePauseError(sessionId, error)) {
        markSessionPaused(sessionId, error, {
          fromTech,
          toTech,
          aiProvider,
          aiModel,
          convertedPath,
          createdAt: meta.createdAt,
        });
        return;
      }
      sessionFailed.add(sessionId);
      const errMsg = error?.message || 'Resume failed.';
      setSession(sessionId, {
        status: 'failed',
        message: 'Migration failed.',
        phase: 'failed',
        error: errMsg,
      });
      console.error(`[${sessionId}] Resume pipeline failed:`, error);
      writeProjectMeta(sessionId, {
        ...meta,
        sessionId,
        fromTech,
        toTech,
        aiProvider,
        aiModel,
        updatedAt: Date.now(),
        migrationError: errMsg,
      });
    }
  });
});

/**
 * POST /api/project/:sessionId/rework
 * Applies user-submitted changes / error fixes to an EXISTING converted
 * project and produces a fresh ZIP. Async: returns 202 immediately, poll
 * GET /api/migrate/:sessionId/status, then download.
 *
 * Body: { prompt: string, aiProvider?: string, aiModel?: string }
 */
router.post('/project/:sessionId/rework', (req, res) => {
  const { sessionId } = req.params;
  const reworkPrompt = (req.body.prompt || '').trim();
  const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }
  if (!reworkPrompt) {
    return res.status(400).json({ error: 'Please describe the changes or errors you want to apply.' });
  }
  const live = sessionStatus.get(sessionId);
  if (live && (live.status === 'queued' || live.status === 'running')) {
    return res.status(409).json({
      error: 'Another change request is already running for this project. Please wait for it to finish.',
      status: live.status,
      message: live.message,
    });
  }
  if (!fs.existsSync(convertedPath)) {
    return res.status(404).json({
      error: `No existing project found for session "${sessionId}". Create a project first.`,
    });
  }

  const meta = readProjectMeta(sessionId) || {};
  const fromTech = meta.fromTech || 'Unknown';
  const toTech = meta.toTech || 'Unknown';
  const aiProvider = (req.body.aiProvider || meta.aiProvider || 'genai').trim();
  const aiModel = req.body.aiModel || meta.aiModel || '';

  setSession(sessionId, {
    status: 'queued',
    message: 'Change request queued...',
    phase: 'queued',
    zipFile: null,
    extractPath: null,
    convertedPath,
  });
  scheduleSessionExpiry(sessionId);

  res.status(202).json({
    sessionId,
    status: 'queued',
    message: 'Applying your changes to the existing project...',
    statusUrl: `/api/migrate/${sessionId}/status`,
    downloadUrl: `/api/download/${sessionId}`,
  });

  setImmediate(async () => {
    try {
      setSession(sessionId, {
        status: 'running',
        message: 'Applying your changes / fixing errors...',
        phase: 'rework-start',
        zipFile: null,
        extractPath: null,
      });

      const resultZipPath = await runReworkPipeline(convertedPath, reworkPrompt, sessionId, {
        toTech,
        aiProvider,
        aiModel,
        referencePath: meta.referencePath || null,
        onProgress: (progress) => {
          setSession(sessionId, {
            status: 'running',
            message: progress.message || 'Applying changes...',
            phase: progress.phase || 'rework',
            zipFile: null,
            extractPath: null,
          });
        },
      });

      sessionDownloads.set(sessionId, resultZipPath);
      setSession(sessionId, {
        status: 'completed',
        message: 'Changes applied. Ready to download.',
        phase: 'completed',
        zipPath: resultZipPath,
        zipFile: null,
        extractPath: null,
      });
      writeProjectMeta(sessionId, {
        ...meta,
        updatedAt: Date.now(),
        aiProvider,
        aiModel,
      });
      console.log(`[${sessionId}] Rework completed. Download at GET /api/download/${sessionId}`);
    } catch (error) {
      sessionFailed.add(sessionId);
      const errMsg = error?.message || 'The AI change-request loop failed.';
      setSession(sessionId, {
        status: 'failed',
        message: 'Change request failed.',
        phase: 'failed',
        error: errMsg,
        zipFile: null,
        extractPath: null,
      });
      console.error(`[${sessionId}] Rework pipeline failed:`, error);
    }
  });
});

/**
 * DELETE /api/project/:sessionId
 * Permanently clears a project (converted dir, ZIPs, metadata, session state).
 */
router.delete('/project/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const live = sessionStatus.get(sessionId);
  if (live && (live.status === 'queued' || live.status === 'running')) {
    return res.status(409).json({
      error: 'Conversion is still running. Wait for it to finish before clearing the project.',
      status: live.status,
      message: live.message,
    });
  }

  const extractPath = path.join(EXTRACT_DIR, sessionId);
  const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
  const finalZip = path.join(EXTRACT_DIR, `${sessionId}-final.zip`);
  const reworkZip = path.join(EXTRACT_DIR, `${sessionId}-rework-final.zip`);
  const metaPath = getProjectMetaPath(sessionId);

  // Full cleanup: extracted source folder + converted project + all ZIPs + meta
  removeDirectoryRecursive(extractPath);
  removeDirectoryRecursive(convertedPath);
  removeFile(finalZip);
  removeFile(reworkZip);
  removeFile(metaPath);
  clearCheckpoint(sessionId);

  sessionDownloads.delete(sessionId);
  sessionFailed.delete(sessionId);
  sessionStatus.delete(sessionId);

  console.log(`[${sessionId}] Project cleared.`);
  res.json({ message: 'Project cleared.', sessionId });
});

export default router;
