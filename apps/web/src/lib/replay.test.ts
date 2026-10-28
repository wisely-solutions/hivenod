import { SERVER_TIME } from '@hive/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAll, stash, takeReplayable } from './pendingDecisions';
import { replayStashed } from './replay';

const plan = (n: string) => [
  {
    kind: 'update' as const,
    path: `workspaces/w/projects/p/items/${n}`,
    data: { at: SERVER_TIME },
  },
  { kind: 'set' as const, path: `workspaces/w/events/${n}`, data: { at: SERVER_TIME } },
];
const entry = () => {
  sessionStorage.setItem('hive.tab', 'x');
  stash('u', 'w', [plan('a'), plan('b')], 'Saved');
  // another page's view: not live there
  return readAll('u', 'w')[0]!;
};
const err = (code: string) => Object.assign(new Error(code), { code });

describe('replay of a stashed decision', () => {
  beforeEach(() => localStorage.clear());

  it('a failing first write keeps the entry; the next load lands it', async () => {
    const s = entry();
    let fail = true;
    const written: string[] = [];
    const io = {
      exists: async (p: string) => written.includes(p),
      apply: async (ops: { path: string }[]) => {
        if (fail) throw err('unavailable');
        written.push(ops[1]!.path);
      },
    };
    const first = await replayStashed('u', 'w', s, io);
    expect(first).toEqual({ saved: 0, refused: 0, kept: 2 });
    expect(readAll('u', 'w')).toHaveLength(1);
    fail = false;
    const second = await replayStashed('u', 'w', readAll('u', 'w')[0]!, io);
    expect(second).toEqual({ saved: 2, refused: 0, kept: 0 });
    expect(readAll('u', 'w')).toEqual([]);
    expect(written).toHaveLength(2);
  });

  it('the entry stays while the write is in flight (a killed page loses nothing)', async () => {
    const s = entry();
    let during = -1;
    await replayStashed('u', 'w', s, {
      exists: async () => false,
      apply: async () => {
        during = readAll('u', 'w').length;
      },
    });
    expect(during).toBe(1);
  });

  it('only the plans that failed are kept', async () => {
    const s = entry();
    await replayStashed('u', 'w', s, {
      exists: async () => false,
      apply: async (ops) => {
        if (ops[0]!.path.endsWith('/b')) throw err('unavailable');
      },
    });
    const left = readAll('u', 'w')[0]!;
    expect(left.plans).toHaveLength(1);
    expect(left.plans[0]![0]!.path).toMatch(/\/b$/);
  });

  it('a refusal for good drops the entry and reports it', async () => {
    const s = entry();
    const r = await replayStashed('u', 'w', s, {
      exists: async () => false,
      apply: async () => {
        throw err('permission-denied');
      },
    });
    expect(r).toEqual({ saved: 0, refused: 2, kept: 0 });
    expect(readAll('u', 'w')).toEqual([]);
  });

  it('a refusal on a plan that already landed counts as saved', async () => {
    const s = entry();
    let calls = 0;
    const r = await replayStashed('u', 'w', s, {
      exists: async () => ++calls > 2, // not before the write, yes after it
      apply: async () => {
        throw err('permission-denied');
      },
    });
    expect(r.refused).toBe(0);
    expect(readAll('u', 'w')).toEqual([]);
  });

  it('is not picked up again while it is being written', async () => {
    const s = entry();
    let seen = -1;
    await replayStashed('u', 'w', s, {
      exists: async () => false,
      apply: async () => {
        seen = takeReplayable('u', 'w').ready.length;
      },
    });
    expect(seen).toBe(0);
  });
});
