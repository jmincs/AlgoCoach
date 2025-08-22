// app/api/chat/route.ts
import { NextResponse, NextRequest } from 'next/server';
import OpenAI from 'openai';
import { z } from 'zod';

/** ---------- RAG-lite: tiny KB + embeddings (init once) ----------- */
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { OpenAIEmbeddings } from '@langchain/openai';

/** ---------- Config ---------- */
export const runtime = 'nodejs';
const MAX_CODE_CHARS = 20_000;
const MAX_Q_CHARS = 2_000;
const MAX_HISTORY = 12;

/** ---------- Request schema ---------- */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const ChatRequestSchema = z.object({
  mode: z.enum(['explain', 'debug', 'refactor', 'complexity']).default('explain'),
  messages: z.array(ChatMessageSchema).min(1).max(64),
  code: z.string().optional().default(''),
  uid: z.string().optional(),
  interviewer: z.boolean().optional(),
  topic: z.string().optional(),
  autoWorkspace: z.boolean().optional().default(false),
});

/** ---------- Dual-Mode System Prompt (Interviewer + Coach) ---------- */
const DUAL_BASE_PROMPT = `
# CodeBuddy Dual-Mode System Prompt (Interviewer + Algorithm Coach)

You are **CodeBuddy**, an AI that can operate in two complementary modes:

- **Interviewer Mode**:
  Simulate a senior SWE interviewer for DSA/system/code walkthroughs.

- **Coach Mode** (default):
  A concise, supportive mentor who explains, debugs, refactors, and analyzes complexity with minimal but precise steps.

Always be professional, encouraging, and technical. Avoid fluff. Favor structured, scannable answers.

## Global Constraints
1) Be precise & actionable; prefer bullet points/numbered steps. Minimal but representative examples.
2) Safety: no personal data; no proprietary leaks. If unsure, say so briefly and propose how to verify.
3) Match the user’s language. Use fenced code blocks with language when possible.
4) If code is provided, prioritize findings grounded in the code. If no code, ask ≤2 clarifying questions.
5) RAG context may be included as "Relevant algorithmic patterns" — integrate naturally, do not echo verbatim.
6) Do **not** give full solutions unless the user explicitly gives up or asks; before that, give progressively stronger hints.
7) Token discipline: be concise. If a topic is large, summarize and offer a short follow-up plan.

## Interviewer Mode — Structured Flow
1) Intro (one line).
2) Problem Delivery (short statement + constraints + edge cases + target complexity if relevant).
3) Think-Aloud Prompt: ask for approach before coding.
4) Hint Cadence (no full solution): pattern nudges → complexity probe → invariant cue → high-level pseudo if stuck.
5) Complexity Discussion (mandatory).
6) Edge Cases & Tests (≥3: smallest, typical, tricky).
7) Code Review (if code posted): use the Code Review Checklist.
8) Scoring & Feedback (0–4 on Problem Solving, Correctness, Complexity, Communication, Code Quality) + 1–2 action items.
9) Next Steps: one follow-up or harder variant.

## Coach Mode — Mentoring Tracks
- Explain / Debug / Refactor / Complexity as requested.

## Code Review Checklist
- Correctness & edges; invariants; complexity; readability; safety; tests.

## Pattern Hints
- Sliding Window / Two Pointers / Binary Search (answer) / Greedy / Graph Traversal / DP.

## Output Discipline
- Prefer labeled sections (Approach, Complexity, Edge Cases, Tests, Next Steps).
- If the user says “give me the solution” or “I give up”, provide a clean, commented solution and tests.
- Otherwise keep to hints and probing questions.
`;

