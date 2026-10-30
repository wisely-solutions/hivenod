/** Keep green re-checking at Ship it? (item OE8FmrTaIxFVGcaeGG3N, slice 6c). */
import type { InboxOutcome } from '@hive/shared';
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import type { Row } from '../lib/live';
import { keepGreenRecheck } from './plan';

const ts = (ms: number) => Timestamp.fromMillis(ms);
const row = (id: string, data: Partial<InboxOutcome>): Row<InboxOutcome> =>
  ({
    id,
    data: { type: 'keepgreen', state: 'done', ...data } as InboxOutcome,
  }) as Row<InboxOutcome>;
const steps = ['b', 'k', 'g'];
const done = { at: ts(1000) } as unknown as InboxOutcome['result'];

describe('keepGreenRecheck', () => {
  it('shows a re-check reported after Keep green was done', () => {
    const k = row('k', {
      result: done,
      progress: { line: 'main moved to 9b1e2d3', percent: null, check: 'rechecking', at: ts(2000) },
    });
    expect(keepGreenRecheck(steps, [k], 2)).toEqual({
      check: 'rechecking',
      line: 'main moved to 9b1e2d3',
      outcomeId: 'k',
    });
    const b = row('k', {
      result: done,
      progress: { line: 'conflict', percent: null, check: 'blocked', at: ts(2000) },
    });
    expect(keepGreenRecheck(steps, [b], 2)?.check).toBe('blocked');
  });
  it('nothing while green, before it was done, or when the step before is not Keep green', () => {
    const green = row('k', {
      result: done,
      progress: { line: 'ok', percent: null, check: 'green', at: ts(2000) },
    });
    expect(keepGreenRecheck(steps, [green], 2)).toBeNull();
    const old = row('k', {
      result: done,
      progress: { line: 'x', percent: null, check: 'rechecking', at: ts(500) },
    });
    expect(keepGreenRecheck(steps, [old], 2)).toBeNull();
    const plain = row('k', { result: done, progress: { line: 'x', percent: 10, at: ts(2000) } });
    expect(keepGreenRecheck(steps, [plain], 2)).toBeNull();
    const build = row('k', {
      type: 'build',
      result: done,
      progress: { line: 'x', percent: null, check: 'rechecking', at: ts(2000) },
    });
    expect(keepGreenRecheck(steps, [build], 2)).toBeNull();
    const running = row('k', {
      state: 'running',
      progress: { line: 'x', percent: null, check: 'rechecking', at: ts(2000) },
    });
    expect(keepGreenRecheck(steps, [running], 2)).toBeNull();
    expect(keepGreenRecheck(steps, [], 0)).toBeNull();
  });
});
