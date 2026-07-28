/** Generates a Python runner that traces /workspace/program.py via sys.settrace. */
export function generatePythonTracer(breakpoints: number[], maxEvents = 8_000): string {
  const bp = JSON.stringify([...new Set(breakpoints.filter(line => line > 0))]);
  return `# Auto-generated VisualMyAlgo tracer — do not edit
import json
import sys
import time

PROGRAM = "/workspace/program.py"
BREAKPOINTS = set(${bp})
MAX_EVENTS = ${maxEvents}
_started = time.time() * 1000
_count = 0


def _serialize(value, depth=0):
    if depth > 3:
        return type(value).__name__
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 240 else value[:240] + "…"
    if isinstance(value, (list, tuple)):
        return [_serialize(item, depth + 1) for item in list(value)[:60]]
    if isinstance(value, dict):
        out = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 40:
                break
            out[str(key)] = _serialize(item, depth + 1)
        return out
    if isinstance(value, set):
        return [_serialize(item, depth + 1) for item in list(value)[:60]]
    text = repr(value)
    return text if len(text) <= 240 else text[:240] + "…"


def _emit(payload):
    global _count
    _count += 1
    print("__VMA__" + json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
    if _count >= MAX_EVENTS:
        sys.settrace(None)


def _tracer(frame, event, arg):
    if event != "line":
        return _tracer
    if frame.f_code.co_filename != PROGRAM:
        return _tracer
    line = frame.f_lineno
    locals_map = {
        key: _serialize(value)
        for key, value in frame.f_locals.items()
        if not str(key).startswith("__")
    }
    _emit({
        "line": line,
        "type": "breakpoint" if line in BREAKPOINTS else "step",
        "stack": [{
            "name": frame.f_code.co_name or "<module>",
            "line": line,
            "locals": locals_map,
        }],
        "elapsedMs": int(time.time() * 1000 - _started),
    })
    return _tracer


def main():
    sys.settrace(_tracer)
    try:
        with open(PROGRAM, "r", encoding="utf-8") as handle:
            source = handle.read()
        compiled = compile(source, PROGRAM, "exec")
        namespace = {"__name__": "__main__", "__file__": PROGRAM}
        exec(compiled, namespace, namespace)
    except SystemExit:
        raise
    except Exception as error:
        line = getattr(error, "lineno", None) or 1
        _emit({
            "line": int(line) if isinstance(line, int) else 1,
            "type": "error",
            "message": f"{type(error).__name__}: {error}",
            "stack": [{"name": "<module>", "line": int(line) if isinstance(line, int) else 1, "locals": {}}],
            "elapsedMs": int(time.time() * 1000 - _started),
        })
        raise
    finally:
        sys.settrace(None)


if __name__ == "__main__":
    main()
`;
}

export type RawTracePayload = {
  line: number;
  type?: 'step' | 'breakpoint' | 'error' | 'stdout' | 'stderr';
  message?: string;
  output?: string;
  stack?: Array<{ name: string; line: number; locals: Record<string, unknown> }>;
  elapsedMs?: number;
};

export function parseVmaTraceLines(stderr: string): { traces: RawTracePayload[]; remainder: string } {
  const traces: RawTracePayload[] = [];
  const other: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (line.startsWith('__VMA__')) {
      try {
        traces.push(JSON.parse(line.slice('__VMA__'.length)) as RawTracePayload);
      } catch {
        other.push(line);
      }
    } else if (line.length) {
      other.push(line);
    }
  }
  return { traces, remainder: other.join('\n') };
}
