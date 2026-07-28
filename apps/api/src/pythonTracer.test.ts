import { describe, expect, it } from 'vitest';
import { generatePythonTracer, parseVmaTraceLines } from './pythonTracer.js';
import { executableLines } from './runs.js';

describe('runner source parsing', () => {
  it('skips blank and comment-only lines', () => {
    expect(executableLines('// explain\n\nconst value = 1;\n# python note\nconsole.log(value);')).toEqual([3, 5]);
  });
});

describe('python tracer helpers', () => {
  it('embeds breakpoints in generated runner', () => {
    const source = generatePythonTracer([2, 5, 5]);
    expect(source).toContain('BREAKPOINTS = set([2,5])');
    expect(source).toContain('sys.settrace');
    expect(source).toContain('/workspace/program.py');
  });

  it('parses __VMA__ stderr payloads and keeps remainder', () => {
    const stderr = [
      '__VMA__{"line":3,"type":"step","stack":[{"name":"binary_search","line":3,"locals":{"low":0}}],"elapsedMs":1}',
      'Traceback (most recent call last):',
      'ValueError: boom',
    ].join('\n');
    const parsed = parseVmaTraceLines(stderr);
    expect(parsed.traces).toHaveLength(1);
    expect(parsed.traces[0].line).toBe(3);
    expect(parsed.remainder).toContain('ValueError: boom');
  });
});
