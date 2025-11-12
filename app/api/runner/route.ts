import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { once } from 'events';
import { z } from 'zod';

const RunnerRequestSchema = z.object({
  language: z.enum(['python']).default('python'),
  code: z.string().min(1, 'Code cannot be empty'),
  functionName: z.string().min(1, 'functionName is required'),
  referenceCode: z.string().optional(),
  tests: z
    .array(
      z.object({
        name: z.string().optional(),
        args: z.any().optional(),
        expect: z.any().optional(),
      })
    )
    .min(1, 'Provide at least one test case'),
  timeoutMs: z.number().int().positive().max(30_000).default(2_000),
});

const DEFAULT_IMAGE = 'judge-python';
const DOCKER_BIN = process.env.DOCKER_BINARY || 'docker';
const DEFAULT_REFERENCES = {
  python: [
    'from typing import List, Optional, Dict, Set, Tuple',
    'from collections import deque, Counter, defaultdict',
    'import math',
    'import heapq',
  ].join('\n'),
} as const;
const RUNNER_TIMEOUT_MS = 60_000;

async function runInSandbox(payload: unknown) {
  const docker = spawn(DOCKER_BIN, ['run', '--rm', '-i', DEFAULT_IMAGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  docker.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  docker.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  docker.stdin.write(JSON.stringify(payload));
  docker.stdin.end();

  const timeout = setTimeout(() => {
    docker.kill('SIGKILL');
  }, RUNNER_TIMEOUT_MS);

  try {
    const [code] = (await Promise.race([
      once(docker, 'close') as Promise<[number]>,
      once(docker, 'error').then(([err]) => {
        throw err;
      }),
    ])) as [number];
    clearTimeout(timeout);
    if (code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      throw new Error(stderr || `Sandbox exited with status ${code}`);
    }
    const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
    return stdout;
  } catch (err) {
    clearTimeout(timeout);
    if ((err as any)?.code === 'ENOENT') {
      const bin = DOCKER_BIN;
      throw new Error(
        `Docker binary "${bin}" not found. Install Docker or set DOCKER_BINARY env var to the correct path.`
      );
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const parsed = RunnerRequestSchema.parse(json);

    const payload = {
      language: parsed.language,
      code: parsed.code,
      functionName: parsed.functionName,
      tests: parsed.tests,
      timeoutMs: parsed.timeoutMs,
    referenceCode: parsed.referenceCode
      ? `${DEFAULT_REFERENCES[parsed.language] ?? ''}\n${parsed.referenceCode}`
      : undefined,
    };

    const result = await runInSandbox(payload);
    const body = JSON.parse(result);

    return NextResponse.json(body, { status: 200 });
  } catch (err: any) {
    const message = err?.message || 'Runner error';
    const details = err?.details || undefined;
    return NextResponse.json(
      { error: message, details },
      { status: err instanceof z.ZodError ? 400 : 500 }
    );
  }
}

