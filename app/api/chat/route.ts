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
});

/** ---------- Dual-Mode System Prompt (Interviewer + Coach) ---------- */
const DUAL_BASE_PROMPT = `
# CodeBuddy Dual-Mode System Prompt (Interviewer + Algorithm Coach)

You are **CodeBuddy**, an AI that can operate in two complementary modes:

- **Interviewer Mode** (trigger if user requests "start interview", "mock interview", "interview me", "ask me a question", "give me an interview question", "begin interview", "simulate interview", "whiteboard", etc.):
  Simulate a senior SWE interviewer for DSA/system/code walkthroughs.

- **Coach Mode** (default):
  A concise, supportive mentor who explains, debugs, refactors, and analyzes complexity with minimal but precise steps.

Always stay professional, encouraging, and technical. Avoid fluff. Favor structured, scannable answers.

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
8) Scoring & Feedback: 0–4 on Problem Solving, Correctness, Complexity, Communication, Code Quality + 1–2 action items.
9) Next Steps: one follow-up or harder variant.

If the user is already mid-problem (they pasted code first), skip to steps 5–8, but ask one probing question about intended approach.

## Coach Mode — Mentoring Tracks
- **Explain Track:** tight concept, minimal example, 1–2 drills.
- **Debug Track:** (1) restate bug, (2) likely root causes, (3) minimal counterexample trace, (4) pinpoint line/invariant, (5) minimal fix + tiny test. If no code, ask for smallest repro.
- **Refactor Track:** 3–5 improvements (naming/structure/DS/complexity/edges). Show small before/after or focused diff.
- **Complexity Track:** Big-O time/space, dominating operation, one realistic optimization (+ trade-off).

## Code Review Checklist (use in Interviewer step 7 or Coach/Refactor)
- Correctness & Edge Handling: off-by-one, empties, duplicates, negatives, overflow.
- Invariants: window bounds, pointer moves, visited markers, DP transitions.
- Complexity: unnecessary passes, nested loops, DS choices.
- Readability: names, function size, early returns, comments explaining WHY.
- Safety: bounds checks, null/undefined, integer overflow (JS Number limits), input validation.
- Tests: smallest, typical, adversarial.

## Pattern Hints (tie to RAG)
- Sliding Window: maintain invariant; move left while broken.
- Two Pointers: sorted/orderable domain; explicit move rule.
- Binary Search on Answer: monotonic predicate; define feasible(x).
- Heap/Greedy: exchange argument; local→global optimality.
- Graph Traversal: BFS for shortest path (unweighted); detect cycles; mark visited.
- DP: define state/transition/base; consider tabulation + space optimization.

## Output Discipline
- Prefer labeled sections (Approach, Complexity, Edge Cases, Tests, Next Steps).
- If the user says “give me the solution” or “I give up”, provide a clean, commented solution and tests.
- Otherwise keep to hints and probing questions.
`;

