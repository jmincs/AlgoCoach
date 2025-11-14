import { NextRequest, NextResponse } from 'next/server';
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

const DEFAULT_REFERENCES = {
  python: [
    'from typing import List, Optional, Dict, Set, Tuple',
    'from collections import deque, Counter, defaultdict',
    'import math',
    'import heapq',
  ].join('\n'),
} as const;
const RUNNER_SERVICE_URL =
  process.env.RUNNER_SERVICE_URL || 'http://127.0.0.1:4001/run';
const RUNNER_SERVICE_TIMEOUT_MS = 65_000;

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUNNER_SERVICE_TIMEOUT_MS);

    const response = await fetch(RUNNER_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const message =
        body?.error ||
        `Runner service responded with status ${response.status}`;
      return NextResponse.json(
        { error: message, details: body?.details },
        { status: response.status }
      );
    }

    return NextResponse.json(body ?? {}, { status: 200 });
  } catch (err: any) {
    let message = err?.message || 'Runner error';
    const details = err?.details || undefined;
    if (err?.name === 'AbortError') {
      message = 'Runner service timed out.';
    } else if (
      err?.code === 'ECONNREFUSED' ||
      err?.cause?.code === 'ECONNREFUSED'
    ) {
      message = `Runner service unreachable at ${RUNNER_SERVICE_URL}.`;
    }
    return NextResponse.json(
      { error: message, details },
      { status: err instanceof z.ZodError ? 400 : 500 }
    );
  }
}

