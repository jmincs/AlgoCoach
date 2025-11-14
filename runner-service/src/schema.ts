import { z } from 'zod';

export const RunnerRequestSchema = z.object({
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

export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;


