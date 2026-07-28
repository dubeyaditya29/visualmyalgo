import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Language, RunRequest, RunStatus, SerializableValue, StackFrame, TraceEvent } from '@visualmyalgo/protocol';
import { generatePythonTracer, parseVmaTraceLines, type RawTracePayload } from './pythonTracer.js';

const LIMITS = { sourceBytes: 100_000, outputBytes: 64_000, timeoutMs: 20_000, queueSize: 20, maxTraceEvents: 8_000 };

type Run = { id: string; request: RunRequest; status: RunStatus | 'queued'; events: EventEmitter; history: TraceEvent[]; result?: { status: RunStatus; message?: string }; cancelled: boolean; controller?: AbortController };
type Command = { image: string; files: Array<{ filename: string; contents: string }>; args: string[] };

export function executableLines(code: string) {
  return code.split('\n').flatMap((line, index) => line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('#') ? [index + 1] : []);
}

function baseEvent(id: number, line: number, type: TraceEvent['type'], elapsedMs: number, message?: string, output?: string, stack?: StackFrame[]): TraceEvent {
  return { id, line, type, elapsedMs, stack: stack || [{ name: 'main', line, locals: {} }], message, output };
}

function toSerializable(value: unknown, depth = 0): SerializableValue {
  if (depth > 4) return String(value);
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 60).map(item => toSerializable(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, SerializableValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      result[key] = toSerializable(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function normalizeTrace(raw: RawTracePayload, id: number, fallbackElapsed: number): TraceEvent {
  const line = Number(raw.line) || 1;
  const stack = (raw.stack || [{ name: 'main', line, locals: {} }]).map(frame => ({
    name: frame.name || 'main',
    line: Number(frame.line) || line,
    locals: Object.fromEntries(Object.entries(frame.locals || {}).map(([key, value]) => [key, toSerializable(value)])),
  }));
  return {
    id,
    line,
    type: raw.type === 'breakpoint' || raw.type === 'error' || raw.type === 'stdout' || raw.type === 'stderr' ? raw.type : 'step',
    stack,
    message: raw.message,
    output: raw.output,
    elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : fallbackElapsed,
  };
}

export async function checkDocker(timeoutMs = 2500): Promise<boolean> {
  return await new Promise(resolve => {
    const child = spawn('docker', ['info'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function classifyFailure(stderr: string, code: number | null): { status: RunStatus; message: string } {
  const message = stderr.trim() || (code === null ? 'Execution failed.' : `Program exited with status ${code}.`);
  if (/Cannot connect to the Docker daemon|docker\.sock|Is the docker daemon running|executable file not found in \$PATH|ENOENT/i.test(message)) {
    return {
      status: 'runtime-error',
      message: 'Docker is not available. Start Docker Desktop, then click Run again. Java, Python, and C++ need Docker to execute.',
    };
  }
  if (/error:|SyntaxError|cannot find symbol|compilation|javac|g\+\+|Traceback \(most recent call last\):/i.test(message) || /Main\.java:\d+:\s*error:/i.test(message)) {
    const isSyntax = /SyntaxError|javac|error:|cannot find symbol|compilation failed/i.test(message);
    return { status: isSyntax ? 'compile-error' : 'runtime-error', message };
  }
  return { status: 'runtime-error', message };
}

function buildCommand(request: RunRequest): Command {
  if (request.language === 'python') {
    return {
      image: 'python:3.12-alpine',
      files: [
        { filename: 'program.py', contents: request.code },
        { filename: 'main.py', contents: generatePythonTracer(request.breakpoints, LIMITS.maxTraceEvents) },
      ],
      args: ['python', '/workspace/main.py'],
    };
  }
  if (request.language === 'javascript') {
    return { image: 'node:20-alpine', files: [{ filename: 'main.js', contents: request.code }], args: ['node', '/workspace/main.js'] };
  }
  if (request.language === 'cpp') {
    return { image: 'gcc:14', files: [{ filename: 'main.cpp', contents: request.code }], args: ['sh', '-lc', 'g++ -g /workspace/main.cpp -o /tmp/main && /tmp/main'] };
  }
  return {
    image: 'eclipse-temurin:21-jdk',
    files: [{ filename: 'Main.java', contents: request.code }],
    args: ['sh', '-lc', 'javac -g /workspace/Main.java -d /tmp && java -cp /tmp Main'],
  };
}

async function executeInContainer(request: RunRequest, signal: AbortSignal) {
  const command = buildCommand(request);
  const directory = await mkdtemp(join(tmpdir(), 'visualmyalgo-'));
  await Promise.all(command.files.map(file => writeFile(join(directory, file.filename), file.contents, { mode: 0o600 })));
  try {
    return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, command.image, ...command.args,
      ], { stdio: ['pipe', 'pipe', 'pipe'], signal });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout = (stdout + data).slice(0, LIMITS.outputBytes); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(0, LIMITS.outputBytes * 4); });
      child.on('error', reject);
      child.on('close', exitCode => resolve({ stdout, stderr, code: exitCode }));
      if (request.stdin) child.stdin.write(request.stdin);
      child.stdin.end();
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export class RunManager {
  private runs = new Map<string, Run>();
  private pending = 0;

  create(request: RunRequest) {
    if (Buffer.byteLength(request.code) > LIMITS.sourceBytes) throw new Error('Source code must be under 100 KB.');
    if (this.pending >= LIMITS.queueSize) throw new Error('The run queue is full. Please try again shortly.');
    const run: Run = { id: randomUUID(), request, status: 'queued', events: new EventEmitter(), history: [], cancelled: false };
    this.runs.set(run.id, run); this.pending += 1;
    void this.process(run);
    return run;
  }

  get(id: string) { return this.runs.get(id); }
  cancel(id: string) { const run = this.runs.get(id); if (!run) return false; run.cancelled = true; run.controller?.abort(); run.status = 'cancelled'; return true; }

  private emit(run: Run, type: 'trace' | 'complete', payload: unknown) { if (type === 'trace') run.history.push(payload as TraceEvent); run.events.emit(type, payload); }
  private finish(run: Run, status: RunStatus, message?: string) {
    run.status = status; run.result = { status, message }; this.pending -= 1; this.emit(run, 'complete', run.result);
    setTimeout(() => this.runs.delete(run.id), 60_000).unref();
  }

  private async process(run: Run) {
    run.status = 'running'; const started = Date.now(); let eventId = 0;
    const send = (event: TraceEvent) => { if (!run.cancelled) this.emit(run, 'trace', event); };
    run.controller = new AbortController();
    const timeout = setTimeout(() => run.controller?.abort(), LIMITS.timeoutMs);

    try {
      const result = await executeInContainer(run.request, run.controller.signal);
      if (run.cancelled) return this.finish(run, 'cancelled');

      if (run.request.language === 'python') {
        const parsed = parseVmaTraceLines(result.stderr);
        for (const raw of parsed.traces.slice(0, LIMITS.maxTraceEvents)) {
          send(normalizeTrace(raw, eventId++, Date.now() - started));
        }
        if (result.stdout) {
          send(baseEvent(eventId++, parsed.traces.at(-1)?.line || 1, 'stdout', Date.now() - started, undefined, result.stdout));
        }
        if (result.code !== 0) {
          const failure = classifyFailure(parsed.remainder || result.stdout, result.code);
          if (!parsed.traces.some(item => item.type === 'error')) {
            send(baseEvent(eventId, 1, 'error', Date.now() - started, failure.message));
          }
          return this.finish(run, failure.status, failure.message);
        }
        return this.finish(run, 'completed');
      }

      if (result.code !== 0) {
        const failure = classifyFailure(result.stderr || result.stdout, result.code);
        send(baseEvent(eventId, 1, 'error', Date.now() - started, failure.message));
        return this.finish(run, failure.status, failure.message);
      }

      // Java / C++: execution works; real stepping lands in a later phase.
      if (result.stdout) send(baseEvent(eventId++, 1, 'stdout', Date.now() - started, undefined, result.stdout));
      return this.finish(run, 'completed');
    } catch (error) {
      const timedOut = run.controller.signal.aborted && !run.cancelled;
      const raw = error instanceof Error ? error.message : 'Execution failed.';
      const failure = timedOut
        ? { status: 'timed-out' as RunStatus, message: 'Execution stopped after 20 seconds.' }
        : classifyFailure(raw, null);
      send(baseEvent(eventId, 1, 'error', Date.now() - started, failure.message));
      return this.finish(run, failure.status, failure.message);
    } finally { clearTimeout(timeout); }
  }
}