/** ---------- Algorithmic KB (FULLY EXPANDED) ---------- */
const algorithmicPatterns = [
  `Dynamic Programming Pattern:
Key Concepts:
1. Optimal Substructure
2. Overlapping Subproblems

Approaches:
- Top-down (Memoization)
- Bottom-up (Tabulation)

Implementation Tips:
- Identify state, recurrence, base cases
- Space optimization when possible`,

  `Sliding Window Pattern:
- Fixed vs Dynamic windows
- Maintain invariant; expand right; shrink left when broken
- Common pitfalls: off-by-one, not updating result during moves`,

  `Two Pointers Pattern:
- Same vs opposite direction
- Use order to prune
- Pitfalls: infinite loops, double counting`,

  `Graph Traversal:
- DFS/BFS; visited tracking
- BFS for shortest paths in unweighted graphs`,

  `Binary Search Pattern:
- Monotonic predicate; bounds & termination
- Lower/upper bound variants; search on answer`,

  `Backtracking:
- Choose → Explore → Unchoose
- Prune early; memoize if repeats`,
];

/** ---------- RAG-lite: embed once and keep in memory ---------- */
let vectorStore: MemoryVectorStore | null = null;
let embeddingsReady = false;

async function ensureEmbeddingsReady() {
  if (embeddingsReady && vectorStore) return;
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const docs = await splitter.createDocuments(algorithmicPatterns);
  const embeddings = new OpenAIEmbeddings({ apiKey: process.env.OPENAI_API_KEY });
  vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
  embeddingsReady = true;
}

async function retrieveRelevantPatterns(query: string, k = 2): Promise<string> {
  if (!vectorStore) return '';
  // @ts-ignore
  const docs = await vectorStore.similaritySearch(query.slice(0, 600), k);
  return docs.map((d: any) => d.pageContent.trim()).join('\n\n');
}

/** ---------- Utilities ---------- */
function trimHistory(messages: Array<{ role: string; content: string }>) {
  const nonSys = messages.filter(m => m.role !== 'system');
  return nonSys.slice(-MAX_HISTORY);
}
function clampInput(text: string, max: number) {
  return text.length > max ? text.slice(0, max) : text;
}
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
function buildMessages(systemPrompt: string, history: Array<{ role: string; content: string }>, code?: string): ChatMsg[] {
  const composed: ChatMsg[] = [{ role: 'system', content: systemPrompt }];
  const safeHistory: ChatMsg[] = trimHistory(history).map(m => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user'),
    content: m.content,
  }));
  composed.push(...safeHistory);
  if (code && code.length) {
    composed.push({
      role: 'user',
      content: `Here is my current code (fenced). Please consider it for your response.\n\`\`\`\n${code.slice(0, MAX_CODE_CHARS)}\n\`\`\``,
    });
  }
  return composed;
}

/** Detects interview intent from recent user messages (fallback only) */
function detectInterviewerIntent(history: Array<{ role: string; content: string }>): boolean {
  const lastTwoUser = history.filter(m => m.role === 'user').slice(-2).map(m => m.content.toLowerCase());
  const triggers = ['start interview','mock interview','interview me','ask me a question','give me an interview question','begin interview','simulate interview','whiteboard','follow-up question'];
  return lastTwoUser.some(msg => triggers.some(t => msg.includes(t)));
}

/** ---------- Workspace templates ---------- */
type Workspace = {
  language: 'python',
  functionName: string,
  params: string[],
  starterCode: string,
  tests: Array<{ name: string, args: any[], expect: any }>,
};

// Python stub (def ...: + pass)
function pyStub(name: string, params: string[]) {
  const args = params.join(', ');
  return `def ${name}(${args}):
    # TODO: implement
    pass
`;
}

