import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { Language, RunCreated, RunRequest, RunStatus, TraceEvent } from '@visualmyalgo/protocol';
import { create } from 'zustand';
import { buildExecutionPayload, detectFunction, smartDefault, type FunctionInfo } from './harness';
import { eventAt, nextByDepth } from './trace';
import './styles.css';
import './workspace-enhancements.css';

const starters: Record<Language, string> = {
  javascript: `function binarySearch(values, target) {\n  let low = 0;\n  let high = values.length - 1;\n\n  while (low <= high) {\n    const middle = Math.floor((low + high) / 2);\n    if (values[middle] === target) return middle;\n    if (values[middle] < target) low = middle + 1;\n    else high = middle - 1;\n  }\n  return -1;\n}`,
  python: `def binary_search(values, target):\n    low, high = 0, len(values) - 1\n    while low <= high:\n        middle = (low + high) // 2\n        if values[middle] == target:\n            return middle\n        if values[middle] < target:\n            low = middle + 1\n        else:\n            high = middle - 1\n    return -1`,
  cpp: `#include <iostream>\n#include <vector>\nusing namespace std;\n\nint main() {\n  vector<int> values = {3, 8, 13, 21, 34};\n  int target = 21;\n  for (int i = 0; i < values.size(); i++) {\n    if (values[i] == target) {\n      cout << i << endl;\n      return 0;\n    }\n  }\n}`,
  java: `class Solution {\n  public int[] twoSum(int[] nums, int target) {\n    for (int i = 0; i < nums.length; i++) {\n      for (int j = i + 1; j < nums.length; j++) {\n        if (nums[i] + nums[j] == target) return new int[]{i, j};\n      }\n    }\n    return new int[]{};\n  }\n}`,
};

type ArrayVisual = { name: string; values: string[]; line: number };

function detectArrays(code: string): ArrayVisual[] {
  const arrays: ArrayVisual[] = [];
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\[([^\]]+)\]/g,
    /\b([A-Za-z_]\w*)\s*=\s*\[([^\]]+)\]/g,
    /\b(?:vector\s*<[^>]+>|(?:int|long|double|String|Integer)\s*\[\])\s+([A-Za-z_]\w*)\s*=\s*(?:new\s+\w+\s*\[\]\s*)?\{([^}]+)\}/g,
    /\b(?:List\s*<[^>]+>|list)\s+([A-Za-z_]\w*)\s*=\s*(?:List\.of|list)\(([^)]+)\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      const values = match[2].split(',').map(value => value.trim()).filter(Boolean);
      if (values.length) arrays.push({ name: match[1], values, line: code.slice(0, match.index).split('\n').length });
    }
  }
  return arrays.filter((array, index) => arrays.findIndex(item => item.name === array.name) === index);
}

function activeIndexFor(arrayName: string, line: string) {
  const match = line.match(new RegExp(`\\b${arrayName}\\s*\\[\\s*(\\d+)\\s*\\]`));
  return match ? Number(match[1]) : undefined;
}

type LocalValue = string | number | boolean | null | Array<string | number | boolean | null>;
type Locals = Record<string, LocalValue>;

const POINTER_ROLES: Record<string, string> = {
  low: 'low', lo: 'low', left: 'low', start: 'low',
  high: 'high', hi: 'high', right: 'high', end: 'high',
  middle: 'mid', mid: 'mid',
  i: 'i', j: 'j', k: 'k',
};

