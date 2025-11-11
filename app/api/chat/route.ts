// app/api/chat/route.ts
import { NextResponse, NextRequest } from 'next/server';
import OpenAI from 'openai';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';

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

/** ---------- Interview Mode System Prompt ---------- */
const INTERVIEW_BASE_PROMPT = `
# CodeBuddy Interview Practice System Prompt

You are **CodeBuddy**, an AI interviewer that simulates a senior SWE interviewer for DSA/system/code walkthroughs.

Always be professional, encouraging, and technical. Avoid fluff. Favor structured, scannable answers.

## Global Constraints
1) Be precise & actionable; prefer bullet points/numbered steps. Minimal but representative examples.
2) Safety: no personal data; no proprietary leaks. If unsure, say so briefly and propose how to verify.
3) Match the user's language. Use fenced code blocks with language when possible.
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

## Code Review Checklist
- Correctness & edges; invariants; complexity; readability; safety; tests.

## Pattern Hints
- Sliding Window / Two Pointers / Binary Search (answer) / Greedy / Graph Traversal / DP.

## Output Discipline
- Prefer labeled sections (Approach, Complexity, Edge Cases, Tests, Next Steps).
- If the user says "give me the solution" or "I give up", provide a clean, commented solution and tests.
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


/** ---------- Workspace templates ---------- */
type Workspace = {
  language: 'python',
  functionName: string,
  params: string[],
  starterCode: string,
  tests: Array<{ name: string, args: any[], expect: any }>,
};

type ProblemData = {
  problem: string;
  pattern: string;
  code: string;
  python?: boolean;
  [key: string]: any;
};

// Load problem site data (cache it)
let problemSiteData: ProblemData[] | null = null;
function loadProblemSiteData(): ProblemData[] {
  if (problemSiteData) return problemSiteData;
  try {
    const dataPath = join(process.cwd(), 'neetcode', '.problemSiteData.json');
    const data = readFileSync(dataPath, 'utf-8');
    const parsed = JSON.parse(data) as ProblemData[];
    problemSiteData = parsed;
    return parsed;
  } catch (e) {
    console.error('Failed to load problem site data:', e);
    return [];
  }
}

// Map interview topics to neetcode patterns
function topicToPattern(topic: string): string {
  const t = topic.toLowerCase();
  if (t.includes('arrays') || t.includes('strings') || t.includes('hash')) {
    return 'Arrays & Hashing';
  }
  if (t.includes('two pointer')) {
    return 'Two Pointers';
  }
  if (t.includes('sliding')) {
    return 'Sliding Window';
  }
  if (t.includes('binary search')) {
    return 'Binary Search';
  }
  if (t.includes('stack') || t.includes('queue')) {
    return 'Stack';
  }
  if (t.includes('graph') || t.includes('bfs') || t.includes('dfs')) {
    return 'Graphs';
  }
  if (t.includes('tree') || t.includes('bst')) {
    return 'Trees';
  }
  if (t.includes('dynamic')) {
    return '1-D Dynamic Programming';
  }
  return 'Arrays & Hashing'; // default
}

// Parse Python file to extract function signature
function parsePythonSignature(code: string): { functionName: string; params: string[] } | null {
  // Look for class Solution with a method (most common pattern in neetcode)
  // Pattern: class Solution:\n    def methodName(self, param1: type1, param2: type2) -> returnType:
  const classMatch = code.match(/class\s+Solution:\s*\n\s*def\s+(\w+)\s*\(self\s*,\s*([^)]+)\)/);
  if (classMatch) {
    const functionName = classMatch[1];
    const paramsStr = classMatch[2];
    // Extract parameter names (remove type hints and default values)
    const params = paramsStr
      .split(',')
      .map(p => {
        // Remove type hints (everything after :)
        let param = p.trim().split(':')[0].trim();
        // Remove default values (everything after =)
        param = param.split('=')[0].trim();
        return param;
      })
      .filter(p => p && p !== 'self');
    return { functionName, params };
  }
  
  // Look for standalone function (less common in neetcode)
  const funcMatch = code.match(/^def\s+(\w+)\s*\(([^)]*)\)/m);
  if (funcMatch) {
    const functionName = funcMatch[1];
    const paramsStr = funcMatch[2];
    const params = paramsStr
      .split(',')
      .map(p => {
        let param = p.trim().split(':')[0].trim();
        param = param.split('=')[0].trim();
        return param;
      })
      .filter(p => p);
    return { functionName, params };
  }
  
  return null;
}

// Generate starter code from signature
function generateStarterCode(functionName: string, params: string[]): string {
  const args = params.join(', ');
  return `def ${functionName}(${args}):
    # TODO: implement
    pass
