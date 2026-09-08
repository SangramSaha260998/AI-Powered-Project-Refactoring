import express from 'express';
import multer from 'multer';
import { createCorsMiddleware } from './cors.js';
import healthRouter from './routes/health.js';
import uploadRouter from './routes/upload.js';
import modelsRouter from './routes/models.js';

const app = express();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(createCorsMiddleware());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use(healthRouter);
app.use('/api', healthRouter);
app.use('/api', uploadRouter);
app.use('/api', modelsRouter);

// ---------------------------------------------------------------------------
// Global error handler — ensures all errors are logged and return JSON
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Uploaded ZIP exceeds the 50 MB size limit.' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err.message === 'Only ZIP files are allowed!') {
    return res.status(400).json({ error: err.message });
  }

  if (String(err.message || '').startsWith('CORS blocked')) {
    return res.status(403).json({ error: err.message });
  }

  res.status(500).json({
    error: err.message || 'An unexpected server error occurred.'
  });
});

export default app;