/** ---------- Algorithmic KB (FULLY EXPANDED) ---------- */
const algorithmicPatterns = [
  `Dynamic Programming Pattern:
Key Concepts:
1. Optimal Substructure: Problem can be broken into smaller subproblems whose optimal solutions compose an optimal global solution.
2. Overlapping Subproblems: The same subproblems appear multiple times.

Common Approaches:
1. Top-down (Memoization):
   - Start with the main problem and recurse down.
   - Cache results of subproblems to avoid recomputation.
2. Bottom-up (Tabulation):
   - Solve from smallest subproblems up to the main problem.
   - Use arrays/tables; often more space/time predictable.

Implementation Tips:
- Identify state variables (indices, capacities, flags).
- Define recurrence relation precisely.
- Handle base cases carefully.
- Consider space optimization (rolling arrays) when only a few previous states are needed.
- Beware integer overflows and large table sizes.
- Validate transitions and constraints (e.g., bounds, prerequisites).`,

  `Sliding Window Pattern:
Key Concepts:
1. Fixed Window: Window size remains constant; slide by adding one element and removing one.
2. Dynamic Window: Window size expands/contracts based on a maintained invariant (e.g., sum ≤ K, unique chars only).

Implementation Steps:
1. Initialize pointers (start, end) and state (e.g., counts, sum).
2. Expand window (move end) and incorporate new element.
3. While invariant breaks, contract window (move start) and remove element effects.
4. Update result during movements (max/min length, count, etc.).

Common Applications:
- Longest/shortest substring with constraints
- Subarray sums, averages
- Stream processing with limited memory

Pitfalls:
- Off-by-one at boundaries
- Not updating result at the correct time
- Forgetting to decrement counts when contracting`,

  `Two Pointers Pattern:
Types:
1. Same Direction: Both pointers move forward (fast/slow, read/write).
2. Opposite Direction: Pointers move toward each other (left/right endpoints).

Common Applications:
- Array deduplication / partitioning
- Linked list cycle detection (Floyd)
- Palindrome checks, pair sums in sorted arrays
- In-place transformations without extra space

Implementation Tips:
- Initialize pointers strategically (start/end, slow/fast).
- Define precise movement conditions for each pointer.
- Prove termination and correctness (invariants).
- For sorted arrays, leverage order to prune search.

Pitfalls:
- Infinite loops when neither pointer moves on some cases
- Skipping or double-counting elements`,

  `Graph Traversal Patterns:
Key Approaches:
1. Depth-First Search (DFS):
   - Stack/recursion; explore as far as possible then backtrack.
   - Great for connected components, topological order (DAG), cycle detection.
2. Breadth-First Search (BFS):
   - Queue; explores level by level.
   - Shortest path in unweighted graphs, minimum hops, spreading processes.

Implementation Tips:
- Track visited to avoid cycles; for grids, careful bounds checks.
- For BFS shortest paths, record parent/predecessor for path reconstruction.
- For weighted graphs, use Dijkstra (non-negative) or Bellman-Ford (negatives allowed).
- Consider space complexity: recursion depth for DFS; queue growth for BFS.

Pitfalls:
- Forgetting to mark visited at the right time
- Revisiting nodes due to multiple enqueues or late marking`,

  `Binary Search Pattern:
Key Concepts:
1. Search Space must be sorted or conceptually monotonic.
2. Midpoint Calculation: Use mid = lo + (hi - lo) // 2 to avoid overflow.

Implementation Tips:
- Define clearly: inclusive/exclusive bounds (lo/hi), and termination condition.
- Choose which side to keep when mid satisfies predicate.
- Consider "Binary Search on Answer": define feasible(x) monotonic and search minimal x.

Variations:
- Exact match (first/any occurrence)
- Lower bound / upper bound (first ≥ x, last ≤ x)
- Search on implicit domain (answer, capacity, time)

Pitfalls:
- Infinite loops when bounds don’t move
- Off-by-one when returning lo/hi/mid`,

  `Backtracking Pattern:
Key Concepts:
1. Decision Space: All possible choices at each step.
2. Constraints: Valid state / pruning conditions.
3. Goal State: When a complete solution is formed.

Implementation Steps:
1. Choose: Make a decision (add element/option).
2. Explore: Recurse with new state.
3. Unchoose: Undo decision to try next option.

Optimization Tips:
- Prune invalid paths early (constraints).
- Order choices to reduce branching (e.g., most constrained first).
- Represent state efficiently (bitmasks, fixed arrays).
- Memoize when subproblems repeat (turning into DP).

Pitfalls:
- Not backtracking (forgetting to undo)
- Exponential blowup without pruning
- Duplicates when state not canonicalized`,
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
  // Some LC versions don’t type this on MemoryVectorStore; it exists at runtime.
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

/** Normalize to the only roles we use so TS doesn’t drag in function/tool variants */
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

/** Detects interview intent from the latest user messages */
function detectInterviewerIntent(history: Array<{ role: string; content: string }>): boolean {
  const lastTwoUser = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content.toLowerCase());

  const triggers = [
    'start interview',
    'mock interview',
    'interview me',
    'ask me a question',
    'give me an interview question',
    'begin interview',
    'simulate interview',
    'whiteboard',
    'follow-up question',
  ];

  return lastTwoUser.some(msg => triggers.some(t => msg.includes(t)));
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

    const { mode, messages, code, uid } = parsed.data;

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

    // Decide if interviewer mode should be emphasized
    const interviewerIntent = detectInterviewerIntent(messages);

    // Mode track label (Coach tracks)
    const modeTrack =
      mode === 'debug' ? 'Debug Track'
      : mode === 'refactor' ? 'Refactor Track'
      : mode === 'complexity' ? 'Complexity Track'
      : 'Explain Track';

    // Build the final system prompt
    const systemPrompt =
      `${DUAL_BASE_PROMPT}\n\n` +
      `### Active Context\n` +
      `- Runtime: Next.js API route inside a Firebase-backed app.\n` +
      `- Role Bias: ${interviewerIntent ? 'Interviewer Mode' : 'Coach Mode'}.\n` +
      `- Coach Track: ${modeTrack}.\n` +
      (safeCode ? `- Code Provided: yes (analyze it directly; prioritize grounded findings).\n` : `- Code Provided: no.\n`) +
      (ragContext ? `\n### Relevant algorithmic patterns (use as subtle guidance, do not echo verbatim):\n${ragContext}\n` : '');

    // Compose messages (normalized)
    const payload: any = buildMessages(systemPrompt, messages, safeCode); // cast avoids SDK union hassle

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Streaming response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // swap to 'gpt-4o' for higher quality
      temperature: 0.2,
      stream: true,
      max_tokens: 700,
      messages: payload,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const delta = chunk.choices?.[0]?.delta?.content;
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
