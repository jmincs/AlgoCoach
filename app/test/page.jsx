// app/test/page.jsx
'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/* =========================
   Streaming helper
   ========================= */
async function askCodeBuddy({ mode, messages, code, interviewer, topic, autoWorkspace, onChunk, signal }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ mode, messages, code, interviewer, topic, autoWorkspace }),
    signal,
    cache: 'no-store',
    keepalive: false,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || 'request failed'}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const delta = decoder.decode(value, { stream: true });
    if (!delta) continue;
    onChunk(delta);
  }
}

/* =========================
   Constants
   ========================= */
const COACH_TRACKS = [
  { value: 'explain', label: 'Explain' },
  { value: 'debug', label: 'Debug' },
  { value: 'refactor', label: 'Refactor' },
  { value: 'complexity', label: 'Complexity' },
];

const INTERVIEW_TOPICS = [
  'Arrays / Strings',
  'Two Pointers',
  'Sliding Window',
  'Binary Search',
  'Hash Maps',
  'Stacks / Queues',
  'Graphs / BFS / DFS',
  'Trees / BST',
  'Dynamic Programming',
];

const SUPPORTED_LANGS = ['javascript', 'js', 'python'];

/* =========================
   Workspace stream helpers
   - Hide JSON block from bubble
   - Parse JSON when complete
   ========================= */
const WS_START = '<<<WORKSPACE_JSON';
const WS_END = '>>>';

function sanitizeForDisplay(raw) {
  const s = raw.indexOf(WS_START);
  if (s === -1) return raw;
  const e = raw.indexOf(WS_END, s + WS_START.length);
  if (e === -1) return raw.slice(0, s);
  return (raw.slice(0, s) + raw.slice(e + WS_END.length)).trimStart();
}

