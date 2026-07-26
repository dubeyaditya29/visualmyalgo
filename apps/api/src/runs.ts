import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Language, RunRequest, RunStatus, TraceEvent } from '@visualmyalgo/protocol';

const LIMITS = { sourceBytes: 100_000, outputBytes: 64_000, timeoutMs: 20_000, queueSize: 20 };

type Run = { id: string; request: RunRequest; status: RunStatus | 'queued'; events: EventEmitter; history: TraceEvent[]; result?: { status: RunStatus; message?: string }; cancelled: boolean; controller?: AbortController };
type Command = { image: string; filename: string; args: string[] };

const commands: Record<Language, Command> = {
  javascript: { image: 'node:20-alpine', filename: 'main.js', args: ['node', '/workspace/main.js'] },
  python: { image: 'python:3.12-alpine', filename: 'main.py', args: ['python', '/workspace/main.py'] },
  cpp: { image: 'gcc:14', filename: 'main.cpp', args: ['sh', '-lc', 'g++ -g /workspace/main.cpp -o /tmp/main && /tmp/main'] },
  java: { image: 'eclipse-temurin:21-jdk', filename: 'Main.java', args: ['sh', '-lc', 'javac -g /workspace/Main.java -d /tmp && java -cp /tmp Main'] },
};

export function executableLines(code: string) {
  return code.split('\n').flatMap((line, index) => line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('#') ? [index + 1] : []);
}

function baseEvent(id: number, line: number, type: TraceEvent['type'], elapsedMs: number, message?: string, output?: string): TraceEvent {
  return { id, line, type, elapsedMs, stack: [{ name: 'main', line, locals: {} }], message, output };
}

async function executeInContainer(request: RunRequest, signal: AbortSignal) {
  const command = commands[request.language];
  const directory = await mkdtemp(join(tmpdir(), 'visualmyalgo-'));
  const source = join(directory, command.filename);
  await writeFile(source, request.code, { mode: 0o600 });
  try {
    return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, command.image, ...command.args,
      ], { stdio: ['pipe', 'pipe', 'pipe'], signal });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout = (stdout + data).slice(0, LIMITS.outputBytes); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(0, LIMITS.outputBytes); });
      child.on('error', reject);
      child.on('close', code => resolve({ stdout, stderr, code }));
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
    for (const line of executableLines(run.request.code)) {
      if (run.cancelled) return this.finish(run, 'cancelled');
      send(baseEvent(eventId++, line, run.request.breakpoints.includes(line) ? 'breakpoint' : 'step', Date.now() - started));
    }
    run.controller = new AbortController();
    const timeout = setTimeout(() => run.controller?.abort(), LIMITS.timeoutMs);
    try {
      const result = await executeInContainer(run.request, run.controller.signal);
      if (run.cancelled) return this.finish(run, 'cancelled');
      if (result.stdout) send(baseEvent(eventId++, executableLines(run.request.code).at(-1) || 1, 'stdout', Date.now() - started, undefined, result.stdout));
      if (result.code === 0) return this.finish(run, 'completed');
      const message = result.stderr || 'Program exited with a non-zero status.';
      const status: RunStatus = /error:|syntaxerror|compilation/i.test(message) ? 'compile-error' : 'runtime-error';
      send(baseEvent(eventId, 1, 'error', Date.now() - started, message));
      return this.finish(run, status, message);
    } catch (error) {
      const timedOut = run.controller.signal.aborted && !run.cancelled;
      const message = timedOut ? 'Execution stopped after 20 seconds.' : error instanceof Error ? error.message : 'Execution failed.';
      send(baseEvent(eventId, 1, 'error', Date.now() - started, message));
      return this.finish(run, timedOut ? 'timed-out' : 'runtime-error', message);
    } finally { clearTimeout(timeout); }
  }
}
