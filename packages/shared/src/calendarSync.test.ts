import { describe, expect, it } from 'vitest';
import { planCalendarSync, type GoogleEvent, type SyncedEvent } from './calendarSync';

const D = (s: string) => new Date(s);
const from = D('2030-01-06T00:00:00Z');
const to = D('2030-02-06T00:00:00Z');
const g = (id: string, over: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id,
  status: 'confirmed',
  summary: `Meeting ${id}`,
  start: { dateTime: '2030-01-07T09:00:00+01:00' },
  end: { dateTime: '2030-01-07T10:00:00+01:00' },
  ...over,
});
const have = (id: string, over: Partial<SyncedEvent> = {}): SyncedEvent => ({
  sourceEventId: id,
  title: `Meeting ${id}`,
  start: D('2030-01-07T08:00:00Z'),
  end: D('2030-01-07T09:00:00Z'),
  allDay: false,
  attendees: [],
  busyOnly: false,
  deleted: false,
  ...over,
});
const plan = (items: GoogleEvent[], existing: SyncedEvent[] = [], over = {}) =>
  planCalendarSync({ source: 'google', mode: 'full', from, to, existing, items, ...over });

describe('planCalendarSync', () => {
  it('adds new events, keeps unchanged ones, updates changed ones, removes what is gone', () => {
    const p = plan(
      [
        g('new'),
        g('same'),
        g('moved', {
          start: { dateTime: '2030-01-08T09:00:00Z' },
          end: { dateTime: '2030-01-08T10:00:00Z' },
        }),
      ],
      [
        have('same'),
        have('moved'),
        have('gone'),
        have('old', { start: D('2029-12-01T00:00:00Z'), end: D('2029-12-01T01:00:00Z') }),
      ],
    );
    expect(p.upserts.map((u) => u.sourceEventId)).toEqual(['new', 'moved']);
    expect(p.upserts[0]).toMatchObject({ start: D('2030-01-07T08:00:00Z'), title: 'Meeting new' });
    expect(p.unchanged).toBe(1);
    // 'old' is outside the window: left alone
    expect(p.deletes).toEqual(['gone']);
  });

  it('incremental: removes cancelled events only, never for being absent', () => {
    const p = plan(
      [g('x', { status: 'cancelled' }), g('y', { status: 'cancelled' })],
      [have('x'), have('z')],
      {
        mode: 'incremental',
      },
    );
    expect(p.deletes).toEqual(['x']);
    expect(p.upserts).toEqual([]);
  });

  it('free, declined and working-location entries are not busy', () => {
    const p = plan(
      [
        g('free', { transparency: 'transparent' }),
        g('declined', {
          attendees: [{ email: 'me@x.io', self: true, responseStatus: 'declined' }],
        }),
        g('wl', { eventType: 'workingLocation' }),
      ],
      [have('free')],
    );
    expect(p.upserts).toEqual([]);
    expect(p.deletes).toEqual(['free']);
  });

  it('all-day events are UTC days; attendees drop rooms; busyOnly drops details', () => {
    const p = plan([
      g('day', { start: { date: '2030-01-09' }, end: { date: '2030-01-10' } }),
      g('meet', {
        attendees: [{ email: ' a@x.io ' }, { email: 'room@x.io', resource: true }, {}],
      }),
    ]);
    expect(p.upserts[0]).toMatchObject({
      allDay: true,
      start: D('2030-01-09T00:00:00Z'),
      end: D('2030-01-10T00:00:00Z'),
    });
    expect(p.upserts[1]!.attendees).toEqual(['a@x.io']);
    const b = plan([g('meet', { attendees: [{ email: 'a@x.io' }] })], [], { busyOnly: true });
    expect(b.upserts[0]).toMatchObject({ title: '', attendees: [], busyOnly: true });
  });

  it('skips bad entries with a reason, and clips very long events to the window', () => {
    const p = plan([
      { summary: 'no id' },
      g('bad', { start: { dateTime: 'tomorrow' } }),
      g('backwards', { end: { dateTime: '2030-01-07T07:00:00Z' } }),
      g('feb31', { start: { date: '2030-02-31' }, end: { date: '2030-03-01' } }),
      g('long', { start: { date: '2029-12-01' }, end: { date: '2030-03-01' } }),
    ]);
    expect(p.skipped).toEqual([
      { sourceEventId: '', reason: 'no id' },
      { sourceEventId: 'bad', reason: 'no valid start and end' },
      { sourceEventId: 'backwards', reason: 'ends before it starts' },
      { sourceEventId: 'feb31', reason: 'no valid start and end' },
    ]);
    expect(p.upserts[0]).toMatchObject({ sourceEventId: 'long', start: from, end: to });
  });

  it('the last entry of an event wins', () => {
    const p = plan([g('a'), g('b'), g('a', { summary: 'Renamed' })]);
    expect(p.upserts.map((u) => [u.sourceEventId, u.title])).toEqual([
      ['a', 'Renamed'],
      ['b', 'Meeting b'],
    ]);
  });

  it('refuses a bad window, mode or source', () => {
    expect(() => plan([], [], { to: from })).toThrow(/after/);
    expect(() => plan([], [], { to: D('2030-04-01T00:00:00Z') })).toThrow(/62 days/);
    expect(() => plan([], [], { mode: 'sometimes' })).toThrow(/full or incremental/);
    expect(() => plan([], [], { source: ' ' })).toThrow(/source/);
  });
});