function parseWorkspaceIfComplete(raw) {
  const s = raw.indexOf(WS_START);
  if (s === -1) return null;
  const e = raw.indexOf(WS_END, s + WS_START.length);
  if (e === -1) return null;
  const jsonStr = raw.slice(s + WS_START.length, e).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/* =========================
   JS runner (Web Worker)
   ========================= */
function createJsRunnerWorker() {
  const blob = new Blob(
    [
      `
self.onmessage = async (e) => {
  const { code, tests, functionName } = e.data;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { try { logs.push(args.map(String).join(' ')); } catch {} };
  function eq(a,b){ try { return JSON.stringify(a) === JSON.stringify(b); } catch(_){ return a===b; } }
  try {
    const factory = new Function(code + "\\n; return (typeof " + functionName + " === 'function') ? " + functionName + " : undefined;");
    const fn = factory();
    if (!fn) throw new Error("Function '" + functionName + "' not found. Export it as a named function.");
    const results = [];
    for (const t of (tests || [])) {
      try {
        const got = fn.apply(null, t.args || []);
        results.push({ name: t.name || 'case', pass: eq(got, t.expect), got, expect: t.expect });
      } catch (err) {
        results.push({ name: t.name || 'case', pass: false, error: String(err) });
      }
    }
    postMessage({ type: 'done', results, logs });
  } catch (err) {
    postMessage({ type: 'error', error: String(err), logs });
  } finally {
    console.log = origLog;
  }
};
      `,
    ],
    { type: 'application/javascript' }
  );
  return new Worker(URL.createObjectURL(blob));
}

/* =========================
   Python runner (Pyodide)
   ========================= */
function createPyRunnerWorker() {
  const blob = new Blob(
    [
      `
let pyodidePromise;
self.onmessage = async (e) => {
  const { code, tests, functionName } = e.data;
  try {
    if (!pyodidePromise) {
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js');
      pyodidePromise = loadPyodide();
    }
    const pyodide = await pyodidePromise;

    await pyodide.runPythonAsync(code);

    const fn = pyodide.globals.get(functionName);
    if (!fn) throw new Error("Function '" + functionName + "' not found.");

    const results = [];
    for (const t of (tests || [])) {
      try {
        const pyArgs = (t.args || []).map(x => x);
        let got = fn(...pyArgs);
        if (got && typeof got.toJs === 'function') {
          got = got.toJs({ dict_converter: Object.fromEntries });
        }
        const pass = JSON.stringify(got) === JSON.stringify(t.expect);
        results.push({ name: t.name || 'case', pass, got, expect: t.expect });
      } catch (err) {
        results.push({ name: t.name || 'case', pass: false, error: String(err) });
      }
    }
    postMessage({ type: 'done', results, logs: [] });
  } catch (err) {
    postMessage({ type: 'error', error: String(err), logs: [] });
  }
};
      `,
    ],
    { type: 'application/javascript' }
  );
  return new Worker(URL.createObjectURL(blob));
}

/* =========================
   Main component
   ========================= */
export default function TestPage() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hey! I'm CodeBuddy. Pick a coach track or toggle Interview Mode to practice. Use “Attach code” to include your snippet.",
    },
  ]);
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');
  const [showCodePanel, setShowCodePanel] = useState(false);

  const [interviewMode, setInterviewMode] = useState(false);
  const [interviewTopic, setInterviewTopic] = useState(INTERVIEW_TOPICS[0]);
  const [autoAsk, setAutoAsk] = useState(true);
  const [autoStepsLeft, setAutoStepsLeft] = useState(3);

  const [coachMode, setCoachMode] = useState('debug');
  const [sending, setSending] = useState(false);

  // Workspace state
  const [workspace, setWorkspace] = useState(null); // {language,functionName,params,starterCode,tests}
  const [workspaceCode, setWorkspaceCode] = useState('');
  const [testResults, setTestResults] = useState(null);
  const [runnerBusy, setRunnerBusy] = useState(false);

  const listRef = useRef(null);
  const inputRef = useRef(null);

  // Streaming guards / refs
  const sendingRef = useRef(false);
  const abortRef = useRef(null);
  const reqIdRef = useRef(0);
  const lastChunkRef = useRef('');
  const rawAssistantBufRef = useRef('');
  const assistantIndexRef = useRef(null);

  // Runners
  const jsRunnerRef = useRef(null);
  const pyRunnerRef = useRef(null);
  useEffect(() => {
    jsRunnerRef.current = createJsRunnerWorker();
    pyRunnerRef.current = createPyRunnerWorker();

    const onMsg = (e) => {
      const { type, results, logs, error } = e.data || {};
      if (type === 'done') {
        setTestResults({ results, logs: logs || [], error: null });
      } else {
        setTestResults({ results: [], logs: logs || [], error: error || 'Unknown error' });
      }
      setRunnerBusy(false);
    };
    jsRunnerRef.current.onmessage = onMsg;
    pyRunnerRef.current.onmessage = onMsg;

    return () => {
      jsRunnerRef.current?.terminate();
      pyRunnerRef.current?.terminate();
    };
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  // Core send
  const send = async (userContent) => {
    if (!userContent && !code) return;
    if (sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setTestResults(null);

    const userMsg = { role: 'user', content: userContent || '(no prompt, code only)' };
    const history = [...messages, userMsg];
    setMessages(history);

    // assistant placeholder
    const assistantIndex = history.length;
    assistantIndexRef.current = assistantIndex;
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    // cancel any previous request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // bind to this request
    const myReqId = ++reqIdRef.current;
    lastChunkRef.current = '';
    rawAssistantBufRef.current = '';

    try {
      await askCodeBuddy({
        mode: interviewMode ? 'explain' : coachMode,
        messages: history,
        code,
        interviewer: interviewMode,
        topic: interviewMode ? interviewTopic : undefined,
        autoWorkspace: !!interviewMode, // ask for workspace automatically in interviewer mode
        signal: controller.signal,
        onChunk: (delta) => {
          if (myReqId !== reqIdRef.current) return;
          if (delta === lastChunkRef.current) return; // dev strict-mode micro-dup protection
          lastChunkRef.current = delta;

          // 1) accumulate raw stream
          rawAssistantBufRef.current += delta;

          // 2) parse workspace (once) when JSON block completes
          // NOTE: scope parsed object locally to avoid "ws is not defined"
          if (!workspace) {
            const parsed = parseWorkspaceIfComplete(rawAssistantBufRef.current);
            const langOk =
              parsed && SUPPORTED_LANGS.includes((parsed.language || '').toLowerCase());
            if (langOk && parsed.starterCode && parsed.functionName) {
              setWorkspace(parsed);
              setWorkspaceCode(parsed.starterCode);
            }
          }

          // 3) compute sanitized display text (JSON block hidden, even if partial)
          const visible = sanitizeForDisplay(rawAssistantBufRef.current);

          // 4) overwrite bubble with sanitized text
          setMessages((prev) => {
            const copy = [...prev];
            copy[assistantIndex] = {
              ...(copy[assistantIndex] || { role: 'assistant' }),
              content: visible,
            };
            return copy;
          });
        },
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages((prev) => {
          const copy = [...prev];
          copy[assistantIndex] = {
            role: 'assistant',
            content: '⚠️ ' + (e?.message || 'Something went wrong. Check server logs/API keys.'),
          };
          return copy;
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Auto-ask follow-ups in interviewer mode
  useEffect(() => {
    if (!interviewMode || !autoAsk || sending || autoStepsLeft <= 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && /\?\s*$/.test(last.content)) {
      const t = setTimeout(async () => {
        setAutoStepsLeft((n) => n - 1);
        await send('continue');
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [messages, interviewMode, autoAsk, sending, autoStepsLeft]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const content = input.trim();
    if (!content && !code) return;
    setInput('');
    await send(content);
    inputRef.current?.focus();
  };

  // Run workspace tests (JS or Python)
  const runWorkspaceTests = () => {
    if (!workspace || runnerBusy) return;
    setRunnerBusy(true);
    setTestResults(null);

    const payload = {
      code: workspaceCode,
      tests: workspace.tests || [],
      functionName: workspace.functionName,
    };

    const lang = (workspace.language || 'javascript').toLowerCase();
    if (lang === 'python') {
      pyRunnerRef.current.postMessage(payload);
    } else if (lang === 'javascript' || lang === 'js') {
      jsRunnerRef.current.postMessage(payload);
    } else {
      setRunnerBusy(false);
      setTestResults({ results: [], logs: [], error: `Runner not available for '${lang}'.` });
    }
  };

  // Tab/Shift+Tab indentation + Enter auto-indent inside workspace textarea
  function handleWorkspaceKeyDown(e) {
    // ----- TAB / SHIFT+TAB -----
    if (e.key === 'Tab') {
      e.preventDefault();

      const el = e.target;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const value = workspaceCode;

      if (start === end) {
        const insert = '  ';
        const updated = value.slice(0, start) + insert + value.slice(end);
        setWorkspaceCode(updated);
        queueMicrotask(() => {
          el.selectionStart = el.selectionEnd = start + insert.length;
        });
        return;
      }

      const before = value.slice(0, start);
      const selected = value.slice(start, end);
      const after = value.slice(end);
      const lines = selected.split('\n');

      if (e.shiftKey) {
        const unindented = lines
          .map((line) =>
            line.startsWith('\t') ? line.slice(1) : line.startsWith('  ') ? line.slice(2) : line
          )
          .join('\n');

        const updated = before + unindented + after;
        setWorkspaceCode(updated);
        queueMicrotask(() => {
          el.selectionStart = start;
          el.selectionEnd = start + unindented.length;
        });
      } else {
        const indented = lines.map((line) => '  ' + line).join('\n');
        const updated = before + indented + after;
        setWorkspaceCode(updated);
        queueMicrotask(() => {
          el.selectionStart = start + 2;
          el.selectionEnd = start + indented.length;
        });
      }
      return;
    }

    // ----- ENTER auto-indent -----
    if (e.key === 'Enter') {
      e.preventDefault();

      const el = e.target;
      const value = workspaceCode;
      const start = el.selectionStart;
      const end = el.selectionEnd;

      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const currentLine = value.slice(lineStart, start);
      const leadingWS = (currentLine.match(/^[\t ]*/) || [''])[0];

      // Extra indent for JS blocks { [ ( and Python ':'
      const trimmedSoFar = currentLine.trimEnd();
      const needsExtraIndent = /[{[(]$|:\s*$/.test(trimmedSoFar);
      const baseIndent = leadingWS;
      const extraIndent = needsExtraIndent ? '  ' : '';
      const insert = '\n' + baseIndent + extraIndent;

      const updated = value.slice(0, start) + insert + value.slice(end);
      setWorkspaceCode(updated);

      const newPos = start + insert.length;
      queueMicrotask(() => {
        el.selectionStart = el.selectionEnd = newPos;
      });
      return;
    }
  }

  return (
    <div className="flex h-screen w-full">
      {/* Left: Chat */}
      <div className="flex flex-col w-full md:w-2/3 border-r">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-white sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-gray-200" />
            <div className="font-semibold">CodeBuddy — Test DM</div>
          </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{interviewMode ? 'Interviewer Mode' : `Coach Mode: ${coachMode}`}</span>
          </div>
        </div>

        {/* Messages */}
        <div ref={listRef} className="flex-1 overflow-y-auto bg-gray-50 px-4 py-4 space-y-3">
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} content={m.content} />
          ))}
          {sending && <div className="text-xs text-gray-400 px-2">CodeBuddy is typing…</div>}
        </div>

        {/* Composer */}
        <form onSubmit={handleSubmit} className="border-t bg-white p-3 space-y-2">
          {/* Code toggle + status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowCodePanel((s) => !s)}
                className="text-sm px-2 py-1 rounded border hover:bg-gray-50"
              >
                {showCodePanel ? 'Hide code' : 'Attach code'}
              </button>
              {interviewMode && (
                <label className="text-xs flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoAsk}
                    onChange={(e) => setAutoAsk(e.target.checked)}
                  />
                  Auto-ask follow-ups
                </label>
              )}
            </div>
            {interviewMode && (
              <div className="text-xs text-gray-500">
                Topic: <span className="font-medium">{interviewTopic}</span>
              </div>
            )}
          </div>

          {/* Code panel */}
          {showCodePanel && (
            <textarea
              placeholder="Paste code here (optional)…"
              className="w-full h-36 resize-y rounded border p-2 font-mono text-sm"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          )}

          {/* Input row */}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              placeholder={
                interviewMode ? `Ask or respond… (topic: ${interviewTopic})` : 'Type a message…'
              }
              className="flex-1 rounded border px-3 py-2"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={sending}
            />
            <button
              type="submit"
              disabled={sending || (!input.trim() && !code)}
              className="rounded bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 disabled:opacity-60"
            >
              Send
            </button>
          </div>
        </form>
      </div>

      {/* Right: Controls + Quick Actions + Workspace */}
      <div className="flex flex-col w-full md:w-1/3">
        {/* Mode */}
        <div className="p-4 border-b">
          <div className="font-semibold mb-2">Mode</div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={interviewMode}
              onChange={(e) => {
                setInterviewMode(e.target.checked);
                if (e.target.checked) setAutoStepsLeft(3);
              }}
            />
            Interview Mode
          </label>

          {!interviewMode && (
            <div className="mt-3">
              <label className="text-xs text-gray-500">Coach Track</label>
              <select
                className="mt-1 w-full border rounded px-2 py-1 text-sm"
                value={coachMode}
                onChange={(e) => setCoachMode(e.target.value)}
              >
                {COACH_TRACKS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {interviewMode && (
            <div className="mt-3">
              <label className="text-xs text-gray-500">Interview Topic</label>
              <select
                className="mt-1 w-full border rounded px-2 py-1 text-sm"
                value={interviewTopic}
                onChange={(e) => setInterviewTopic(e.target.value)}
              >
                {INTERVIEW_TOPICS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>

              <div className="mt-2 text-xs text-gray-500">
                Tip: type <span className="font-mono">start interview</span> to kick it off.
              </div>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="p-4 border-b">
          <div className="font-semibold mb-2">Quick Actions</div>
          <div className="flex flex-wrap gap-2">
            <QuickButton onClick={() => { setInput('start interview'); inputRef.current?.focus(); }}>
              Start interview
            </QuickButton>
            <QuickButton onClick={() => { setInput('Explain Dijkstra vs BFS with a tiny example.'); inputRef.current?.focus(); }}>
              Explain
            </QuickButton>
            <QuickButton
              onClick={() => {
                setInput('What is wrong with this code? Give a minimal fix and a tiny test.');
                inputRef.current?.focus();
              }}
            >
              Debug
            </QuickButton>
            <QuickButton
              onClick={() => {
                setInput('Analyze time and space complexity and suggest one optimization.');
                inputRef.current?.focus();
              }}
            >
              Complexity
            </QuickButton>
          </div>
        </div>

        {/* Workspace Panel */}
        <div className="p-4 space-y-3">
          <div className="font-semibold">Workspace</div>
          {!workspace && (
            <div className="text-xs text-gray-500">
              When the assistant emits a workspace block, it will appear here.
            </div>
          )}

          {workspace && (
            <>
              <div className="text-xs text-gray-600">
                Language: <b>{workspace.language}</b> · Function: <b>{workspace.functionName}</b>{' '}
                {workspace.params?.length ? `(${workspace.params.join(', ')})` : ''}
              </div>

              <textarea
                className="w-full h-64 font-mono text-sm border rounded p-2"
                value={workspaceCode}
                onChange={(e) => setWorkspaceCode(e.target.value)}
                onKeyDown={handleWorkspaceKeyDown}
                spellCheck={false}
              />

              {SUPPORTED_LANGS.includes((workspace.language || '').toLowerCase()) ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={runWorkspaceTests}
                    disabled={runnerBusy}
                    className="text-sm px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-60"
                  >
                    {runnerBusy ? 'Running…' : 'Run Tests'}
                  </button>
                  <span className="text-xs text-gray-500">{workspace.tests?.length || 0} test(s)</span>
                </div>
              ) : (
                <div className="text-xs text-amber-700">
                  Running is supported for JavaScript and Python. Current language: {String(workspace.language)}
                </div>
              )}

              {testResults && (
                <div className="text-xs">
                  <div className="font-semibold mt-2">Results</div>
                  <ul className="list-disc pl-5 space-y-1">
                    {testResults.results.map((r, i) => (
                      <li key={i} className={r.pass ? 'text-green-700' : 'text-red-700'}>
                        {r.name}: {r.pass ? 'pass' : 'fail'}
                        {!r.pass && (
                          <>
                            {r.error ? (
                              <> — error: {r.error}</>
                            ) : (
                              <>
                                {' '}
                                — got: <code>{JSON.stringify(r.got)}</code>, expect:{' '}
                                <code>{JSON.stringify(r.expect)}</code>
                              </>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  {testResults.logs?.length ? (
                    <>
                      <div className="font-semibold mt-2">Console</div>
                      <pre className="bg-gray-100 p-2 rounded overflow-x-auto">
                        {testResults.logs.join('\n')}
                      </pre>
                    </>
                  ) : null}
                  {testResults.error && (
                    <div className="text-red-700 mt-2">Runner error: {testResults.error}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, content }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 whitespace-pre-wrap leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm'
            : 'bg-white border text-gray-900 rounded-tl-sm'
        }`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function QuickButton({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
    >
      {children}
    </button>
  );
}
