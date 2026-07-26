import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { Language, RunCreated, RunRequest, RunStatus, TraceEvent } from '@visualmyalgo/protocol';
import { create } from 'zustand';
import { eventAt, nextByDepth } from './trace';
import './styles.css';
import './workspace-enhancements.css';

const starters: Record<Language, string> = {
  javascript: `function binarySearch(values, target) {\n  let low = 0;\n  let high = values.length - 1;\n\n  while (low <= high) {\n    const middle = Math.floor((low + high) / 2);\n    if (values[middle] === target) return middle;\n    if (values[middle] < target) low = middle + 1;\n    else high = middle - 1;\n  }\n  return -1;\n}\n\nconsole.log(binarySearch([3, 8, 13, 21, 34], 21));`,
  python: `def binary_search(values, target):\n    low, high = 0, len(values) - 1\n    while low <= high:\n        middle = (low + high) // 2\n        if values[middle] == target:\n            return middle\n        if values[middle] < target:\n            low = middle + 1\n        else:\n            high = middle - 1\n    return -1\n\nprint(binary_search([3, 8, 13, 21, 34], 21))`,
  cpp: `#include <iostream>\n#include <vector>\nusing namespace std;\n\nint main() {\n  vector<int> values = {3, 8, 13, 21, 34};\n  int target = 21;\n  for (int i = 0; i < values.size(); i++) {\n    if (values[i] == target) {\n      cout << i << endl;\n      return 0;\n    }\n  }\n}`,
  java: `import java.util.List;\n\nclass Main {\n  public static void main(String[] args) {\n    List<Integer> values = List.of(3, 8, 13, 21, 34);\n    int target = 21;\n    for (int i = 0; i < values.size(); i++) {\n      if (values.get(i) == target) {\n        System.out.println(i);\n        return;\n      }\n    }\n  }\n}`,
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

type FunctionParameter = { name: string; type?: string };
type FunctionInfo = { name: string; parameters: FunctionParameter[]; line: number };

function detectLanguage(code: string, current: Language): Language {
  if (/^\s*#include\b|\bstd::|\bvector\s*</m.test(code)) return 'cpp';
  if (/\b(class\s+\w+|public\s+(?:static\s+)?(?:int|void|String|boolean)|System\.out\.)/.test(code)) return 'java';
  if (/^\s*def\s+\w+\s*\(|^\s*(?:from|import)\s+\w+/m.test(code)) return 'python';
  if (/\b(?:const|let|var|function)\b|=>|console\./.test(code)) return 'javascript';
  return current;
}

function parseParameters(source: string, language: Language): FunctionParameter[] {
  if (!source.trim()) return [];
  return source.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    if (language === 'javascript' || language === 'python') {
      const name = item.split(/[=:]/)[0].trim().replace(/^\.\.\./, '');
      return { name, type: item.includes(':') ? item.split(':')[1].trim() : undefined };
    }
    const parts = item.replace(/final\s+/g, '').trim().split(/\s+/);
    return { name: parts.at(-1) || 'value', type: parts.slice(0, -1).join(' ') };
  });
}

function detectFunction(code: string, language: Language): FunctionInfo | undefined {
  const patterns: Record<Language, RegExp[]> = {
    javascript: [/function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/, /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\(([^)]*)\)\s*=>/],
    python: [/def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/],
    java: [/(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/],
    cpp: [/[\w<>:&*]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/],
  };
  for (const pattern of patterns[language]) {
    const match = pattern.exec(code);
    if (match && match[1] !== 'main') return { name: match[1], parameters: parseParameters(match[2], language), line: code.slice(0, match.index).split('\n').length };
  }
  return undefined;
}

function defaultArgument(parameter: FunctionParameter) {
  return parameter.type?.includes('[]') || parameter.type?.includes('List') || parameter.type?.includes('vector') ? '[]' : '0';
}

function javaArgument(value: string, type = '') {
  const input = value.trim() || defaultArgument({ name: '', type });
  if (type.includes('[]') && input.startsWith('[')) return `new ${type.replace(/\s/g, '')}{${input.slice(1, -1)}}`;
  return input;
}

function executionCode(language: Language, code: string, fn: FunctionInfo | undefined, inputs: Record<string, string>) {
  if (!fn || !fn.parameters.length) return code;
  const values = fn.parameters.map(parameter => inputs[parameter.name] ?? defaultArgument(parameter));
  if (language === 'javascript') return `${code}\n\nconsole.log(${fn.name}(${values.join(', ')}));`;
  if (language === 'python') return `${code}\n\nprint(${fn.name}(${values.join(', ')}))`;
  if (language === 'java' && !/static\s+void\s+main\s*\(/.test(code)) {
    const className = /class\s+([A-Za-z_]\w*)/.exec(code)?.[1] || 'Solution';
    const args = fn.parameters.map((parameter, index) => javaArgument(values[index], parameter.type)).join(', ');
    return `${code}\n\nclass Main { public static void main(String[] args) { Object result = new ${className}().${fn.name}(${args}); if (result instanceof int[]) System.out.println(java.util.Arrays.toString((int[]) result)); else System.out.println(result); } }`;
  }
  if (language === 'cpp' && !/\bint\s+main\s*\(/.test(code)) return `#include <iostream>\n${code}\nint main() { auto result = Solution().${fn.name}(${values.join(', ')}); std::cout << "Function completed" << std::endl; }`;
  return code;
}

function inputValue(value: string): string | number | boolean | null | Array<string | number | boolean | null> {
  const cleaned = value.trim();
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch { /* keep the learner's original value below */ }
  if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned);
  if (cleaned === 'true' || cleaned === 'false') return cleaned === 'true';
  return cleaned.replace(/^['"]|['"]$/g, '');
}

function traceLocals(code: string, line: number, fn: FunctionInfo | undefined, inputs: Record<string, string>) {
  const locals: Record<string, string | number | boolean | null | Array<string | number | boolean | null>> = {};
  fn?.parameters.forEach(parameter => { locals[parameter.name] = inputValue(inputs[parameter.name] ?? defaultArgument(parameter)); });
  const lines = code.split('\n').slice(0, Math.max(0, line));
  for (const sourceLine of lines) {
    const declaration = /\b(?:const|let|var|int|long|double|float|boolean|String|Integer)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);?/.exec(sourceLine);
    if (!declaration) continue;
    const [, name, expression] = declaration;
    const arrayLiteral = /^\s*\[([^\]]*)\]/.exec(expression);
    if (arrayLiteral) { locals[name] = arrayLiteral[1].split(',').map(item => { const value = inputValue(item); return Array.isArray(value) ? JSON.stringify(value) : value; }); continue; }
    let numeric = expression.replace(/\b([A-Za-z_]\w*)\.length\b/g, (_, key) => Array.isArray(locals[key]) ? String(locals[key].length) : '0');
    numeric = numeric.replace(/\b([A-Za-z_]\w*)\b/g, (_, key) => typeof locals[key] === 'number' ? String(locals[key]) : key);
    if (/^[\d\s+\-*/().]+$/.test(numeric)) {
      try { locals[name] = Function(`"use strict"; return (${numeric})`)(); continue; } catch { /* use text below */ }
    }
    locals[name] = inputValue(expression.replace(/;$/, ''));
  }
  return locals;
}

function enrichTrace(event: TraceEvent, code: string, fn: FunctionInfo | undefined, inputs: Record<string, string>): TraceEvent {
  const locals = traceLocals(code, event.line, fn, inputs);
  return { ...event, stack: [{ name: fn?.name || 'main', line: event.line, locals }] };
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
  const arrays = useMemo(() => {
    const declared = detectArrays(state.code);
    const parameterArrays = (functionInfo?.parameters || []).flatMap(parameter => {
      const input = functionInputs[parameter.name]?.trim();
      if (!input?.startsWith('[') || !input.endsWith(']')) return [];
      return [{ name: parameter.name, values: input.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean), line: functionInfo?.line || 1 }];
    });
    return [...declared, ...parameterArrays.filter(array => !declared.some(item => item.name === array.name))];
  }, [state.code, functionInfo, functionInputs]);

  const stopPlayback = useCallback(() => { setPlaying(false); if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  const cancel = useCallback(() => { sourceRef.current?.close(); if (activeRunRef.current) void fetch(`/api/runs/${activeRunRef.current}`, { method: 'DELETE' }); activeRunRef.current = undefined; stopPlayback(); }, [stopPlayback]);

  const run = useCallback(async () => {
    cancel(); setError(undefined); const requestId = ++runRef.current;
    const workspace = useWorkspace.getState();
    workspace.set({ events: [], cursor: 0, status: 'queued' });
    try {
      const payload: RunRequest = { language: workspace.language, code: executionCode(workspace.language, workspace.code, functionInfo, functionInputs), stdin: workspace.stdin, breakpoints: workspace.breakpoints };
      const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || 'Unable to start this run.');
      const { eventsUrl, runId } = await response.json() as RunCreated;
      if (requestId !== runRef.current) return;
      activeRunRef.current = runId;
      workspace.set({ status: 'running' });
      const stream = new EventSource(eventsUrl); sourceRef.current = stream;
      stream.addEventListener('trace', (message) => {
        if (requestId !== runRef.current) return;
        const trace = enrichTrace(JSON.parse((message as MessageEvent).data) as TraceEvent, workspace.code, functionInfo, functionInputs);
        const events = [...useWorkspace.getState().events, trace];
        useWorkspace.getState().set({ events, cursor: events.length === 1 ? 0 : useWorkspace.getState().cursor });
      });
      stream.addEventListener('complete', (message) => {
        if (requestId !== runRef.current) return;
        const result = JSON.parse((message as MessageEvent).data) as { status: RunStatus; message?: string };
        useWorkspace.getState().set({ status: result.status }); activeRunRef.current = undefined; if (result.message) setError(result.message); stream.close();
      });
      stream.onerror = () => { if (requestId === runRef.current && useWorkspace.getState().status === 'running') setError('The execution stream was interrupted.'); };
    } catch (runError) { useWorkspace.getState().set({ status: 'runtime-error' }); setError(runError instanceof Error ? runError.message : 'Unable to run code.'); }
  }, [cancel, functionInfo, functionInputs]);

  useEffect(() => () => cancel(), [cancel]);
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
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); run(); }
      if (event.key === ' ' && document.activeElement?.tagName !== 'TEXTAREA') { event.preventDefault(); setPlaying(value => !value); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const changeLanguage = (language: Language) => state.set({ language, code: starters[language], events: [], cursor: 0, status: 'idle', breakpoints: [] });
  const updateCode = (code: string) => {
    const language = detectLanguage(code, state.language);
    state.set({ code, language, events: [], cursor: 0, status: 'idle' });
  };
  const toggleBreakpoint = (line: number) => state.set({ breakpoints: state.breakpoints.includes(line) ? state.breakpoints.filter(item => item !== line) : [...state.breakpoints, line].sort((a, b) => a - b) });
  const onEditorMount: OnMount = (editor) => editor.onMouseDown((event) => { if (event.target.type === 2 && event.target.position) toggleBreakpoint(event.target.position.lineNumber); });
  const locals = current?.stack[current.stack.length - 1]?.locals || {};
  const output = state.events.filter(event => event.output).map(event => event.output).join('');
  const statusLabel = state.status.replace('-', ' ');
  const activeSource = current ? state.code.split('\n')[current.line - 1] || '' : '';

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">⌁</div><span>Visual<span>My</span>Algo</span><small>trace studio</small></div>
      <div className="header-actions"><kbd>⌘ Enter</kbd><span className={`status ${state.status}`}>{statusLabel}</span><button className="theme-button" onClick={() => state.set({ theme: state.theme === 'dark' ? 'light' : 'dark' })} aria-label="Toggle color theme"><Icon>{state.theme === 'dark' ? '☀' : '◐'}</Icon>{state.theme === 'dark' ? 'Light' : 'Dark'}</button></div>
    </header>
    <section className="workspace">
      <aside className="editor-pane pane">
        <div className="pane-heading"><div><span className="eyebrow">Source code</span><h1>Make every line visible.</h1></div><button className="run-button" onClick={run} disabled={state.status === 'running'}><Icon>▶</Icon>{state.status === 'running' ? 'Tracing…' : 'Run code'}</button></div>
        <div className="editor-toolbar"><label>Language<select value={state.language} onChange={event => changeLanguage(event.target.value as Language)}>{(['javascript', 'python', 'cpp', 'java'] as Language[]).map(language => <option key={language} value={language}>{language === 'cpp' ? 'C++' : language[0].toUpperCase() + language.slice(1)}</option>)}</select></label><label className="toggle"><input type="checkbox" checked={state.autoRun} onChange={event => state.set({ autoRun: event.target.checked })}/><span/>Auto-run</label></div>
        {functionInfo && <section className="function-inputs"><div><span className="eyebrow">Function detected</span><h3>{functionInfo.name}<small>(…)</small></h3><p>Enter a test value for each parameter. Arrays use JSON style, for example <code>[2, 7, 11, 15]</code>.</p></div><div className="parameter-fields">{functionInfo.parameters.map(parameter => <label key={parameter.name}><span>{parameter.name}{parameter.type ? ` · ${parameter.type}` : ''}</span><input value={functionInputs[parameter.name] ?? ''} placeholder={defaultArgument(parameter)} onChange={event => setFunctionInputs(inputs => ({ ...inputs, [parameter.name]: event.target.value }))}/></label>)}</div></section>}
        <div className="code-editor"><Editor height="100%" language={state.language === 'cpp' ? 'cpp' : state.language} value={state.code} onChange={value => updateCode(value || '')} theme={state.theme === 'dark' ? 'vs-dark' : 'light'} onMount={onEditorMount} options={{ minimap: { enabled: false }, fontSize: 14, lineNumbers: (line) => state.breakpoints.includes(line) ? `● ${line}` : String(line), glyphMargin: true, scrollBeyondLastLine: false, padding: { top: 16 } }}/></div>
        <label className="stdin-label">Program input<textarea value={state.stdin} placeholder="Optional standard input…" onChange={event => state.set({ stdin: event.target.value })}/></label>
      </aside>
      <section className="visual-pane pane">
        <div className="pane-heading"><div><span className="eyebrow">Live execution</span><h2>{current ? `Line ${current.line}` : 'Ready to trace'}</h2></div><span className="step-count">{state.events.length ? `${state.cursor + 1} / ${state.events.length} steps` : 'No steps yet'}</span></div>
        <div className="code-focus"><span className="line-label">{current?.line ?? '—'}</span><code>{current?.type === 'error' ? current.message : current ? activeSource : 'Run your program to inspect every decision.'}</code></div>
        <section className="execution-source" aria-label="Execution source code">
          <div className="execution-source-heading"><span>Source navigator</span><small>{current ? `following line ${current.line}` : 'run to begin'}</small></div>
          <pre>{state.code.split('\n').map((line, index) => <div className={current?.line === index + 1 ? 'active-source-line' : ''} key={index}><span>{index + 1}</span><code>{line || ' '}</code></div>)}</pre>
        </section>
        {arrays.length > 0 && <section className="array-stage" aria-label="Array visualizations">
          <div className="array-stage-heading"><div><span className="eyebrow">Data visualization</span><h3>Arrays in memory</h3></div><span>{arrays.reduce((total, array) => total + array.values.length, 0)} values</span></div>
          {arrays.map(array => { const activeIndex = activeIndexFor(array.name, activeSource); return <div className="array-visual" key={array.name}>
            <div className="array-name"><code>{array.name}</code><small>defined on line {array.line}</small></div>
            <div className="array-cells">{array.values.map((value, index) => <div className={`array-cell ${activeIndex === index ? 'is-active' : ''}`} key={`${array.name}-${index}`}><strong>{value}</strong><span>[{index}]</span></div>)}</div>
          </div>; })}
        </section>}
        <div className="timeline" aria-label="Execution timeline"><input type="range" min="0" max={Math.max(0, state.events.length - 1)} value={state.cursor} disabled={!state.events.length} onChange={event => { stopPlayback(); state.set({ cursor: Number(event.target.value) }); }}/><div className="timeline-labels"><span>Start</span><span>{current?.elapsedMs ?? 0} ms</span><span>Complete</span></div></div>
        <div className="visual-grid">
          <StateCard title="Call stack" empty="No active frames"><ol className="stack-list">{current?.stack.slice().reverse().map((frame, index) => <li key={`${frame.name}-${index}`}><strong>{frame.name}()</strong><span>line {frame.line}</span></li>)}</ol></StateCard>
          <StateCard title="Variables" empty="Variables appear as code executes"><div className="variables">{Object.entries(locals).map(([name, value]) => <div key={name}><span>{name}</span><code>{JSON.stringify(value)}</code></div>)}</div></StateCard>
          <StateCard title="Console" empty="Program output will appear here"><pre className="console-output">{output}</pre></StateCard>
          <StateCard title="Debugger note" empty=""><p className={error ? 'error-text' : 'muted'}>{error || current?.message || 'Click a line number to add a breakpoint. Use the controls to explore the trace.'}</p></StateCard>
        </div>
      </section>
      <aside className="control-pane pane">
        <span className="eyebrow">Debugger</span><h2>Control the journey.</h2>
        <div className="transport"><button onClick={() => { stopPlayback(); state.set({ cursor: 0 }); }} aria-label="Restart"><Icon>↺</Icon></button><button onClick={() => { if (state.events.length) setPlaying(value => !value); }} className="primary-control" aria-label={isPlaying ? 'Pause' : 'Play'}><Icon>{isPlaying ? 'Ⅱ' : '▶'}</Icon></button><button onClick={() => { stopPlayback(); state.set({ cursor: Math.min(state.events.length - 1, state.cursor + 1) }); }} aria-label="Step into"><Icon>↓</Icon></button></div>
        <div className="step-actions"><button onClick={() => { stopPlayback(); state.set({ cursor: nextByDepth(state.events, state.cursor, 'over') }); }}>Step over <kbd>F10</kbd></button><button onClick={() => { stopPlayback(); state.set({ cursor: nextByDepth(state.events, state.cursor, 'out') }); }}>Step out <kbd>⇧ F11</kbd></button><button onClick={() => { stopPlayback(); state.set({ cursor: Math.max(0, state.cursor - 1) }); }}>Previous <kbd>←</kbd></button></div>
        <div className="speed-control"><div><span>Playback speed</span><strong>{state.speed}×</strong></div><input type="range" min="0.5" max="4" step="0.5" value={state.speed} onChange={event => state.set({ speed: Number(event.target.value) })}/></div>
        <section className="breakpoints"><div className="section-title"><span>Breakpoints</span><small>{state.breakpoints.length}</small></div>{state.breakpoints.length ? <ul>{state.breakpoints.map(line => <li key={line}><button onClick={() => state.set({ cursor: Math.max(0, state.events.findIndex(event => event.line === line)) })}>Line {line}</button><button onClick={() => toggleBreakpoint(line)} aria-label={`Remove breakpoint at line ${line}`}>×</button></li>)}</ul> : <p>Click an editor line number to pause on it.</p>}</section>
        <div className="shortcut-note"><kbd>Space</kbd> play / pause <br/><kbd>⌘ Enter</kbd> run code</div>
      </aside>
    </section>
  </main>;
}

function StateCard({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) { return <section className="state-card"><h3>{title}</h3>{React.Children.count(children) ? children : <p>{empty}</p>}</section>; }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