// If you prefer Pythonic snake_case names, you can rename below.
// Just ensure functionName matches the def in starterCode.
function workspaceForTopic(rawTopic?: string): Workspace {
  const t = (rawTopic || '').toLowerCase();
  if (t.includes('two pointer')) {
    return {
      language: 'python',
      functionName: 'is_palindrome',
      params: ['s'],
      starterCode: pyStub('is_palindrome', ['s']),
      tests: [
        { name: 'racecar', args: ['racecar'], expect: true },
        { name: 'abba', args: ['abba'], expect: true },
        { name: 'abc', args: ['abc'], expect: false },
      ],
    };
  }
  if (t.includes('sliding')) {
    return {
      language: 'python',
      functionName: 'max_subarray_sum_of_size_k',
      params: ['arr', 'k'],
      starterCode: pyStub('max_subarray_sum_of_size_k', ['arr', 'k']),
      tests: [
        { name: 'k=2', args: [[1,2,3,4,5], 2], expect: 9 },
        { name: 'k=3', args: [[2,1,5,1,3,2], 3], expect: 9 },
      ],
    };
  }
  if (t.includes('binary search')) {
    return {
      language: 'python',
      functionName: 'binary_search',
      params: ['arr', 'target'],
      starterCode: pyStub('binary_search', ['arr', 'target']),
      tests: [
        { name: 'found', args: [[1,2,3,4], 3], expect: 2 },
        { name: 'not found', args: [[1,2,4,5], 3], expect: -1 },
      ],
    };
  }
  if (t.includes('hash')) {
    return {
      language: 'python',
      functionName: 'two_sum',
      params: ['nums', 'target'],
      starterCode: pyStub('two_sum', ['nums', 'target']),
      tests: [
        { name: 'classic', args: [[2,7,11,15], 9], expect: [0,1] },
        { name: 'another', args: [[3,2,4], 6], expect: [1,2] },
      ],
    };
  }
  if (t.includes('stack') || t.includes('queue')) {
    return {
      language: 'python',
      functionName: 'is_valid_parentheses',
      params: ['s'],
      starterCode: pyStub('is_valid_parentheses', ['s']),
      tests: [
        { name: 'ok', args: ['()[]{}'], expect: true },
        { name: 'bad', args: ['([)]'], expect: false },
        { name: 'nested', args: ['({[]})'], expect: true },
      ],
    };
  }
  if (t.includes('graph') || t.includes('bfs') || t.includes('dfs')) {
    return {
      language: 'python',
      functionName: 'num_islands',
      params: ['grid'],
      starterCode: pyStub('num_islands', ['grid']),
      tests: [
        { name: 'small', args: [[['1','1','0'],['0','1','0'],['0','0','1']]], expect: 2 },
        { name: 'single', args: [[['1']]], expect: 1 },
      ],
    };
  }
  if (t.includes('tree') || t.includes('bst')) {
    return {
      language: 'python',
      functionName: 'sorted_array_to_bst_height',
      params: ['nums'],
      starterCode: pyStub('sorted_array_to_bst_height', ['nums']),
      tests: [
        { name: 'empty', args: [[]], expect: 0 },
        { name: 'len3', args: [[-10,0,5]], expect: 2 },
      ],
    };
  }
  if (t.includes('dynamic')) {
    return {
      language: 'python',
      functionName: 'climb_stairs',
      params: ['n'],
      starterCode: pyStub('climb_stairs', ['n']),
      tests: [
        { name: 'n=1', args: [1], expect: 1 },
        { name: 'n=2', args: [2], expect: 2 },
        { name: 'n=5', args: [5], expect: 8 },
      ],
    };
  }
  // Arrays / Strings or default
  return {
    language: 'python',
    functionName: 'length_of_longest_substring',
    params: ['s'],
    starterCode: pyStub('length_of_longest_substring', ['s']),
    tests: [
      { name: 'abcabcbb', args: ['abcabcbb'], expect: 3 },
      { name: 'bbbb', args: ['bbbb'], expect: 1 },
      { name: 'pwwkew', args: ['pwwkew'], expect: 3 },
      { name: 'empty', args: [''], expect: 0 },
    ],
  };
}

function formatWorkspaceBlock(ws: Workspace) {
  return `<<<WORKSPACE_JSON
${JSON.stringify(ws)}
>>>
`;
}