function inputValue(value: string): LocalValue {
  const cleaned = value.trim();
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch { /* keep the learner's original value below */ }
  if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned);
  if (cleaned === 'true' || cleaned === 'false') return cleaned === 'true';
  return cleaned.replace(/^['"]|['"]$/g, '');
}

function evaluateExpression(expression: string, locals: Locals): LocalValue | undefined {
  const trimmed = expression.trim().replace(/;$/, '');
  const arrayLiteral = /^\s*\[([^\]]*)\]\s*$/.exec(trimmed);
  if (arrayLiteral) {
    return arrayLiteral[1].split(',').map(item => {
      const value = inputValue(item);
      return Array.isArray(value) ? JSON.stringify(value) : value;
    });
  }

  let numeric = trimmed
    .replace(/\bMath\.(?:floor|ceil|round|trunc)\s*\(/g, match => match)
    .replace(/\b([A-Za-z_]\w*)\.length\b/g, (_, key) => Array.isArray(locals[key]) ? String((locals[key] as unknown[]).length) : '0')
    .replace(/\b([A-Za-z_]\w*)\b/g, (match, key) => {
      if (match.startsWith('Math')) return match;
      if (typeof locals[key] === 'number') return String(locals[key]);
      if (typeof locals[key] === 'boolean') return locals[key] ? 'true' : 'false';
      return match;
    });

  if (/^(?:Math\.(?:floor|ceil|round|trunc)\s*)?[\d\s+\-*/().,]+$/.test(numeric) || /^Math\.(?:floor|ceil|round|trunc)\([^)]+\)$/.test(numeric)) {
    try { return Function(`"use strict"; return (${numeric})`)() as number; } catch { /* fall through */ }
  }
  if (/^[\d\s+\-*/().]+$/.test(numeric)) {
    try { return Function(`"use strict"; return (${numeric})`)() as number; } catch { /* fall through */ }
  }
  return inputValue(trimmed);
}

function assignFromLine(sourceLine: string, locals: Locals) {
  const trimmed = sourceLine.trim().replace(/;?\s*(?:\/\/.*)?$/, '');
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('if ') || trimmed.startsWith('while ') || trimmed.startsWith('for ') || trimmed.startsWith('return ')) return;

  const declaration = /^(?:const|let|var|int|long|double|float|boolean|String|Integer)\s+([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(trimmed);
  const assignment = !declaration ? /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(trimmed) : null;
  const match = declaration || assignment;
  if (!match) return;

  const [, name, rawExpression] = match;
  const expression = rawExpression.trim();
  if (!expression) return;
  const value = evaluateExpression(expression, locals);
  if (value !== undefined) locals[name] = value;
}

function traceLocals(code: string, line: number, fn: FunctionInfo | undefined, inputs: Record<string, string>) {
  const locals: Locals = {};
  fn?.parameters.forEach(parameter => { locals[parameter.name] = inputValue(inputs[parameter.name] ?? smartDefault(parameter)); });
  const lines = code.split('\n').slice(0, Math.max(0, line));
  for (const sourceLine of lines) assignFromLine(sourceLine, locals);
  return locals;
}

function enrichTrace(event: TraceEvent, code: string, fn: FunctionInfo | undefined, inputs: Record<string, string>): TraceEvent {
  if (event.stack.some(frame => Object.keys(frame.locals || {}).length > 0)) return event;
  const locals = traceLocals(code, event.line, fn, inputs);
  return { ...event, stack: [{ name: fn?.name || 'main', line: event.line, locals }] };
}

function shouldInstrument(trimmed: string) {
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) return false;
  if (/^[)}\]]/.test(trimmed)) return false; // closing braces/parens/brackets and callback tails
  if (trimmed === '{' || trimmed.startsWith('else') || trimmed.startsWith('catch') || trimmed.startsWith('finally')) return false;
  if (trimmed.startsWith('function ') || trimmed.startsWith('class ') || trimmed.startsWith('import ') || trimmed.startsWith('export ')) return false;
  if (trimmed.startsWith('.')) return false; // method-chain continuation
  if (/^[{[]/.test(trimmed)) return false; // object/array literal lines
  if (/^[A-Za-z_$][\w$]*\s*:/.test(trimmed)) return false; // object property
  if (/^[A-Za-z_$][\w$]*\s*,\s*$/.test(trimmed)) return false; // shorthand property
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return false; // bare identifier (expression continuation)
  if (/,\s*$/.test(trimmed) && !/[=;]/.test(trimmed)) return false; // list/object continuation
  if (/^(?:async\s+)?function\b/.test(trimmed)) return false;
  return true;
}

const JS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'of',
  'Math', 'console', 'Object', 'Array', 'String', 'Number', 'Boolean', 'JSON', 'Infinity', 'NaN', 'Promise', 'Map', 'Set',
  'Date', 'Error', 'RegExp', 'Symbol', 'Proxy', 'Reflect', 'Intl', 'window', 'document', 'globalThis', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);

