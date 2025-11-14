import { execFile, spawn } from 'child_process';
import { once } from 'events';

interface WarmSandboxOptions {
  dockerBin: string;
  image: string;
  containerName: string;
  idleEntrypoint?: string[];
  runCmd?: string[];
  execTimeoutMs?: number;
}

const execFileAsync = (file: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        return reject(Object.assign(error, { stdout, stderr }));
      }
      resolve({ stdout, stderr });
    });
  });

export class WarmSandbox {
  private ensuring: Promise<void> | null = null;
  private readonly dockerBin: string;
  private readonly image: string;
  private readonly containerName: string;
  private readonly idleEntrypoint: string[];
  private readonly runCmd: string[];
  private readonly execTimeoutMs: number;

  constructor(options: WarmSandboxOptions) {
    this.dockerBin = options.dockerBin;
    this.image = options.image;
    this.containerName = options.containerName;
    this.idleEntrypoint =
      options.idleEntrypoint ?? ['/bin/sh', '-c', 'sleep infinity'];
    this.runCmd = options.runCmd ?? ['python', '/judge/run_submission.py'];
    this.execTimeoutMs = options.execTimeoutMs ?? 60_000;
  }

  async ensureContainerRunning() {
    if (this.ensuring) {
      return this.ensuring;
    }

    const ensurePromise = (async () => {
      let running = false;
      try {
        const { stdout } = await execFileAsync(this.dockerBin, [
          'inspect',
          '-f',
          '{{.State.Running}}',
          this.containerName,
        ]);
        running = stdout.trim() === 'true';
      } catch {
        running = false;
      }

      if (running) {
        return;
      }

      await execFileAsync(this.dockerBin, ['rm', '-f', this.containerName]).catch(
        () => undefined
      );

      await execFileAsync(this.dockerBin, [
        'run',
        '-d',
        '--rm',
        '--name',
        this.containerName,
        '--entrypoint',
        this.idleEntrypoint[0],
        this.image,
        ...this.idleEntrypoint.slice(1),
      ]);
    })().finally(() => {
      this.ensuring = null;
    });

    this.ensuring = ensurePromise;
    return ensurePromise;
  }

  private async executeOnce(payload: unknown): Promise<string> {
    const proc = spawn(
      this.dockerBin,
      ['exec', '-i', this.containerName, ...this.runCmd],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
    }, this.execTimeoutMs);

    try {
      const [code] = (await Promise.race([
        once(proc, 'close') as Promise<[number]>,
        once(proc, 'error').then(([err]) => {
          throw err;
        }),
      ])) as [number];
      clearTimeout(timeout);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const error = new Error(
          stderr || `Warm sandbox exited with status ${code}`
        );
        (error as any).stderr = stderr;
        throw error;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      return stdout;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async run(payload: unknown): Promise<string> {
    await this.ensureContainerRunning();
    try {
      return await this.executeOnce(payload);
    } catch (err: any) {
      if ((err?.stderr ?? '').includes('No such container')) {
        await this.ensureContainerRunning();
        return this.executeOnce(payload);
      }
      throw err;
    }
  }

  async dispose() {
    await execFileAsync(this.dockerBin, ['rm', '-f', this.containerName]).catch(
      () => undefined
    );
  }
}


