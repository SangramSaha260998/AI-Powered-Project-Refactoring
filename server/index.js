import express from 'express';
import cors from 'cors';
import multer from 'multer';
import admZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Fix for ES modules to resolve paths cleanly on Windows
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Enable CORS cleanly for our Angular frontend on port 4200
app.use(cors());
app.use(express.json());

// Ensure upload/extraction directories exist safely inside the server folder
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EXTRACT_DIR = path.join(__dirname, 'extracted');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(EXTRACT_DIR)) fs.mkdirSync(EXTRACT_DIR);

// Configure Multer to preserve uploaded zip files locally
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Only ZIP files are allowed!'), false);
    }
    cb(null, true);
  }
});

// 1. Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend engine online and ready to extract packages!' });
});

// 2. Core ZIP Upload and Unpacking Route
app.post('/api/upload', upload.single('projectZip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a valid ZIP file.' });
  }

  // Capture the From/To framework metadata values from the Angular dropdowns
  const fromTech = req.body.fromTech || 'Unknown';
  const toTech = req.body.toTech || 'Unknown';

  console.log(`\n📦 New Migration Request Received!`);
  console.log(`🔄 Pipeline Path: Converting from [${fromTech}] to [${toTech}]`);
  console.log(`📁 File Saved Temporarily As: ${req.file.filename}`);

  const sourceZipPath = req.file.path;
  const projectSessionName = path.parse(req.file.filename).name;
  const currentTargetExtractPath = path.join(EXTRACT_DIR, projectSessionName);

  try {
    // Unpack the file contents entirely using adm-zip
    const zip = new admZip(sourceZipPath);
    zip.extractAllTo(currentTargetExtractPath, true);

    console.log(`✅ Successfully extracted workspace contents to:\n👉 ${currentTargetExtractPath}\n`);

    // Send the final confirmation message back to our frontend interface
    res.json({
      message: `Workspace successfully unpacked! Ready to migrate from ${fromTech} to ${toTech}.`,
      sessionId: projectSessionName,
      extractedLocation: currentTargetExtractPath,
      fromTech,
      toTech
    });
  } catch (error) {
    console.error('❌ Extraction error encountered:', error);
    res.status(500).json({ error: 'Failed to extract package files smoothly.' });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Advanced Migration Engine listening on http://localhost:${PORT}`);
});