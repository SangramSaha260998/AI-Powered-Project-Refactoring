import express from 'express';
import healthRouter from '../src/routes/health.js';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('PASS:', message);
  }
}

const app = express();
app.use(healthRouter);
app.use('/api', healthRouter);

const server = app.listen(0);
const { port } = server.address();

try {
  const root = await fetch(`http://127.0.0.1:${port}/health`);
  const rootBody = await root.json();
  assert(root.status === 200, 'GET /health returns 200');
  assert(
    typeof rootBody.status === 'string' && rootBody.status.includes('online'),
    'GET /health body says the engine is online'
  );

  const api = await fetch(`http://127.0.0.1:${port}/api/health`);
  const apiBody = await api.json();
  assert(api.status === 200, 'GET /api/health returns 200');
  assert(
    typeof apiBody.status === 'string' && apiBody.status.includes('online'),
    'GET /api/health body says the engine is online'
  );
} catch (err) {
  console.error('FAIL: health probe threw', err);
  process.exitCode = 1;
} finally {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

if (process.exitCode) {
  console.error('\nSome health tests failed.');
} else {
  console.log('\nAll health tests passed.');
}
