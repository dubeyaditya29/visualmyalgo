import { describe, expect, it } from 'vitest';
import { executableLines } from './runs.js';

describe('runner source parsing', () => {
  it('skips blank and comment-only lines', () => {
    expect(executableLines('// explain\n\nconst value = 1;\n# python note\nconsole.log(value);')).toEqual([3, 5]);
  });
});
