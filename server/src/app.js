import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import uploadRouter from './routes/upload.js';

const app = express();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api', healthRouter);
app.use('/api', uploadRouter);

export default app;
