import { WarmSandbox } from './warmSandbox.js';

interface QueueItem<T> {
  payload: T;
  resolve: (value: string) => void;
  reject: (reason?: any) => void;
  enqueuedAt: number;
}

export interface RunnerPoolStats {
  poolSize: number;
  activeWorkers: number;
  queueLength: number;
  totalRuns: number;
  avgRunMs: number;
  avgQueueWaitMs: number;
  errorCount: number;
  lastRunAt: number | null;
}

interface RunnerPoolOptions {
  logger?: (message: string) => void;
}

export class RunnerPool<TPayload> {
  private readonly workers: WarmSandbox[];
  private readonly queue: QueueItem<TPayload>[] = [];
  private readonly logger?: (message: string) => void;
  private active = 0;
  private cursor = 0;
  private totalRuns = 0;
  private totalRunTimeMs = 0;
  private totalQueueWaitMs = 0;
  private errorCount = 0;
  private lastRunAt: number | null = null;

  constructor(workers: WarmSandbox[], options?: RunnerPoolOptions) {
    if (!workers.length) {
      throw new Error('RunnerPool requires at least one worker.');
    }
    this.workers = workers;
    this.logger = options?.logger;
  }

  run(payload: TPayload): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        payload,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });
      this.logger?.(
        `[runner-pool] job enqueued queue=${this.queue.length} active=${this.active}`
      );
      this.drain();
    });
  }

  getStats(): RunnerPoolStats {
    return {
      poolSize: this.workers.length,
      activeWorkers: this.active,
      queueLength: this.queue.length,
      totalRuns: this.totalRuns,
      avgRunMs:
        this.totalRuns === 0 ? 0 : this.totalRunTimeMs / this.totalRuns,
      avgQueueWaitMs:
        this.totalRuns === 0 ? 0 : this.totalQueueWaitMs / this.totalRuns,
      errorCount: this.errorCount,
      lastRunAt: this.lastRunAt,
    };
  }

  private drain() {
    while (this.queue.length && this.active < this.workers.length) {
      const job = this.queue.shift();
      if (!job) {
        break;
      }
      this.startJob(job);
    }
  }

  private startJob(job: QueueItem<TPayload>) {
    const { worker, index } = this.nextWorker();
    this.active += 1;
    const start = Date.now();
    const queueWaitMs = start - job.enqueuedAt;
    this.totalQueueWaitMs += queueWaitMs;
    this.logger?.(
      `[runner-pool] job start worker=${index} queueWait=${queueWaitMs}ms queue=${this.queue.length} active=${this.active}`
    );

    worker
      .run(job.payload)
      .then(job.resolve)
      .catch((err) => {
        this.errorCount += 1;
        job.reject(err);
      })
      .finally(() => {
        const duration = Date.now() - start;
        this.active -= 1;
        this.totalRuns += 1;
        this.totalRunTimeMs += duration;
        this.lastRunAt = Date.now();
        this.logger?.(
          `[runner-pool] job done duration=${duration}ms queue=${this.queue.length} active=${this.active}`
        );
        this.drain();
      });
  }

  private nextWorker(): { worker: WarmSandbox; index: number } {
    const index = this.cursor;
    const worker = this.workers[index];
    this.cursor = (this.cursor + 1) % this.workers.length;
    return { worker, index };
  }
}


