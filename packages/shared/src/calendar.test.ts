import { describe, expect, it } from 'vitest';
import { ActionError, type ActionContext } from './actions';
import {
  busyBlockId,
  calendarDelete,
  calendarEventId,
  calendarUpsert,
  freeSlots,
  MAX_CALENDAR_EVENTS_PER_WRITE,
} from './calendar';

const H = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 2, h, m));
const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Hive' },
  newId: () => 'e1',
};
const joao: ActionContext = { ...agent, actor: { type: 'human', id: 'joao', name: 'João' } };

describe('calendar ids', () => {
  it('is stable per member, source and source event id', () => {
    expect(calendarEventId('joao', 'google', 'abc')).toBe(calendarEventId('joao', 'google', 'abc'));
    expect(calendarEventId('joao', 'google', 'abc')).not.toBe(
      calendarEventId('maria', 'google', 'abc'),
    );
    expect(calendarEventId('joao', 'google', 'abc')).not.toBe(
      calendarEventId('joao', 'outlook', 'abc'),
    );
    expect(calendarEventId('joao', 'google', 'a/b?c=d')).toMatch(/^joao_[A-Za-z0-9_-]+$/);
    expect(busyBlockId('w1', 'x')).toBe('w1_x');
  });
});

describe('calendarUpsert', () => {
  const ev = { source: 'google', sourceEventId: 'g1', title: 'Standup', start: H(9), end: H(10) };

  it('writes the event, its busy block (no title) and one event', () => {
    const p = calendarUpsert(agent, { memberUid: 'joao', events: [ev] });
    const id = calendarEventId('joao', 'google', 'g1');
    expect(p.ids).toEqual([id]);
    expect(p.ops.map((o) => o.path)).toEqual([
      `workspaces/w1/calendar/${id}`,
      `users/joao/busy/w1_${id}`,
      'workspaces/w1/events/e1',
    ]);
    expect(p.ops[0]!.data).toMatchObject({ memberUid: 'joao', title: 'Standup', busyOnly: false });
    expect(Object.keys(p.ops[1]!.data!).sort()).toEqual(
      ['deleted', 'end', 'lastEventId', 'start', 'updatedAt', 'workspaceId'].sort(),
    );
    expect(p.ops[2]!.data).toMatchObject({
      type: 'calendar.changed',
      data: { memberUids: ['joao'], upserted: 1, deleted: 0 },
    });
  });

  it('keeps no details on a busy-only event', () => {
    const p = calendarUpsert(agent, {
      memberUid: 'joao',
      events: [{ ...ev, busyOnly: true, attendees: ['a@b.c'] }],
    });
    expect(p.ops[0]!.data).toMatchObject({ title: '', attendees: [], busyOnly: true });
  });

  it('refuses bad input', () => {
    const bad = (events: unknown[], ctx = agent, memberUid = 'joao') =>
      expect(() => calendarUpsert(ctx, { memberUid, events: events as never })).toThrow(
        ActionError,
      );
    bad([]);
    bad([{ ...ev, end: H(9) }]);
    bad([{ ...ev, source: ' ' }]);
    bad([{ ...ev, sourceEventId: '' }]);
    bad([ev, ev]);
    bad(
      Array.from({ length: MAX_CALENDAR_EVENTS_PER_WRITE + 1 }, (_, i) => ({
        ...ev,
        sourceEventId: `g${i}`,
      })),
    );
    bad([ev], joao, 'maria');
    bad([ev], agent, '');
  });

  it('lets a person book in their own calendar', () => {
    expect(calendarUpsert(joao, { memberUid: 'joao', events: [ev] }).ids).toHaveLength(1);
  });
});

describe('calendarDelete', () => {
  it('soft-deletes the event and frees the busy block', () => {
    const p = calendarDelete(agent, { events: [{ id: 'joao_x', memberUid: 'joao' }] });
    expect(p.ops[0]).toMatchObject({
      kind: 'update',
      path: 'workspaces/w1/calendar/joao_x',
      data: { deleted: true, title: '', attendees: [] },
    });
    expect(p.ops[1]).toMatchObject({ kind: 'update', path: 'users/joao/busy/w1_joao_x' });
  });
});

describe('freeSlots', () => {
  it('merges busy blocks from several organizations', () => {
    const busy = [
      { start: H(9), end: H(10) }, // w1
      { start: H(9, 30), end: H(11) }, // w2, overlaps
      { start: H(11), end: H(11, 15) }, // w3, touches
      { start: H(13), end: H(14) }, // w2
      { start: H(7), end: H(8) }, // before the range
    ];
    expect(freeSlots({ from: H(8), to: H(17), busy })).toEqual([
      { start: H(8), end: H(9) },
      { start: H(11, 15), end: H(13) },
      { start: H(14), end: H(17) },
    ]);
  });
  it('drops gaps shorter than minMinutes', () => {
    const busy = [
      { start: H(9), end: H(10) },
      { start: H(10, 20), end: H(12) },
    ];
    expect(freeSlots({ from: H(9), to: H(12), busy, minMinutes: 30 })).toEqual([]);
    expect(freeSlots({ from: H(9), to: H(12), busy, minMinutes: 15 })).toEqual([
      { start: H(10), end: H(10, 20) },
    ]);
  });
  it('refuses a bad range', () => {
    expect(() => freeSlots({ from: H(9), to: H(9), busy: [] })).toThrow(ActionError);
    expect(() => freeSlots({ from: H(9), to: H(10), busy: [], minMinutes: 0 })).toThrow(
      ActionError,
    );
  });
});
