import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Base health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend server is running healthy!' });
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend engine spinning on http://localhost:${PORT}`);
});