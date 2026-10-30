import { describe, expect, it } from 'vitest';
import { Reminders, remindAt, type RemindStep } from './remind';
import { threadKeyboard } from './telegram';

const MON = Date.parse('2026-11-02T10:00:00Z');
const DAY = 86_400_000;

function rig(now = MON) {
  const t = { now, timers: [] as { fn: () => void; at: number; live: boolean }[] };
  const fired: string[] = [];
  let ok = true;
  const r = new Reminders({
    now: () => t.now,
    setTimer: (fn, ms) => {
      const h = { fn, at: t.now + ms, live: true };
      t.timers.push(h);
      return h;
    },
    clearTimer: (h) => void ((h as { live: boolean }).live = false),
    fire: async (s) => {
      fired.push(`${s.oid}:${s.n}`);
      return ok;
    },
    log: () => undefined,
  });
  const run = async (to: number) => {
    t.now = to;
    for (const h of t.timers.filter((x) => x.live && x.at <= to)) {
      h.live = false;
      h.fn();
    }
    await new Promise((res) => setTimeout(res, 0));
  };
  return { t, r, fired, run, fail: () => (ok = false) };
}
const step = (over: Partial<RemindStep> = {}): RemindStep => ({
  key: 'w1/o1',
  wid: 'w1',
  oid: 'o1',
  n: 1,
  outMs: MON,
  fields: {},
  remindDue: 0,
  ...over,
});

describe('their reply reminders', () => {
  it('due after the working days (default 3), none once it fired for that message', () => {
    expect(remindAt(step())).toBe(MON + 3 * DAY);
    expect(remindAt(step({ fields: { remindAfterDays: '5' } }))).toBe(MON + 7 * DAY);
    expect(remindAt(step({ remindDue: 1 }))).toBeNull();
    expect(remindAt(step({ n: 2, remindDue: 1 }))).toBe(MON + 3 * DAY);
  });
  it('one timer per step; it fires once; a new message re-arms; a step gone clears it', async () => {
    const { r, fired, run, t } = rig();
    r.sync('w1', [step()]);
    r.sync('w1', [step()]);
    expect(t.timers.filter((x) => x.live)).toHaveLength(1);
    await run(MON + 3 * DAY - 1);
    expect(fired).toEqual([]);
    await run(MON + 3 * DAY);
    expect(fired).toEqual(['o1:1']);
    // The write comes back through the listener: nothing more for message 1.
    r.sync('w1', [step({ remindDue: 1 })]);
    await run(MON + 30 * DAY);
    expect(fired).toEqual(['o1:1']);
    // A nudge went out (message 2): a new timer from its send.
    r.sync('w1', [step({ n: 2, remindDue: 1, outMs: MON + 30 * DAY })]);
    expect(r.size).toBe(1);
    // Another organization's snapshot leaves it alone; its own empty snapshot clears it.
    r.sync('w2', []);
    expect(r.size).toBe(1);
    r.sync('w1', []);
    expect(r.size).toBe(0);
  });
});

describe('their reply buttons', () => {
  it('a draft: Approve follow-up · Mark done / Open', () => {
    const k = threadKeyboard(
      'c1',
      {
        kind: 'thread',
        wid: 'w',
        tid: 't',
        uid: 'u',
        arrival: 's:p:o:2',
        ask: 'step',
        options: [],
        ext: 'follow_up',
      },
      'https://hivenod.com/x',
    );
    expect(k).toEqual([
      [
        { text: 'Approve follow-up', callback_data: 'ta:c1' },
        { text: 'Mark done', callback_data: 'td:c1' },
      ],
      [{ text: 'Open', url: 'https://hivenod.com/x' }],
    ]);
  });
});
