import { Router } from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { upload } from '../middleware/upload.js';
import { validateProjectFramework } from '../services/validator.js';
import { removeDirectoryRecursive, removeFile, ensureDirectoryExists } from '../utils/file.js';
import { EXTRACT_DIR, UPLOAD_DIR, getProviderIds, PROVIDERS } from '../config/index.js';
import { runMigrationPipeline, cleanupSession } from '../services/migration.js';

// Ensure the extract and upload directories exist at startup
ensureDirectoryExists(EXTRACT_DIR);
ensureDirectoryExists(UPLOAD_DIR);

/**
 * Clear all contents of the extracted/ folder.
 * Called before each new extraction to ensure a clean slate.
 * Note: uploads/ is NOT cleared here because multer saves the file there
 * before this function runs. Individual upload files are cleaned up after processing.
 */
function clearWorkFolders() {
  // Clear extracted folder only (uploads/ is cleaned up individually after processing)
  if (fs.existsSync(EXTRACT_DIR)) {
    try {
      const items = fs.readdirSync(EXTRACT_DIR);
      for (const item of items) {
        const fullPath = path.join(EXTRACT_DIR, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
      console.log('[Cleanup] Cleared extracted/ folder');
    } catch (err) {
      console.warn('[Cleanup] Failed to clear extracted/:', err.message);
    }
  }
}

/**
 * In-memory map of session IDs to their final ZIP paths.
 * Populated when a migration completes successfully so the
 * GET /api/download/:sessionId endpoint can serve retries.
 * @type {Map<string, string>}
 */
const sessionDownloads = new Map();

/** Sessions that failed (partial) — these cannot be retried. */
const sessionFailed = new Set();

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
 * POST /api/migrate
 * Full AI-powered migration pipeline.
 * Accepts a ZIP file and user prompt, runs the agentic migration loop,
 * and returns the migrated project as a downloadable ZIP.
 *
 * Body fields:
 *   - zipFile (file, required): The uploaded ZIP of the source project
 *   - prompt (string, required): Migration instructions
 *   - fromTech (string, optional): Source framework (Angular / React / Vue)
 *   - toTech   (string, optional): Target framework
 *   - aiProvider (string, optional): AI provider (e.g. 'openrouter', 'genai')
 *   - aiModel   (string, optional): AI model override
 *   - targetVersion (string, optional): Explicit target major version (e.g. '22', '19')
 */
/**
 * GET /api/download/:sessionId
 * Retry-download a completed migration ZIP by its session ID.
 * Only available if the migration completed successfully and has not been
 * cleaned up yet.
 */
router.get('/download/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  if (sessionFailed.has(sessionId)) {
    return res.status(410).json({
      error: 'Session "' + sessionId + '" failed during migration. No download available. Please re-upload and try again.',
    });
  }

  const zipPath = sessionDownloads.get(sessionId);
  if (!zipPath) {
    return res.status(404).json({
      error: 'Session "' + sessionId + '" not found or already downloaded/cleaned up. Please re-upload and try again.',
    });
  }

  if (!fs.existsSync(zipPath)) {
    sessionDownloads.delete(sessionId);
    return res.status(410).json({
      error: 'Session "' + sessionId + '" ZIP file no longer exists on disk. Please re-upload and try again.',
    });
  }

  res.download(zipPath, 'migrated_project.zip', (err) => {
    if (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('aborted')) {
        console.warn(`[${sessionId}] Retry download aborted (client disconnected). Keeping artifacts.`);
      } else {
        console.error(`[${sessionId}] Retry download error:`, err);
      }
      return;
    }
    console.log(`[${sessionId}] Retry download complete. Cleaning up...`);
    // Reuse the existing cleanupSession utility (it filters out null/falsy paths)
    const extractPath = path.join(EXTRACT_DIR, sessionId);
    const convertedPath = path.join(EXTRACT_DIR, `${sessionId}-converted`);
    cleanupSession(null, extractPath, zipPath, convertedPath);
    sessionDownloads.delete(sessionId);
    sessionFailed.delete(sessionId);
  });
});

router.post('/migrate', upload.single('zipFile'), async (req, res) => {
  // Clear extracted/ folder before starting new migration
  clearWorkFolders();

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
  // Use client-provided session ID for retry coordination, or generate one
  const id = req.body.sessionId || Date.now().toString();
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
      // Handle ADM-ZIP errors (e.g., invalid filenames in the ZIP)
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
      // If extraction fails due to invalid filenames, try with safe extraction
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
      removeDirectoryRecursive(preExtractPath);
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

  // Track if the client has disconnected so we can abort cleanup later
  let clientDisconnected = false;
  req.on('close', () => {
    if (!res.writableFinished) {
      clientDisconnected = true;
      console.warn(`[${id}] Client disconnected during migration/download.`);
    }
  });

  try {
    const resultZipPath = await runMigrationPipeline(
      zipFile.path,
      userPrompt,
      id,
      { fromTech, toTech, aiProvider, aiModel: aiModel || undefined, targetVersion: targetVersion || undefined }
    );

    // Register the completed session so GET /api/download/:sessionId can serve it
    sessionDownloads.set(id, resultZipPath);
    // Clean up old entries after 60 minutes to prevent memory leaks
    setTimeout(() => {
      sessionDownloads.delete(id);
      sessionFailed.delete(id);
    }, 60 * 60 * 1000);

    if (clientDisconnected) {
      console.warn(`[${id}] Client already disconnected. Keeping artifacts for retry download at GET /api/download/${id}.`);
      return;
    }

    res.download(resultZipPath, 'migrated_project.zip', (err) => {
      if (err) {
        // ECONNABORTED is expected when the client disconnects or times out
        if (err.code === 'ECONNABORTED' || err.message?.includes('aborted')) {
          console.warn(`[${id}] Download aborted (client disconnected). Keeping artifacts for retry download at GET /api/download/${id}.`);
        } else {
          console.error(`[${id}] Download error:`, err);
        }
        return;
      }

      // Successful download → wipe uploaded ZIP + all extracted session folders/files
      console.log(`[${id}] Download complete. Cleaning extracted session files...`);
      cleanupSession(zipFile.path, extractPath, resultZipPath, convertedPath);
      sessionDownloads.delete(id);
      sessionFailed.delete(id);
    });
  } catch (error) {
    sessionFailed.add(id);
    console.error(`[${id}] Migration pipeline failed:`, error);
    if (!clientDisconnected) {
      res.status(500).json({ error: error.message || 'The Agentic processing loop failed.' });
    }
    // Still clean up on pipeline failure so disk does not fill with partial runs
    cleanupSession(zipFile?.path, extractPath, outputZipPath, convertedPath);
  }
});

export default router;