/** ---------- Handler ---------- */
export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const parsed = ChatRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { mode, messages, code, uid, interviewer, topic, autoWorkspace } = parsed.data;

    // Guards
    const questionish = messages[messages.length - 1]?.content ?? '';
    const safeQuestion = clampInput(questionish, MAX_Q_CHARS);
    const safeCode = clampInput(code || '', MAX_CODE_CHARS);

    // RAG-lite (best-effort; if it fails, continue without it)
    let ragContext = '';
    try {
      await ensureEmbeddingsReady();
      ragContext = await retrieveRelevantPatterns(safeQuestion, 2);
    } catch (e) {
      console.warn('RAG init/lookup failed; continuing without RAG:', (e as any)?.message ?? e);
    }

    // Decide if interviewer mode should be emphasized (explicit flag wins; heuristic fallback)
    const interviewerIntent =
      typeof interviewer === 'boolean' ? interviewer : detectInterviewerIntent(messages);

    // Mode track label (Coach tracks)
    const modeTrack =
      mode === 'debug' ? 'Debug Track'
      : mode === 'refactor' ? 'Refactor Track'
      : mode === 'complexity' ? 'Complexity Track'
      : 'Explain Track';

    // Optional topic/workspace guidance to the model
    const topicLine = interviewerIntent && topic ? `- Interview Topic: ${topic}.\n` : '';
    const workspaceNote =
      interviewerIntent && autoWorkspace
        ? `- A workspace block will be **prepended** to your response by the server. **Do not** emit another workspace block.\n`
        : '';

    // Build the final system prompt
    const systemPrompt =
      `${DUAL_BASE_PROMPT}\n\n` +
      `### Active Context\n` +
      `- Runtime: Next.js API route inside a Firebase-backed app.\n` +
      `- Role Bias: ${interviewerIntent ? 'Interviewer Mode' : 'Coach Mode'}.\n` +
      `- Coach Track: ${modeTrack}.\n` +
      (safeCode ? `- Code Provided: yes (analyze it directly; prioritize grounded findings).\n` : `- Code Provided: no.\n`) +
      topicLine +
      `- Preferred workspace language: python.\n` +
      workspaceNote +
      (ragContext ? `\n### Relevant algorithmic patterns (use as subtle guidance, do not echo verbatim):\n${ragContext}\n` : '');

    // Compose messages (normalized)
    const payload: any = buildMessages(systemPrompt, messages, safeCode);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Streaming response from OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // swap to 'gpt-4o' for higher quality
      temperature: 0.2,
      stream: true,
      max_tokens: 700,
      messages: payload,
    });

    const encoder = new TextEncoder();

    // Prepare optional workspace prelude
    const shouldPrependWorkspace = !!(interviewerIntent && autoWorkspace);
    const workspaceBlock = shouldPrependWorkspace ? formatWorkspaceBlock(workspaceForTopic(topic)) : '';

    // Create a stream that first sends the workspace (if any), then the model stream
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // 1) Prepend workspace so client opens panel immediately
          if (shouldPrependWorkspace && workspaceBlock) {
            controller.enqueue(encoder.encode(workspaceBlock));
          }
          // 2) Pipe model stream
          for await (const chunk of completion) {
            const delta = (chunk as any)?.choices?.[0]?.delta?.content;
            if (delta) controller.enqueue(encoder.encode(delta));
          }
        } catch (e) {
          controller.error(e as Error);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'x-codebuddy-mode': interviewerIntent ? 'interviewer' : `coach:${mode}`,
        ...(uid ? { 'x-codebuddy-uid': uid } : {}),
      },
    });
  } catch (error: any) {
    console.error('[CodeBuddy /api/chat] Error:', error?.message || error);
    const status =
      typeof error?.status === 'number' ? error.status :
      /invalid api key|unauthorized|401/i.test(error?.message || '') ? 401 :
      500;

    return NextResponse.json(
      { error: status === 401 ? 'Unauthorized (check OPENAI_API_KEY).' : 'Internal Server Error' },
      { status }
    );
  }
}
