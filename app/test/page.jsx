// app/test/page.jsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/* =========================
   Streaming helper
   ========================= */
async function askCodeBuddy({
  mode,
  messages,
  code,
  interviewer,
  topic,
  autoWorkspace,
  currentProblemCode,
  requestNewProblem,
  onChunk,
  signal,
}) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      mode,
      messages,
      code,
      interviewer,
      topic,
      autoWorkspace,
      currentProblemCode,
      requestNewProblem,
    }),
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
   Main component
   ========================= */
export default function TestPage() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hey! I'm CodeBuddy, your interview practice assistant. Select a topic to start practicing coding interview problems. Use \"Attach code\" to include your snippet.",
    },
  ]);
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');
  const [showCodePanel, setShowCodePanel] = useState(false);

  const [interviewTopic, setInterviewTopic] = useState(INTERVIEW_TOPICS[0]);
  const [sending, setSending] = useState(false);

  // Workspace state
  const [workspace, setWorkspace] = useState(null); // {language,functionName,params,starterCode,tests}
  const [workspaceCode, setWorkspaceCode] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [testResults, setTestResults] = useState(null);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const runnerTimeoutRef = useRef(null);
  const clearRunnerTimer = useCallback(() => {
    if (runnerTimeoutRef.current) {
      clearTimeout(runnerTimeoutRef.current);
      runnerTimeoutRef.current = null;
    }
  }, []);

  const startRunnerTimer = useCallback(
    (durationMs = 45000, onTimeout) => {
      clearRunnerTimer();
      runnerTimeoutRef.current = setTimeout(() => {
        runnerTimeoutRef.current = null;
        setRunnerBusy(false);
        setTestResults({
          cases: [],
          error: 'Execution timed out. Check for infinite loops or try again.',
        });
        if (typeof onTimeout === 'function') {
          try {
            onTimeout();
          } catch (_) {
            // swallow
          }
        }
      }, durationMs);
    },
    [clearRunnerTimer]
  );

  const listRef = useRef(null);
  const inputRef = useRef(null);

  // Streaming guards / refs
  const sendingRef = useRef(false);
  const abortRef = useRef(null);
  const reqIdRef = useRef(0);
  const lastChunkRef = useRef('');
  const rawAssistantBufRef = useRef('');
  const assistantIndexRef = useRef(null);
  const workspaceRef = useRef(workspace);

  useEffect(() => () => clearRunnerTimer(), [clearRunnerTimer]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const deriveSuggestedInput = (ws) => {
    if (!ws?.tests?.length) return '';
    const first = ws.tests[0];
    if (!first?.args) return '';
    const params = ws.params || [];
    const lines = first.args.map((arg, idx) => {
      const label = params[idx] ? `${params[idx]} = ` : '';
      return `${label}${JSON.stringify(arg)}`;
    });
    return lines.join('\n');
  };

  // Auto-scroll chat
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const shouldRequestNewProblem = (content) => {
    const text = (content || '').trim();
    if (!text) return !workspaceRef.current;
    const lower = text.toLowerCase();

    // Existing workspace? If none, always request one.
    if (!workspaceRef.current) return true;

    // If user pasted code or attached code, assume they are continuing.
    const hasAttachedCode = !!code.trim();
    const looksLikeCode =
      /```/.test(text) ||
      /def\s+\w+\s*\(/.test(text) ||
      /class\s+\w+/.test(text);
    if (hasAttachedCode || looksLikeCode) return false;

    // If explicitly referencing continuing/help, keep same problem.
    if (
      /\b(hint|help|complexity|edge case|follow ?up|continue|still|test case|testcase|example|examples|constraints|analysis|approach|solution|explain)\b/.test(
        lower
      )
    ) {
      return false;
    }

    // Heuristics: explicit ask for a new problem/question.
    if (
      /\bnew\s+(problem|question)\b/.test(lower) ||
      /\banother\s+(problem|question)\b/.test(lower) ||
      (lower.startsWith('give me') && /\b(problem|question)\b/.test(lower)) ||
      (lower.startsWith('ask me') && /\b(problem|question)\b/.test(lower)) ||
      /\bgive\s+me\b.*\bproblem\b/.test(lower)
    ) {
      return true;
    }

    // If user references a specific topic and requests "problem" or "question".
    if (/\b(problem|question)\b/.test(lower) && !/\bprevious\b/.test(lower)) {
      return true;
    }

    return false;
  };

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

    const requestNewProblem = shouldRequestNewProblem(userContent);
    const currentProblemCode = workspaceRef.current?.problemCode;
    const hasActiveProblem = !!currentProblemCode;

    if (hasActiveProblem && requestNewProblem) {
      sendingRef.current = false;
      setSending(false);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'You already have an active problem. Click "End interview" to start a new one.',
        },
      ]);
      return;
    }

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
        mode: 'explain',
        messages: history,
        code,
        interviewer: true,
        topic: interviewTopic,
        autoWorkspace: true, // always ask for workspace in interview mode
        currentProblemCode,
        requestNewProblem,
        signal: controller.signal,
        onChunk: (delta) => {
          if (myReqId !== reqIdRef.current) return;
          if (delta === lastChunkRef.current) return; // dev strict-mode micro-dup protection
          lastChunkRef.current = delta;

          // 1) accumulate raw stream
          rawAssistantBufRef.current += delta;

          // 2) parse workspace (once) when JSON block completes
          // NOTE: scope parsed object locally to avoid "ws is not defined"
          const parsed = parseWorkspaceIfComplete(rawAssistantBufRef.current);
          const langOk =
            parsed && SUPPORTED_LANGS.includes((parsed.language || '').toLowerCase());
          if (langOk && parsed?.starterCode && parsed?.functionName) {
            const current = workspaceRef.current;
            const isDifferent =
              !current ||
              current.functionName !== parsed.functionName ||
              JSON.stringify(current.params || []) !== JSON.stringify(parsed.params || []) ||
              JSON.stringify(current.tests || []) !== JSON.stringify(parsed.tests || []) ||
              current.starterCode !== parsed.starterCode ||
              current.problemCode !== parsed.problemCode ||
              current.referenceSolution !== parsed.referenceSolution;
            if (isDifferent) {
              workspaceRef.current = parsed;
              setWorkspace(parsed);
              setWorkspaceCode(parsed.starterCode);
              setCustomInput(deriveSuggestedInput(parsed));
              setTestResults(null);
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    const content = input.trim();
    if (!content && !code) return;
    setInput('');
    await send(content);
    inputRef.current?.focus();
  };

  const parseCustomCases = (raw, ws) => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return [];

    const paramNames = ws?.params || [];
    const paramCount = paramNames.length;

    const parseValue = (valueRaw) => {
      let valueStr = valueRaw.trim();
      if (!valueStr.length) return '';

      const nameMatch = valueStr.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
      if (nameMatch) valueStr = nameMatch[2].trim();

      try {
        return JSON.parse(valueStr);
      } catch {}

      const pythonish = valueStr
        .replace(/\bNone\b/g, 'null')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false');
      try {
        return JSON.parse(pythonish);
      } catch {}

      try {
        // eslint-disable-next-line no-new-func
        return Function(`"use strict"; return (${valueStr});`)();
      } catch {}
      return valueStr;
    };

    const blocks = trimmed
      .split(/\n\s*\n/)
      .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
      .filter((lines) => lines.length);

    if (!blocks.length) return [];

    return blocks.map((lines, blockIndex) => {
      const args = [];
      if (paramCount === 0) {
        lines.forEach((line) => {
          if (line.length) args.push(parseValue(line));
        });
      } else {
        if (lines.length !== paramCount) {
          throw new Error(
            `Expected ${paramCount} argument${paramCount === 1 ? '' : 's'} on separate lines (blank line to separate cases).`
          );
        }
        lines.forEach((line) => {
          args.push(parseValue(line));
        });
      }

      return {
        name: `Case ${blockIndex + 1}`,
        args,
      };
    });
  };

  // Run workspace evaluation against remote sandbox
  const runWorkspaceEvaluation = async () => {
    if (!workspace || runnerBusy) return;

    let cases = [];
    try {
      cases = parseCustomCases(customInput, workspace);
    } catch (err) {
      setTestResults({ cases: [], error: err?.message || 'Invalid custom input.' });
      return;
    }

    if (!cases.length) {
      setTestResults({ cases: [], error: 'Provide at least one test case.' });
      return;
    }

    const lang = (workspace.language || '').toLowerCase();
    if (lang !== 'python') {
      setTestResults({ cases: [], error: `Remote runner currently supports only Python workspaces (got '${workspace.language}').` });
      return;
    }

    if (!workspace.referenceSolution) {
      setTestResults({ cases: [], error: 'Reference solution unavailable for this workspace.' });
      return;
    }

    setRunnerBusy(true);
    setTestResults(null);

    const controller = new AbortController();
    startRunnerTimer(45000, () => controller.abort());

    try {
      const resp = await fetch('/api/runner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          language: 'python',
          code: workspaceCode || '',
          functionName: workspace.functionName,
          referenceCode: workspace.referenceSolution,
          tests: cases.map((c) => ({ name: c.name, args: c.args })),
          timeoutMs: 5000,
        }),
      });

      clearRunnerTimer();

      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(body?.error || 'Remote runner failed.');
      }

      const status = body.status || 'ok';
      const summaryError =
        status === 'error'
          ? body.message || body.error || 'Runner error'
          : status === 'failed'
          ? 'Some test cases failed.'
          : status === 'timeout'
          ? 'Execution timed out.'
          : null;
      const detailMessage =
        body.details ||
        (status === 'error' && (body.error || body.message)) ||
        null;

      setTestResults({
        status,
        cases: body.results || [],
        error: summaryError,
        details: detailMessage,
      });
    } catch (err) {
      clearRunnerTimer();
      setTestResults({
        cases: [],
        error: err?.name === 'AbortError' ? 'Runner aborted.' : err?.message || 'Runner error',
      });
    } finally {
      setRunnerBusy(false);
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
            <div className="flex flex-col items-end text-xs text-gray-500">
              <span className="font-medium">Interview Mode</span>
              <span className="text-gray-600">
                Topic: <span className="font-semibold">{interviewTopic}</span>
              </span>
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
          {/* Input row */}
          <div className="flex gap-2">
            <input
              ref={inputRef}
              placeholder={`Ask or respond… (topic: ${interviewTopic})`}
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
        {/* Interview Settings */}
        <div className="p-4 border-b">
          <div className="font-semibold mb-2">Interview Settings</div>
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
        </div>

        {/* Quick Actions */}
        <div className="p-4 border-b">
          <div className="font-semibold mb-2">Quick Actions</div>
          <div className="flex flex-wrap gap-2">
            <QuickButton onClick={() => { setInput('start interview'); inputRef.current?.focus(); }}>
              Start interview
            </QuickButton>
            <QuickButton onClick={() => {
              workspaceRef.current = null;
              setWorkspace(null);
              setWorkspaceCode('');
              setCustomInput('');
              setTestResults(null);
              setMessages([
                {
                  role: 'assistant',
                  content:
                    "Hey! I'm CodeBuddy, your interview practice assistant. Select a topic to start practicing coding interview problems.",
                },
              ]);
              setInput('');
              setCode('');
            }}>
              End interview
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
                <>
                  <div>
                    <label className="text-xs text-gray-500">Custom Input</label>
                    <textarea
                      className="w-full mt-1 h-28 font-mono text-xs border rounded p-2"
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      placeholder={'nums = [2,7,11,15]\\ntarget = 2'}
                      spellCheck={false}
                    />
                    <div className="text-[10px] text-gray-500 mt-1">
                      Enter each argument on its own line (optionally <code>name = value</code>). Use a blank line between cases, just like LeetCode inputs.
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      type="button"
                      onClick={runWorkspaceEvaluation}
                      disabled={runnerBusy}
                      className="text-sm px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-60"
                    >
                      {runnerBusy ? 'Running…' : 'Run Custom Input'}
                    </button>
                  </div>
                  {testResults && (
                    <div className="text-xs mt-3 space-y-2">
                      {testResults.status && (
                        <div className="text-blue-600">{testResults.status}</div>
                      )}
                      {testResults.error && (
                        <div className="text-red-700">{testResults.error}</div>
                      )}
                      {testResults.details && (
                        <pre className="bg-rose-50 border border-rose-200 text-rose-700 rounded p-2 whitespace-pre-wrap break-words">
                          {testResults.details}
                        </pre>
                      )}
                      {(() => {
                        const stdoutAggregate = (testResults.cases || [])
                          .map((t) => t?.userStdout ?? t?.stdout ?? '')
                          .filter(Boolean)
                          .join('\n');
                        if (!stdoutAggregate) return null;
                        return (
                          <div>
                            <div className="font-semibold">Stdout</div>
                            <pre className="bg-gray-100 border border-gray-200 rounded p-2 whitespace-pre-wrap break-words">
                              {stdoutAggregate}
                            </pre>
                          </div>
                        );
                      })()}
                      {testResults.cases?.length
                        ? (
                          <div>
                            <div className="font-semibold mb-1">Comparison</div>
                            <ul className="space-y-1">
                              {testResults.cases.map((t, i) => {
                                const userStdout = t?.userStdout ?? t?.stdout ?? '';
                                const referenceStdout = t?.referenceStdout ?? t?.reference_stdout ?? '';
                                return (
                                  <li key={i} className={t.pass ? 'text-green-700' : 'text-red-700'}>
                                    <div>
                                      <span className="font-semibold">{t.name}</span>: {t.pass ? 'match ✅' : 'mismatch ❌'}
                                    </div>
                                    {t.userError ? (
                                      <div>User error: {t.userError}</div>
                                    ) : (
                                      <div>Your output: <code>{JSON.stringify(t.userResult ?? t.got)}</code></div>
                                    )}
                                    {userStdout && (
                                      <div>
                                        Case stdout:
                                        <pre className="bg-gray-100 mt-1 rounded p-2 whitespace-pre-wrap break-words">
                                          {userStdout}
                                        </pre>
                                      </div>
                                    )}
                                    {t.referenceError ? (
                                      <div>Reference error: {t.referenceError}</div>
                                    ) : (
                                      <>
                                        {typeof (t.referenceResult ?? t.expect) !== 'undefined' && (
                                          <div>Reference: <code>{JSON.stringify(t.referenceResult ?? t.expect)}</code></div>
                                        )}
                                        {referenceStdout && (
                                          <div>
                                            Reference stdout:
                                            <pre className="bg-gray-100 mt-1 rounded p-2 whitespace-pre-wrap break-words">
                                              {referenceStdout}
                                            </pre>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )
                        : null}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-amber-700">
                  Running is supported for JavaScript and Python. Current language: {String(workspace.language)}
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
