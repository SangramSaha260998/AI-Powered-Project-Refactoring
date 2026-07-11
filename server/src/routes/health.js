import { Router } from 'express';

const router = Router();

/**
 * GET /api/health
 * Basic health-check endpoint.
 */
router.get('/health', (req, res) => {
  res.json({ status: 'Backend engine online and ready to extract packages!' });
});

export default router;
