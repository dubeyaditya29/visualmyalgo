import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@visualmyalgo/protocol';
import { nextByDepth } from './trace';

const event = (id: number, depth: number): TraceEvent => ({ id, line: id + 1, type: 'step', elapsedMs: id, stack: Array.from({ length: depth }, (_, index) => ({ name: `f${index}`, line: id + 1, locals: {} })) });

describe('trace navigation', () => {
  const events = [event(0, 1), event(1, 2), event(2, 3), event(3, 2), event(4, 1)];
  it('steps over nested frames', () => expect(nextByDepth(events, 1, 'over')).toBe(3));
  it('steps out to the caller', () => expect(nextByDepth(events, 1, 'out')).toBe(4));
});