function watchNamesFromCode(code: string) {
  const names = new Set(['low', 'high', 'mid', 'middle', 'left', 'right', 'i', 'j', 'k', 'target', 'values', 'nums', 'arr', 'n', 'sum', 'data', 'cache', 'result']);
  for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const name = match[1];
    if (JS_RESERVED.has(name)) continue;
    if (/^[A-Z]/.test(name) && name === name.toUpperCase()) continue; // ALLCAPS constants often not locals
    if (/^[A-Z]/.test(name)) continue; // skip capitalized identifiers / constructors / string-like tokens
    names.add(name);
  }
  return [...names].slice(0, 40);
}

function instrumentJavaScript(code: string) {
  const fields = watchNamesFromCode(code).map(name => `${name}:(()=>{try{return ${name}}catch{return void 0}})()`).join(',');
  const snapshot = `__vma(__line, {${fields}})`;
  const lines = code.split('\n');
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (!shouldInstrument(trimmed)) return line;
    const indent = /^\s*/.exec(line)?.[0] || '';
    const injected = snapshot.replace('__line', String(index + 1));
    // Always prefix — never insert after a line, or we can split mid-expression
    // (arrays, object literals, chained calls, etc.) and cause Unexpected token ';'.
    return `${indent}${injected}; ${trimmed}`;
  }).join('\n');
}

function sanitizeLocals(locals: Record<string, unknown>): Locals {
  const result: Locals = {};
  for (const [key, value] of Object.entries(locals)) {
    if (value === undefined) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.map(item => (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? item : JSON.stringify(item)));
    else result[key] = JSON.stringify(value);
  }
  return result;
}

async function traceJavaScript(code: string, breakpoints: number[], fn: FunctionInfo | undefined, inputs: Record<string, string>) {
  const started = Date.now();
  const payload = buildExecutionPayload('javascript', code, fn, inputs);
  const maxEditorLine = code.split('\n').length;
  const events: TraceEvent[] = [];
  let output = '';
  let errorMessage: string | undefined;
  const fakeConsole = {
    log: (...args: unknown[]) => {
      output += `${args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`;
    },
  };

  try {
    // Instrumented user JS for educational stepping; not a security boundary.
    // eslint-disable-next-line no-new-func
    const runner = new Function('__vma', 'console', `"use strict";\nreturn (async () => {\n${instrumentJavaScript(payload)}\n})();`);
    await runner((line: number, locals: Record<string, unknown>) => {
      if (line > maxEditorLine) return;
      const clean = sanitizeLocals(locals);
      fn?.parameters.forEach(parameter => {
        if (clean[parameter.name] === undefined) clean[parameter.name] = inputValue(inputs[parameter.name] ?? smartDefault(parameter));
      });
      events.push({
        id: events.length,
        line,
        type: breakpoints.includes(line) ? 'breakpoint' : 'step',
        stack: [{ name: fn?.name || 'main', line, locals: clean }],
        elapsedMs: Date.now() - started,
      });
    }, fakeConsole);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'JavaScript execution failed.';
    events.push({
      id: events.length,
      line: events.at(-1)?.line || 1,
      type: 'error',
      stack: [{ name: fn?.name || 'main', line: events.at(-1)?.line || 1, locals: {} }],
      message: errorMessage,
      elapsedMs: Date.now() - started,
    });
  }

  if (output) {
    events.push({
      id: events.length,
      line: events.at(-1)?.line || maxEditorLine,
      type: 'stdout',
      stack: events.at(-1)?.stack || [{ name: fn?.name || 'main', line: maxEditorLine, locals: {} }],
      output,
      elapsedMs: Date.now() - started,
    });
  }

  return {
    events,
    status: (errorMessage ? 'runtime-error' : 'completed') as RunStatus,
    message: errorMessage,
  };
}

