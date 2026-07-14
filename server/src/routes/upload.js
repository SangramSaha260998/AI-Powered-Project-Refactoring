import { Router } from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import { upload } from '../middleware/upload.js';
import { validateProjectFramework } from '../services/validator.js';
import { removeDirectoryRecursive, removeFile, ensureDirectoryExists } from '../utils/file.js';
import { EXTRACT_DIR } from '../config/index.js';
import { runMigrationPipeline, cleanupSession } from '../services/migration.js';

// Ensure the extract directory exists at startup
ensureDirectoryExists(EXTRACT_DIR);

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
    const zip = new AdmZip(sourceZipPath);
    zip.extractAllTo(currentTargetExtractPath, true);
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
 */
router.post('/migrate', upload.single('zipFile'), async (req, res) => {
  const userPrompt = req.body.prompt;
  const zipFile = req.file;
  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';

  if (!zipFile || !userPrompt) {
    return res.status(400).json({ error: 'Files and prompts are required.' });
  }

  const id = Date.now().toString();
  const extractPath = path.join(EXTRACT_DIR, id);
  const outputZipPath = path.join(EXTRACT_DIR, `${id}-final.zip`);

  try {
    const resultZipPath = await runMigrationPipeline(
      zipFile.path,
      userPrompt,
      id,
      { fromTech, toTech }
    );

    res.download(resultZipPath, 'migrated_project.zip', (err) => {
      if (err) {
        console.error(`[${id}] Download error:`, err);
      }
      // Cleanup: remove uploaded file and extracted directories
      cleanupSession(zipFile.path, extractPath, resultZipPath);
    });
  } catch (error) {
    console.error(`[${id}] Migration pipeline failed:`, error);
    res.status(500).json({ error: error.message || 'The Agentic processing loop failed.' });
    cleanupSession(zipFile?.path, extractPath, outputZipPath);
  }
});

export default router;
