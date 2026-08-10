import { Router } from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { upload } from '../middleware/upload.js';
import { validateProjectFramework } from '../services/validator.js';
import { removeDirectoryRecursive, removeFile, ensureDirectoryExists } from '../utils/file.js';
import { EXTRACT_DIR, UPLOAD_DIR, getProviderIds, PROVIDERS } from '../config/index.js';
import { runMigrationPipeline, runReworkPipeline } from '../services/migration.js';

// Ensure the extract and upload directories exist at startup
ensureDirectoryExists(EXTRACT_DIR);
ensureDirectoryExists(UPLOAD_DIR);

/**
 * Clear leftover contents of the extracted/ folder.
 * Called before each new extraction to ensure a clean slate.
 *
 * IMPORTANT: a live created project is NEVER auto-deleted. Any folder/file
 * belonging to a session that has a persisted {sessionId}-project.json meta
 * file (extracted source, converted project, final ZIPs) is kept on disk.
 * Those artifacts can only be removed via DELETE /api/project/:sessionId
 * (the "Clear Extracted Folder" button in the UI).
 * Note: uploads/ is NOT cleared here because multer saves the file there
 * before this function runs. Individual upload files are cleaned up after processing.
 */
function clearWorkFolders() {
  // Clear extracted folder only (uploads/ is cleaned up individually after processing)
  if (!fs.existsSync(EXTRACT_DIR)) return;
  try {
    // Sessions with a persisted project meta file are "live" created projects.
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
    console.log('[Cleanup] Cleared extracted/ folder (created projects kept)');
  } catch (err) {
    console.warn('[Cleanup] Failed to clear extracted/:', err.message);
  }
}

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
 */
function deriveProjectName(convertedPath, toTech) {
  try {
    const pkgPath = path.join(convertedPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) {
        return pkg.name.trim();
      }
    }
  } catch {
    /* ignore */
  }
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
 *   status: 'queued' | 'running' | 'completed' | 'failed',
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

  // Clear extracted/ folder before starting new extraction
  clearWorkFolders();

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

  let zipPath = sessionDownloads.get(sessionId) || live?.zipPath || null;

  // The in-memory session data expires after SESSION_TTL_MS, but the created
  // project stays on disk until the user clears it. If the cached ZIP path is
  // missing (or its file is gone), re-package the converted project on demand
  // so "Download Latest ZIP" keeps working as long as the project exists.
  if (!zipPath || !fs.existsSync(zipPath)) {
    if (fs.existsSync(convertedPath)) {
      try {
        const rebuilt = path.join(EXTRACT_DIR, `${sessionId}-final.zip`);
        const finalZip = new AdmZip();
        finalZip.addLocalFolder(convertedPath);
        finalZip.writeZip(rebuilt);
        zipPath = rebuilt;
        sessionDownloads.set(sessionId, rebuilt);
        console.log(`[${sessionId}] Regenerated ZIP on demand from converted project → ${rebuilt}`);
      } catch (err) {
        console.error(`[${sessionId}] Failed to regenerate ZIP on demand:`, err);
      }
    }
  }

  if (!zipPath || !fs.existsSync(zipPath)) {
    return res.status(404).json({
      error: `Session "${sessionId}" not found or already downloaded/cleaned up. Please re-upload and try again.`,
    });
  }

  const zipFile = sessionStatus.get(sessionId)?.zipFile || null;

  res.download(zipPath, 'migrated_project.zip', (err) => {
    if (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('aborted')) {
        console.warn(`[${sessionId}] Download aborted (client disconnected). Keeping artifacts.`);
      } else {
        console.error(`[${sessionId}] Download error:`, err);
      }
      return;
    }
    console.log(`[${sessionId}] Download complete.`);
    // The created project is NEVER auto-deleted: the extracted source folder,
    // converted project and final ZIPs all stay on disk so the user can
    // re-download the file and submit follow-up changes/errors at any time.
    // Only the temporary uploaded source ZIP is removed here. Everything is
    // cleared exclusively via DELETE /api/project/:sessionId — the
    // "Clear Extracted Folder" button in the UI.
    if (zipFile) removeFile(zipFile);
  });
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
router.post('/migrate', upload.single('zipFile'), async (req, res) => {
  const userPrompt = (req.body.prompt || '').trim();
  const zipFile = req.file;
  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';
  const aiProvider = (req.body.aiProvider || '').trim();
  const aiModel = req.body.aiModel || '';
  const targetVersion = (req.body.targetVersion || '').trim();

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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      console.log(`[${id}] Migration completed asynchronously. Download at GET /api/download/${id}`);
    } catch (error) {
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
  const aiProvider = (req.body.aiProvider || meta.aiProvider || 'openrouter').trim();
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

  sessionDownloads.delete(sessionId);
  sessionFailed.delete(sessionId);
  sessionStatus.delete(sessionId);

  console.log(`[${sessionId}] Project cleared.`);
  res.json({ message: 'Project cleared.', sessionId });
});

export default router;