function pointerMarks(locals: Locals, arrayLength: number) {
  const marks = new Map<number, { role: string; labels: string[] }>();
  for (const [name, value] of Object.entries(locals)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= arrayLength) continue;
    const role = POINTER_ROLES[name.toLowerCase()];
    if (!role) continue;
    const existing = marks.get(value) || { role, labels: [] };
    if (!existing.labels.includes(name)) existing.labels.push(name);
    if (role === 'mid' || existing.role === 'mid') existing.role = role === 'mid' ? 'mid' : existing.role;
    marks.set(value, existing);
  }
  return marks;
}

function rangeBounds(locals: Locals, arrayLength: number) {
  const low = ['low', 'lo', 'left', 'start'].map(name => locals[name]).find(value => typeof value === 'number') as number | undefined;
  const high = ['high', 'hi', 'right', 'end'].map(name => locals[name]).find(value => typeof value === 'number') as number | undefined;
  if (typeof low !== 'number' || typeof high !== 'number') return undefined;
  return { low: Math.max(0, low), high: Math.min(arrayLength - 1, high) };
}

function stepNarrative(lineText: string, locals: Locals) {
  const compare = /\b([A-Za-z_]\w*)\s*\[\s*([A-Za-z_]\w*|\d+)\s*\]\s*(===|==|!==|!=|<|>|<=|>=)\s*([A-Za-z_]\w*|-?\d+)/.exec(lineText);
  if (compare) {
    const [, arrayName, indexToken, operator, rightToken] = compare;
    const index = /^\d+$/.test(indexToken) ? Number(indexToken) : locals[indexToken];
    const left = typeof index === 'number' && Array.isArray(locals[arrayName]) ? (locals[arrayName] as LocalValue[])[index] : undefined;
    const right = /^\-?\d+$/.test(rightToken) ? Number(rightToken) : locals[rightToken];
    if (left !== undefined && right !== undefined) return `Compare ${arrayName}[${index}] (${JSON.stringify(left)}) ${operator} ${JSON.stringify(right)}`;
  }
  const assign = /^\s*(?:const|let|var)?\s*([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(lineText.trim());
  if (assign && locals[assign[1]] !== undefined) return `Set ${assign[1]} = ${JSON.stringify(locals[assign[1]])}`;
  return undefined;
}

interface WorkspaceState {
  language: Language;
  code: string;
  stdin: string;
  breakpoints: number[];
  events: TraceEvent[];
  cursor: number;
  status: RunStatus | 'idle';
  autoRun: boolean;
  speed: number;
  theme: 'light' | 'dark';
  set: (patch: Partial<WorkspaceState>) => void;
}

const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const useWorkspace = create<WorkspaceState>((set) => ({
  language: 'javascript', code: starters.javascript, stdin: '', breakpoints: [], events: [], cursor: 0,
  status: 'idle', autoRun: false, speed: 1,
  theme: (localStorage.getItem('visualmyalgo-theme') as 'light' | 'dark') || preferredTheme,
  set,
}));

const Icon = ({ children }: { children: React.ReactNode }) => <span className="icon" aria-hidden="true">{children}</span>;

function App() {
  const state = useWorkspace();
  const [isPlaying, setPlaying] = useState(false);
  const [error, setError] = useState<string>();
  const [functionInputs, setFunctionInputs] = useState<Record<string, string>>({});
  const sourceRef = useRef<EventSource>();
  const activeRunRef = useRef<string>();
  const timerRef = useRef<number>();
  const runRef = useRef(0);
  const current = eventAt(state.events, state.cursor);
  const functionInfo = useMemo(() => detectFunction(state.code, state.language), [state.code, state.language]);
  const baseArrays = useMemo(() => {
    const declared = detectArrays(state.code);
    const parameterArrays = (functionInfo?.parameters || []).flatMap(parameter => {
      const input = functionInputs[parameter.name]?.trim();
      if (!input?.startsWith('[') || !input.endsWith(']')) return [];
      return [{ name: parameter.name, values: input.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean), line: functionInfo?.line || 1 }];
    });
    return [...parameterArrays, ...declared.filter(array => !parameterArrays.some(item => item.name === array.name))];
  }, [state.code, functionInfo, functionInputs]);

  const stopPlayback = useCallback(() => { setPlaying(false); if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  const cancel = useCallback(() => { sourceRef.current?.close(); if (activeRunRef.current) void fetch(`/api/runs/${activeRunRef.current}`, { method: 'DELETE' }); activeRunRef.current = undefined; stopPlayback(); }, [stopPlayback]);

  const run = useCallback(async () => {
    cancel(); setError(undefined); const requestId = ++runRef.current;
    const workspace = useWorkspace.getState();
    workspace.set({ events: [], cursor: 0, status: 'queued' });

    // JavaScript uses an in-browser instrumented tracer so loops/variables animate correctly.
    if (workspace.language === 'javascript') {
      workspace.set({ status: 'running' });
      const result = await traceJavaScript(workspace.code, workspace.breakpoints, functionInfo, functionInputs);
      if (requestId !== runRef.current) return;
      workspace.set({ events: result.events, cursor: 0, status: result.status });
      if (result.message) setError(result.message);
      return;
    }

    try {
      const payload: RunRequest = {
        language: workspace.language,
        code: buildExecutionPayload(workspace.language, workspace.code, functionInfo, functionInputs),
        stdin: workspace.stdin,
        breakpoints: workspace.breakpoints,
      };
      const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message || 'Unable to start this run.');
      }
      const { eventsUrl, runId } = await response.json() as RunCreated;
      if (requestId !== runRef.current) return;
      activeRunRef.current = runId;
      workspace.set({ status: 'running' });
      const stream = new EventSource(eventsUrl); sourceRef.current = stream;
      stream.addEventListener('trace', (message) => {
        if (requestId !== runRef.current) return;
        const editorLines = workspace.code.split('\n').length;
        const incoming = JSON.parse((message as MessageEvent).data) as TraceEvent;
        // Keep stdout/error even if they land on harness lines; drop harness-only steps.
        if ((incoming.type === 'step' || incoming.type === 'breakpoint') && incoming.line > editorLines) return;
        const trace = enrichTrace(incoming, workspace.code, functionInfo, functionInputs);
        const events = [...useWorkspace.getState().events, trace];
        useWorkspace.getState().set({ events, cursor: events.length === 1 ? 0 : useWorkspace.getState().cursor });
      });
      stream.addEventListener('complete', (message) => {
        if (requestId !== runRef.current) return;
        const result = JSON.parse((message as MessageEvent).data) as { status: RunStatus; message?: string };
        useWorkspace.getState().set({ status: result.status });
        activeRunRef.current = undefined;
        if (result.message) setError(result.message);
        stream.close();
      });
      stream.onerror = () => {
        if (requestId !== runRef.current) return;
        stream.close();
        if (useWorkspace.getState().status !== 'running') return;
        activeRunRef.current = undefined;
        useWorkspace.getState().set({ status: 'runtime-error' });
        setError('The execution stream was interrupted. If you are running Python, C++, or Java, confirm Docker Desktop is running.');
      };
    } catch (runError) {
      useWorkspace.getState().set({ status: 'runtime-error', events: [], cursor: 0 });
      setError(runError instanceof Error ? runError.message : 'Unable to run code.');
    }
  }, [cancel, functionInfo, functionInputs]);

  useEffect(() => () => cancel(), [cancel]);
  useEffect(() => {
    if (!functionInfo) return;
    setFunctionInputs(previous => {
      const next = { ...previous };
      let changed = false;
      for (const parameter of functionInfo.parameters) {
        if (next[parameter.name] === undefined || next[parameter.name] === '') {
          next[parameter.name] = smartDefault(parameter);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [functionInfo]);
  useEffect(() => { document.documentElement.dataset.theme = state.theme; localStorage.setItem('visualmyalgo-theme', state.theme); }, [state.theme]);
  useEffect(() => {
    if (!state.autoRun) return;
    const id = window.setTimeout(() => run(), 850);
    return () => window.clearTimeout(id);
  }, [state.code, state.language, state.autoRun, run]);
  useEffect(() => {
    if (!isPlaying) return;
    if (state.cursor >= state.events.length - 1) { setPlaying(false); return; }
    timerRef.current = window.setTimeout(() => state.set({ cursor: state.cursor + 1 }), 900 / state.speed);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, [isPlaying, state.cursor, state.events.length, state.speed, state.set]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target?.closest('input, textarea, select, [contenteditable="true"]')
        || target?.closest('.monaco-editor'),
      );
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); run(); return; }
      if (event.key === ' ' && !typing) { event.preventDefault(); setPlaying(value => !value); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const changeLanguage = (language: Language) => {
    if (language !== 'javascript') return;
    state.set({ language, code: starters[language], events: [], cursor: 0, status: 'idle', breakpoints: [] });
  };
  const updateCode = (code: string) => {
    // Non-JS runtimes are temporarily disabled until the Docker/API path is solid.
    state.set({ code, language: 'javascript', events: [], cursor: 0, status: 'idle' });
  };
  const toggleBreakpoint = (line: number) => state.set({ breakpoints: state.breakpoints.includes(line) ? state.breakpoints.filter(item => item !== line) : [...state.breakpoints, line].sort((a, b) => a - b) });
  const onEditorMount: OnMount = (editor) => editor.onMouseDown((event) => { if (event.target.type === 2 && event.target.position) toggleBreakpoint(event.target.position.lineNumber); });
  const locals = current?.stack[current.stack.length - 1]?.locals || {};
  const arrays = useMemo(() => {
    const fromLocals = Object.entries(locals).flatMap(([name, value]) => {
      if (!Array.isArray(value) || !value.length) return [];
      return [{ name, values: value.map(item => String(item)), line: functionInfo?.line || 1 }];
    });
    const merged = [...fromLocals, ...baseArrays];
    return merged.filter((array, index) => merged.findIndex(item => item.name === array.name) === index);
  }, [baseArrays, functionInfo?.line, locals]);
  const output = state.events.filter(event => event.output).map(event => event.output).join('');
  const statusLabel = state.status.replace('-', ' ');
  const activeSource = current ? state.code.split('\n')[current.line - 1] || '' : '';
  const narrative = current ? stepNarrative(activeSource, locals as Locals) : undefined;

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">⌁</div><span>Visual<span>My</span>Algo</span><small>trace studio</small></div>
      <div className="header-actions"><kbd>⌘ Enter</kbd><span className={`status ${state.status}`}>{statusLabel}</span><button className="theme-button" onClick={() => state.set({ theme: state.theme === 'dark' ? 'light' : 'dark' })} aria-label="Toggle color theme"><Icon>{state.theme === 'dark' ? '☀' : '◐'}</Icon>{state.theme === 'dark' ? 'Light' : 'Dark'}</button></div>
    </header>
    <section className="workspace">
      <aside className="editor-pane pane">
        <div className="pane-heading"><div><span className="eyebrow">Source code</span><h1>Make every line visible.</h1></div><button className="run-button" onClick={run} disabled={state.status === 'running'}><Icon>▶</Icon>{state.status === 'running' ? 'Tracing…' : 'Run code'}</button></div>
        <div className="editor-toolbar"><label>Language<select value="javascript" onChange={event => changeLanguage(event.target.value as Language)}>{(['javascript', 'python', 'cpp', 'java'] as Language[]).map(language => <option key={language} value={language} disabled={language !== 'javascript'}>{language === 'cpp' ? 'C++' : language[0].toUpperCase() + language.slice(1)}{language !== 'javascript' ? ' (soon)' : ''}</option>)}</select></label><label className="toggle"><input type="checkbox" checked={state.autoRun} onChange={event => state.set({ autoRun: event.target.checked })}/><span/>Auto-run</label></div>
        {functionInfo && <section className="function-inputs"><div><span className="eyebrow">Function detected</span><h3>{functionInfo.name}<small>(…)</small></h3><p>Enter a test value for each parameter. Arrays use JSON style, for example <code>[2, 7, 11, 15]</code>.</p></div><div className="parameter-fields">{functionInfo.parameters.map(parameter => <label key={parameter.name}><span>{parameter.name}{parameter.type ? ` · ${parameter.type}` : ''}</span><input value={functionInputs[parameter.name] ?? ''} placeholder={smartDefault(parameter)} onChange={event => setFunctionInputs(inputs => ({ ...inputs, [parameter.name]: event.target.value }))}/></label>)}</div></section>}
        <div className="code-editor"><Editor height="100%" language={state.language === 'cpp' ? 'cpp' : state.language} value={state.code} onChange={value => updateCode(value || '')} theme={state.theme === 'dark' ? 'vs-dark' : 'light'} onMount={onEditorMount} options={{ minimap: { enabled: false }, fontSize: 14, lineNumbers: (line) => state.breakpoints.includes(line) ? `● ${line}` : String(line), glyphMargin: true, scrollBeyondLastLine: false, padding: { top: 16 } }}/></div>
        <label className="stdin-label">Program input<textarea value={state.stdin} placeholder="Optional standard input…" onChange={event => state.set({ stdin: event.target.value })}/></label>
      </aside>
      <section className="visual-pane pane">
        <div className="pane-heading"><div><span className="eyebrow">Live execution</span><h2>{current ? `Line ${current.line}` : 'Ready to trace'}</h2></div><span className="step-count">{state.events.length ? `${state.cursor + 1} / ${state.events.length} steps` : 'No steps yet'}</span></div>
        <div className="code-focus"><span className="line-label">{current?.line ?? '—'}</span><code>{current?.type === 'error' ? current.message : current ? activeSource : 'Run your program to inspect every decision.'}</code></div>
        {narrative && <p className="step-narrative">{narrative}</p>}
        <section className="execution-source" aria-label="Execution source code">
          <div className="execution-source-heading"><span>Source navigator</span><small>{current ? `following line ${current.line}` : 'run to begin'}</small></div>
          <pre>{state.code.split('\n').map((line, index) => <div className={current?.line === index + 1 ? 'active-source-line' : ''} key={index}><span>{index + 1}</span><code>{line || ' '}</code></div>)}</pre>
        </section>
        {arrays.length > 0 && <section className="array-stage" aria-label="Array visualizations">
          <div className="array-stage-heading"><div><span className="eyebrow">Data visualization</span><h3>Arrays in memory</h3></div><span>{arrays.reduce((total, array) => total + array.values.length, 0)} values</span></div>
          {arrays.map(array => {
            const activeIndex = activeIndexFor(array.name, activeSource);
            const marks = pointerMarks(locals as Locals, array.values.length);
            const bounds = rangeBounds(locals as Locals, array.values.length);
            return <div className="array-visual" key={array.name}>
              <div className="array-name"><code>{array.name}</code><small>defined on line {array.line}</small></div>
              <div className="array-cells">{array.values.map((value, index) => {
                const mark = marks.get(index);
                const inRange = bounds ? index >= bounds.low && index <= bounds.high : false;
                const classes = [
                  'array-cell',
                  activeIndex === index ? 'is-active' : '',
                  mark ? `is-pointer is-${mark.role}` : '',
                  inRange ? 'is-in-range' : bounds ? 'is-out-of-range' : '',
                ].filter(Boolean).join(' ');
                return <div className={classes} key={`${array.name}-${index}-${state.cursor}`}>
                  {mark && <em className="pointer-label">{mark.labels.join(' · ')}</em>}
                  <strong>{value}</strong>
                  <span>[{index}]</span>
                </div>;
              })}</div>
            </div>;
          })}
        </section>}
        <div className="timeline" aria-label="Execution timeline"><input type="range" min="0" max={Math.max(0, state.events.length - 1)} value={state.cursor} disabled={!state.events.length} onChange={event => { stopPlayback(); state.set({ cursor: Number(event.target.value) }); }}/><div className="timeline-labels"><span>Start</span><span>{current?.elapsedMs ?? 0} ms</span><span>Complete</span></div></div>
        <div className="visual-grid">
          <StateCard title="Call stack" empty="No active frames"><ol className="stack-list">{current?.stack.slice().reverse().map((frame, index) => <li key={`${frame.name}-${index}`}><strong>{frame.name}()</strong><span>line {frame.line}</span></li>)}</ol></StateCard>
          <StateCard title="Variables" empty="Variables appear as code executes"><div className="variables">{Object.entries(locals).map(([name, value]) => <div key={name}><span>{name}</span><code>{JSON.stringify(value)}</code></div>)}</div></StateCard>
          <StateCard title="Console" empty="Program output will appear here"><pre className="console-output">{output}</pre></StateCard>
          <StateCard title="Debugger note" empty="">{error ? <pre className="error-text compile-error">{error}</pre> : <p className="muted">{narrative || current?.message || (state.events.length ? 'Timeline ready. Press Play to step through each line, or Skip to end for the final result.' : 'Click Run to build a debug timeline. Then choose Play (step through) or Skip to end.')}</p>}</StateCard>
        </div>
      </section>
      <aside className="control-pane pane">
        <span className="eyebrow">Debugger</span><h2>Control the journey.</h2>
        <div className="transport"><button onClick={() => { stopPlayback(); state.set({ cursor: 0 }); }} aria-label="Restart"><Icon>↺</Icon></button><button onClick={() => { if (state.events.length) setPlaying(value => !value); }} className="primary-control" aria-label={isPlaying ? 'Pause' : 'Play'}><Icon>{isPlaying ? 'Ⅱ' : '▶'}</Icon></button><button onClick={() => { stopPlayback(); state.set({ cursor: Math.min(state.events.length - 1, state.cursor + 1) }); }} aria-label="Step into"><Icon>↓</Icon></button></div>
        <div className="step-actions"><button onClick={() => { stopPlayback(); state.set({ cursor: nextByDepth(state.events, state.cursor, 'over') }); }}>Step over <kbd>F10</kbd></button><button onClick={() => { stopPlayback(); state.set({ cursor: nextByDepth(state.events, state.cursor, 'out') }); }}>Step out <kbd>⇧ F11</kbd></button><button onClick={() => { stopPlayback(); state.set({ cursor: Math.max(0, state.cursor - 1) }); }}>Previous <kbd>←</kbd></button><button disabled={!state.events.length} onClick={() => { stopPlayback(); state.set({ cursor: Math.max(0, state.events.length - 1) }); }}>Skip to end</button></div>
        <div className="speed-control"><div><span>Playback speed</span><strong>{state.speed}×</strong></div><input type="range" min="0.5" max="4" step="0.5" value={state.speed} onChange={event => state.set({ speed: Number(event.target.value) })}/></div>
        <section className="breakpoints"><div className="section-title"><span>Breakpoints</span><small>{state.breakpoints.length}</small></div>{state.breakpoints.length ? <ul>{state.breakpoints.map(line => <li key={line}><button onClick={() => state.set({ cursor: Math.max(0, state.events.findIndex(event => event.line === line)) })}>Line {line}</button><button onClick={() => toggleBreakpoint(line)} aria-label={`Remove breakpoint at line ${line}`}>×</button></li>)}</ul> : <p>Click an editor line number to pause on it.</p>}</section>
        <div className="shortcut-note"><kbd>⌘ Enter</kbd> run (build timeline)<br/><kbd>Space</kbd> play / pause steps<br/>Skip to end = final result</div>
      </aside>
    </section>
  </main>;
}

function StateCard({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) { return <section className="state-card"><h3>{title}</h3>{React.Children.count(children) ? children : <p>{empty}</p>}</section>; }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
