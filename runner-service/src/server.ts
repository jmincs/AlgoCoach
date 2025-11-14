import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { RunnerRequestSchema, type RunnerRequest } from './schema.js';
import { WarmSandbox } from './warmSandbox.js';
import { RunnerPool } from './runnerPool.js';

const PORT = Number(process.env.RUNNER_SERVICE_PORT || 4001);
const POOL_SIZE = Math.max(Number(process.env.RUNNER_POOL_SIZE || '2'), 1);
const DOCKER_BIN = process.env.DOCKER_BINARY || 'docker';
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'judge-python';
const CONTAINER_PREFIX =
  process.env.RUNNER_CONTAINER_PREFIX || 'judge-python-worker';
const EXEC_TIMEOUT_MS = Number(process.env.RUNNER_EXEC_TIMEOUT_MS || '60000');

const workers = Array.from({ length: POOL_SIZE }, (_, idx) => {
  const containerName = `${CONTAINER_PREFIX}-${idx + 1}`;
  return new WarmSandbox({
    dockerBin: DOCKER_BIN,
    image: RUNNER_IMAGE,
    containerName,
    execTimeoutMs: EXEC_TIMEOUT_MS,
  });
});

const runnerPool = new RunnerPool<RunnerRequest>(workers, {
  logger: (message) => console.log(message),
});

const app = express();
app.use(express.json({ limit: '512kb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    image: RUNNER_IMAGE,
    ...runnerPool.getStats(),
  });
});

app.get('/metrics', (_req: Request, res: Response) => {
  res.json({
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    stats: runnerPool.getStats(),
  });
});

app.post('/run', async (req: Request, res: Response) => {
  try {
    const payload = RunnerRequestSchema.parse(req.body);
    const raw = await runnerPool.run(payload);

    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: 'Runner produced invalid JSON.',
        details: raw?.slice(0, 500),
      });
    }

    return res.json(body);
  } catch (err: any) {
    if (err?.issues) {
      return res.status(400).json({ error: 'Bad request', details: err.issues });
    }

    const code = err?.code ?? err?.cause?.code;
    if (code === 'ENOENT') {
      return res.status(500).json({
        error: `Docker binary "${DOCKER_BIN}" not found. Install Docker or set DOCKER_BINARY to the correct path.`,
      });
    }

    console.error('[runner-service] Error handling request:', err);
    return res.status(500).json({
      error: 'Runner service error',
      details: err?.message,
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(
    `[runner-service] Listening on port ${PORT} with pool size ${POOL_SIZE}`
  );
});

async function shutdown() {
  console.log('[runner-service] Shutting down, cleaning containers...');
  server.close();
  await Promise.all(workers.map((worker) => worker.dispose()));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