`;
}

// Load test cases from neetcode problem code mapping (LeetCode standard test cases)
function loadTestCasesFromNeetcode(problemCode: string): Array<{ name: string, args: any[], expect: any }> | null {
  // Map of problem codes to their standard LeetCode test cases
  const testCaseMap: Record<string, Array<{ name: string, args: any[], expect: any }>> = {
    '0001-two-sum': [
      { name: 'example1', args: [[2, 7, 11, 15], 9], expect: [0, 1] },
      { name: 'example2', args: [[3, 2, 4], 6], expect: [1, 2] },
      { name: 'example3', args: [[3, 3], 6], expect: [0, 1] },
    ],
    '0002-add-two-numbers': [
      { name: 'example1', args: [[2, 4, 3], [5, 6, 4]], expect: [7, 0, 8] },
      { name: 'example2', args: [[0], [0]], expect: [0] },
      { name: 'example3', args: [[9, 9, 9, 9, 9, 9, 9], [9, 9, 9, 9]], expect: [8, 9, 9, 9, 0, 0, 0, 1] },
    ],
    '0003-longest-substring-without-repeating-characters': [
      { name: 'example1', args: ['abcabcbb'], expect: 3 },
      { name: 'example2', args: ['bbbbb'], expect: 1 },
      { name: 'example3', args: ['pwwkew'], expect: 3 },
      { name: 'edge_case_empty', args: [''], expect: 0 },
    ],
    '0020-valid-parentheses': [
      { name: 'example1', args: ['()'], expect: true },
      { name: 'example2', args: ['()[]{}'], expect: true },
      { name: 'example3', args: ['(]'], expect: false },
      { name: 'edge_case_empty', args: [''], expect: true },
    ],
    '0021-merge-two-sorted-lists': [
      { name: 'example1', args: [[1, 2, 4], [1, 3, 4]], expect: [1, 1, 2, 3, 4, 4] },
      { name: 'example2', args: [[], []], expect: [] },
      { name: 'example3', args: [[], [0]], expect: [0] },
    ],
    '0070-climbing-stairs': [
      { name: 'example1', args: [2], expect: 2 },
      { name: 'example2', args: [3], expect: 3 },
      { name: 'edge_case_n1', args: [1], expect: 1 },
    ],
    '0121-best-time-to-buy-and-sell-stock': [
      { name: 'example1', args: [[7, 1, 5, 3, 6, 4]], expect: 5 },
      { name: 'example2', args: [[7, 6, 4, 3, 1]], expect: 0 },
    ],
    '0125-valid-palindrome': [
      { name: 'example1', args: ['A man, a plan, a canal: Panama'], expect: true },
      { name: 'example2', args: ['race a car'], expect: false },
      { name: 'example3', args: [' '], expect: true },
    ],
    '0217-contains-duplicate': [
      { name: 'example1', args: [[1, 2, 3, 1]], expect: true },
      { name: 'example2', args: [[1, 2, 3, 4]], expect: false },
      { name: 'example3', args: [[1, 1, 1, 3, 3, 4, 3, 2, 4, 2]], expect: true },
    ],
    '0242-valid-anagram': [
      { name: 'example1', args: ['anagram', 'nagaram'], expect: true },
      { name: 'example2', args: ['rat', 'car'], expect: false },
    ],
    '0049-group-anagrams': [
      { name: 'example1', args: [['eat', 'tea', 'tan', 'ate', 'nat', 'bat']], expect: [['bat'], ['nat', 'tan'], ['ate', 'eat', 'tea']] },
      { name: 'example2', args: [['']], expect: [['']] },
      { name: 'example3', args: [['a']], expect: [['a']] },
    ],
    '0053-maximum-subarray': [
      { name: 'example1', args: [[-2, 1, -3, 4, -1, 2, 1, -5, 4]], expect: 6 },
      { name: 'example2', args: [[1]], expect: 1 },
      { name: 'example3', args: [[5, 4, -1, 7, 8]], expect: 23 },
    ],
    '0074-search-a-2d-matrix': [
      { name: 'example1', args: [[[1, 3, 5, 7], [10, 11, 16, 20], [23, 30, 34, 60]], 3], expect: true },
      { name: 'example2', args: [[[1, 3, 5, 7], [10, 11, 16, 20], [23, 30, 34, 60]], 13], expect: false },
    ],
    '0206-reverse-linked-list': [
      { name: 'example1', args: [[1, 2, 3, 4, 5]], expect: [5, 4, 3, 2, 1] },
      { name: 'example2', args: [[1, 2]], expect: [2, 1] },
      { name: 'example3', args: [[]], expect: [] },
    ],
    '0226-invert-binary-tree': [
      { name: 'example1', args: [[4, 2, 7, 1, 3, 6, 9]], expect: [4, 7, 2, 9, 6, 3, 1] },
      { name: 'example2', args: [[2, 1, 3]], expect: [2, 3, 1] },
      { name: 'example3', args: [[]], expect: [] },
    ],
    '0238-product-of-array-except-self': [
      { name: 'example1', args: [[1, 2, 3, 4]], expect: [24, 12, 8, 6] },
      { name: 'example2', args: [[-1, 1, 0, -3, 3]], expect: [0, 0, 9, 0, 0] },
    ],
    '0347-top-k-frequent-elements': [
      { name: 'example1', args: [[1, 1, 1, 2, 2, 3], 2], expect: [1, 2] },
      { name: 'example2', args: [[1], 1], expect: [1] },
    ],
    '0704-binary-search': [
      { name: 'example1', args: [[-1, 0, 3, 5, 9, 12], 9], expect: 4 },
      { name: 'example2', args: [[-1, 0, 3, 5, 9, 12], 2], expect: -1 },
    ],
  };
  
  return testCaseMap[problemCode] || null;
}

// Generate comprehensive test cases based on problem type, signature, and code
function generateTestCases(functionName: string, params: string[], problemName: string, problemCode?: string): Array<{ name: string, args: any[], expect: any }> {
  // First, try to load test cases from neetcode mapping
  if (problemCode) {
    const neetcodeTests = loadTestCasesFromNeetcode(problemCode);
    if (neetcodeTests && neetcodeTests.length > 0) {
      return neetcodeTests;
    }
  }
  const fnLower = functionName.toLowerCase();
  const probLower = problemName.toLowerCase();
  const codeLower = (problemCode || '').toLowerCase();
  
  // Use problem code to identify specific problems (e.g., "0001-two-sum")
  const problemNum = problemCode ? problemCode.split('-')[0] : '';
  
  // Two Sum (0001)
  if (problemNum === '0001' || fnLower.includes('twosum') || codeLower.includes('two-sum')) {
    return [
      { name: 'example1', args: [[2, 7, 11, 15], 9], expect: [0, 1] },
      { name: 'example2', args: [[3, 2, 4], 6], expect: [1, 2] },
      { name: 'example3', args: [[3, 3], 6], expect: [0, 1] },
      { name: 'edge_case_small', args: [[2, 3], 5], expect: [0, 1] },
      { name: 'edge_case_negative', args: [[-1, -2, -3, -4, -5], -8], expect: [2, 4] },
    ];
  }
  
  // Valid Parentheses (0020)
  if (problemNum === '0020' || (fnLower.includes('valid') && fnLower.includes('parentheses')) || codeLower.includes('valid-parentheses')) {
    return [
      { name: 'valid_simple', args: ['()'], expect: true },
      { name: 'valid_multiple', args: ['()[]{}'], expect: true },
      { name: 'valid_nested', args: ['({[]})'], expect: true },
      { name: 'invalid_mismatch', args: ['(]'], expect: false },
      { name: 'invalid_order', args: ['([)]'], expect: false },
      { name: 'invalid_single', args: ['('], expect: false },
      { name: 'edge_case_empty', args: [''], expect: true },
    ];
  }
  
  // Best Time to Buy and Sell Stock (0121)
  if (problemNum === '0121' || fnLower.includes('maxprofit') || fnLower.includes('profit') || codeLower.includes('best-time')) {
    return [
      { name: 'example1', args: [[7, 1, 5, 3, 6, 4]], expect: 5 },
      { name: 'example2', args: [[7, 6, 4, 3, 1]], expect: 0 },
      { name: 'edge_case_single', args: [[1]], expect: 0 },
      { name: 'edge_case_two', args: [[1, 2]], expect: 1 },
      { name: 'edge_case_decreasing', args: [[5, 4, 3, 2, 1]], expect: 0 },
    ];
  }
  
  // Contains Duplicate (0217)
  if (problemNum === '0217' || (fnLower.includes('contains') && fnLower.includes('duplicate')) || codeLower.includes('contains-duplicate')) {
    return [
      { name: 'has_duplicate', args: [[1, 2, 3, 1]], expect: true },
      { name: 'no_duplicate', args: [[1, 2, 3, 4]], expect: false },
      { name: 'multiple_duplicates', args: [[1, 1, 1, 3, 3, 4, 3, 2, 4, 2]], expect: true },
      { name: 'edge_case_single', args: [[1]], expect: false },
      { name: 'edge_case_two_same', args: [[1, 1]], expect: true },
    ];
  }
  
  // Valid Anagram (0242)
  if (problemNum === '0242' || fnLower.includes('anagram') || codeLower.includes('valid-anagram')) {
    return [
      { name: 'valid', args: ['anagram', 'nagaram'], expect: true },
      { name: 'invalid', args: ['rat', 'car'], expect: false },
      { name: 'edge_case_single_char', args: ['a', 'a'], expect: true },
      { name: 'edge_case_different_length', args: ['ab', 'a'], expect: false },
    ];
  }
  
  // Longest Substring Without Repeating Characters (0003)
  if (problemNum === '0003' || (fnLower.includes('longest') && fnLower.includes('substring')) || codeLower.includes('longest-substring')) {
    return [
      { name: 'example1', args: ['abcabcbb'], expect: 3 },
      { name: 'example2', args: ['bbbbb'], expect: 1 },
      { name: 'example3', args: ['pwwkew'], expect: 3 },
      { name: 'edge_case_empty', args: [''], expect: 0 },
      { name: 'edge_case_single', args: ['a'], expect: 1 },
      { name: 'edge_case_all_unique', args: ['abcdef'], expect: 6 },
    ];
  }
  
  // Binary Search (0704)
  if (problemNum === '0704' || (fnLower.includes('binary') && fnLower.includes('search')) || codeLower.includes('binary-search')) {
    return [
      { name: 'found_middle', args: [[-1, 0, 3, 5, 9, 12], 9], expect: 4 },
      { name: 'not_found', args: [[-1, 0, 3, 5, 9, 12], 2], expect: -1 },
      { name: 'found_first', args: [[-1, 0, 3, 5, 9, 12], -1], expect: 0 },
      { name: 'found_last', args: [[-1, 0, 3, 5, 9, 12], 12], expect: 5 },
      { name: 'edge_case_single', args: [[5], 5], expect: 0 },
      { name: 'edge_case_single_not_found', args: [[5], 3], expect: -1 },
    ];
  }
  
  // Climbing Stairs (0070)
  if (problemNum === '0070' || fnLower.includes('climb') || fnLower.includes('stairs') || codeLower.includes('climbing-stairs')) {
    return [
      { name: 'n=2', args: [2], expect: 2 },
      { name: 'n=3', args: [3], expect: 3 },
      { name: 'n=5', args: [5], expect: 8 },
      { name: 'edge_case_n=1', args: [1], expect: 1 },
      { name: 'edge_case_n=4', args: [4], expect: 5 },
    ];
  }
  
  // Palindrome (0125)
  if (fnLower.includes('palindrome') || codeLower.includes('palindrome')) {
    return [
      { name: 'valid_simple', args: ['racecar'], expect: true },
      { name: 'valid_even', args: ['abba'], expect: true },
      { name: 'invalid', args: ['abc'], expect: false },
      { name: 'edge_case_single', args: ['a'], expect: true },
      { name: 'edge_case_empty', args: [''], expect: true },
      { name: 'edge_case_with_spaces', args: ['A man a plan a canal Panama'], expect: true },
    ];
  }
  
  // Group Anagrams (0049)
  if (problemNum === '0049' || (fnLower.includes('group') && fnLower.includes('anagram')) || codeLower.includes('group-anagrams')) {
    // Note: This returns a list of lists, so we need to handle comparison differently
    // For now, return basic structure
    return [
      { name: 'example1', args: [['eat', 'tea', 'tan', 'ate', 'nat', 'bat']], expect: [['bat'], ['nat', 'tan'], ['ate', 'eat', 'tea']] },
      { name: 'edge_case_single', args: [['a']], expect: [['a']] },
      { name: 'edge_case_empty', args: [['']], expect: [['']] },
    ];
  }
  
  // Product of Array Except Self (0238)
  if (problemNum === '0238' || codeLower.includes('product-of-array')) {
    return [
      { name: 'example1', args: [[1, 2, 3, 4]], expect: [24, 12, 8, 6] },
      { name: 'example2', args: [[-1, 1, 0, -3, 3]], expect: [0, 0, 9, 0, 0] },
      { name: 'edge_case_two', args: [[2, 3]], expect: [3, 2] },
    ];
  }
  
  // Maximum Subarray (0053)
  if (problemNum === '0053' || codeLower.includes('maximum-subarray')) {
    return [
      { name: 'example1', args: [[-2, 1, -3, 4, -1, 2, 1, -5, 4]], expect: 6 },
      { name: 'example2', args: [[1]], expect: 1 },
      { name: 'example3', args: [[5, 4, -1, 7, 8]], expect: 23 },
      { name: 'edge_case_all_negative', args: [[-2, -1]], expect: -1 },
    ];
  }
  
  // Generate generic test cases based on parameter types if no specific match
  if (params.length === 1) {
    const param = params[0].toLowerCase();
    if (param.includes('nums') || param.includes('arr') || param.includes('array') || param.includes('list')) {
      // For array problems, provide basic test cases
      return [
        { name: 'example1', args: [[1, 2, 3]], expect: [] }, // Empty array as placeholder
        { name: 'example2', args: [[4, 5, 6]], expect: [] },
        { name: 'edge_case_empty', args: [[]], expect: [] },
        { name: 'edge_case_single', args: [[1]], expect: [] },
        { name: 'edge_case_large', args: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], expect: [] },
      ];
    }
    if (param.includes('s') || param.includes('str') || param.includes('string')) {
      // For string problems, provide basic test cases
      return [
        { name: 'example1', args: ['test'], expect: '' },
        { name: 'example2', args: ['example'], expect: '' },
        { name: 'edge_case_empty', args: [''], expect: '' },
        { name: 'edge_case_single', args: ['a'], expect: '' },
        { name: 'edge_case_long', args: ['abcdefghijklmnopqrstuvwxyz'], expect: '' },
      ];
    }
    if (param.includes('n') && params.length === 1) {
      // For single integer parameter
      return [
        { name: 'example1', args: [5], expect: 0 },
        { name: 'example2', args: [10], expect: 0 },
        { name: 'edge_case_small', args: [1], expect: 0 },
        { name: 'edge_case_zero', args: [0], expect: 0 },
        { name: 'edge_case_large', args: [100], expect: 0 },
      ];
    }
  }
  
  if (params.length === 2) {
    // Common two-parameter patterns
    const param1 = params[0].toLowerCase();
    const param2 = params[1].toLowerCase();
    
    if ((param1.includes('nums') || param1.includes('arr')) && param2.includes('target')) {
      // Array + target pattern
      return [
        { name: 'example1', args: [[1, 2, 3, 4, 5], 5], expect: [] },
        { name: 'example2', args: [[10, 20, 30], 30], expect: [] },
        { name: 'edge_case_small', args: [[1, 2], 3], expect: [] },
      ];
    }
    
    if (param1.includes('s') && param2.includes('s')) {
      // Two strings
      return [
        { name: 'example1', args: ['abc', 'def'], expect: false },
        { name: 'example2', args: ['test', 'test'], expect: true },
        { name: 'edge_case_empty', args: ['', ''], expect: true },
      ];
    }
  }
  
  // Default: return basic test cases with appropriate types
  const defaultArgs = params.map((p, i) => {
    const pLower = p.toLowerCase();
    if (pLower.includes('nums') || pLower.includes('arr') || pLower.includes('array') || pLower.includes('list')) {
      return [1, 2, 3];
    }
    if (pLower.includes('s') || pLower.includes('str') || pLower.includes('string')) {
      return 'test';
    }
    if (pLower.includes('n') || pLower.includes('num') || pLower.includes('int')) {
      return i + 1;
    }
    return null;
  });
  
  return [
    { name: 'test_case_1', args: defaultArgs, expect: null },
    { name: 'test_case_2', args: defaultArgs.map((a, i) => Array.isArray(a) ? [...a, 4] : (typeof a === 'number' ? a + 1 : a)), expect: null },
  ];
}

// Load and parse a Python file from neetcode
function loadNeetcodePythonFile(code: string): string | null {
  try {
    const filePath = join(process.cwd(), 'neetcode', 'python', `${code}.py`);
    return readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`Failed to load Python file for ${code}:`, e);
    return null;
  }
}

// Select a problem from neetcode based on topic (returns problem data)
function selectProblemForTopic(rawTopic?: string): ProblemData | null {
  const topic = rawTopic || 'Arrays / Strings';
  const pattern = topicToPattern(topic);
  
  // Load problem data
  const problems = loadProblemSiteData();
  if (!problems || problems.length === 0) {
    return null;
  }
  
  // Filter problems by pattern and Python availability
  const matchingProblems = problems.filter(
    p => p.pattern === pattern && p.python === true
  );
  
  if (matchingProblems.length === 0) {
    // Fallback: try any problem with Python
    const anyPython = problems.filter(p => p.python === true);
    if (anyPython.length > 0) {
      return anyPython[Math.floor(Math.random() * anyPython.length)];
    }
    return null;
  }
  
  // Select a random problem from matching ones
  return matchingProblems[Math.floor(Math.random() * matchingProblems.length)];
}

// Main function to get workspace from neetcode (now takes selected problem)
function workspaceForProblem(selectedProblem: ProblemData): Workspace | null {
  // Load the Python file
  const code = loadNeetcodePythonFile(selectedProblem.code);
  if (!code) {
    return null;
  }
  
  // Parse the signature
  const sig = parsePythonSignature(code);
  if (!sig) {
    return null;
  }
  
  // Generate workspace with comprehensive test cases
    return {
      language: 'python',
    functionName: sig.functionName,
    params: sig.params,
    starterCode: generateStarterCode(sig.functionName, sig.params),
    tests: generateTestCases(sig.functionName, sig.params, selectedProblem.problem, selectedProblem.code),
  };
}

// Main function to get workspace from neetcode (backward compatibility)
function workspaceForTopic(rawTopic?: string): Workspace {
  const selectedProblem = selectProblemForTopic(rawTopic);
  
  if (!selectedProblem) {
    // Fallback to default
    return {
      language: 'python',
      functionName: 'two_sum',
      params: ['nums', 'target'],
      starterCode: generateStarterCode('two_sum', ['nums', 'target']),
      tests: [
        { name: 'example1', args: [[2, 7, 11, 15], 9], expect: [0, 1] },
        { name: 'example2', args: [[3, 2, 4], 6], expect: [1, 2] },
      ],
    };
  }
  
  const workspace = workspaceForProblem(selectedProblem);
  if (!workspace) {
    // Fallback if workspace generation fails
    return {
      language: 'python',
      functionName: 'two_sum',
      params: ['nums', 'target'],
      starterCode: generateStarterCode('two_sum', ['nums', 'target']),
      tests: [
        { name: 'example1', args: [[2, 7, 11, 15], 9], expect: [0, 1] },
      ],
    };
  }
  
  return workspace;
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

    // Always use interview mode
    const interviewerIntent = true;

    // Select problem ONCE for both chatbot and workspace (always in interview mode)
    let selectedProblem: ProblemData | null = null;
    let workspace: Workspace | null = null;
    const shouldPrependWorkspace = !!autoWorkspace;
    
    if (shouldPrependWorkspace) {
      selectedProblem = selectProblemForTopic(topic);
      if (selectedProblem) {
        workspace = workspaceForProblem(selectedProblem);
        if (!workspace) {
          // Fallback if workspace generation fails
          workspace = {
            language: 'python',
            functionName: 'two_sum',
            params: ['nums', 'target'],
            starterCode: generateStarterCode('two_sum', ['nums', 'target']),
            tests: [
              { name: 'example1', args: [[2, 7, 11, 15], 9], expect: [0, 1] },
            ],
          };
        }
      } else {
        // Fallback if no problem selected
        workspace = workspaceForTopic(topic);
      }
    }

    // Optional topic/workspace guidance to the model
    const topicLine = topic ? `- Interview Topic: ${topic}.\n` : '';
    let problemContext = '';
    if (shouldPrependWorkspace && selectedProblem && workspace) {
      // Include the selected problem information so the AI knows which problem to present
      problemContext = `- **IMPORTANT**: You must present the problem "${selectedProblem.problem}" (LeetCode problem code: ${selectedProblem.code}). ` +
        `The workspace contains function "${workspace.functionName}" with parameters: ${workspace.params.join(', ')}. ` +
        `Present this exact problem in your response.\n`;
    }
    const workspaceNote =
      autoWorkspace
        ? `- A workspace block will be **prepended** to your response by the server. **Do not** emit another workspace block.\n`
        : '';

    // Build the final system prompt
    const systemPrompt =
      `${INTERVIEW_BASE_PROMPT}\n\n` +
      `### Active Context\n` +
      `- Runtime: Next.js API route inside a Firebase-backed app.\n` +
      `- Role: Interviewer Mode (always active).\n` +
      (safeCode ? `- Code Provided: yes (analyze it directly; prioritize grounded findings).\n` : `- Code Provided: no.\n`) +
      topicLine +
      problemContext +
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

    // Prepare optional workspace prelude (use the same workspace we selected)
    const workspaceBlock = shouldPrependWorkspace && workspace ? formatWorkspaceBlock(workspace) : '';

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
        'x-codebuddy-mode': 'interviewer',
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
