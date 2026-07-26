import type { TraceEvent } from '@visualmyalgo/protocol';

export function eventAt(events: TraceEvent[], cursor: number) {
  return events[Math.max(0, Math.min(cursor, events.length - 1))];
}

export function nextByDepth(events: TraceEvent[], cursor: number, mode: 'over' | 'out') {
  const current = eventAt(events, cursor);
  if (!current) return cursor;
  const targetDepth = mode === 'over' ? current.stack.length : current.stack.length - 1;
  for (let index = cursor + 1; index < events.length; index += 1) {
    if (events[index].stack.length <= targetDepth) return index;
  }
  return events.length - 1;
}
