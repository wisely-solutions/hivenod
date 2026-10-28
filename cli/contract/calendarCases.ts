/**
 * Contract cases for the Calendar actions (Inbox item w9SAf): packages/shared/src/calendar.ts and
 * its Go port cli/internal/actions/calendar.go. Kept apart from cases.ts so parallel work on
 * other actions merges cleanly.
 */
import {
  calendarDelete,
  calendarEventId,
  calendarUpsert,
  freeSlots,
} from '../../packages/shared/src/index';
import type { ActionContext, Actor } from '../../packages/shared/src/index';

type Act = <I>(
  name: string,
  action: string,
  actor: Actor,
  input: I,
  fn: (ctx: ActionContext, input: I) => unknown,
) => void;
type Pure = <I>(name: string, action: string, input: I, fn: (input: I) => unknown) => void;

export function calendarCases(act: Act, pure: Pure, who: { agent: Actor; human: Actor }) {
  const NOW = 1_800_000_000_000;
  const at = (min: number) => new Date(NOW + min * 60_000);
  const ev = (over: Record<string, unknown> = {}) => ({
    source: 'google',
    sourceEventId: 'g1',
    title: '  Standup  ',
    start: at(60),
    end: at(90),
    ...over,
  });

  const up = (name: string, actor: Actor, input: Parameters<typeof calendarUpsert>[1]) =>
    act(`calendarUpsert/${name}`, 'calendarUpsert', actor, input, calendarUpsert);
  up('one event', who.agent, {
    memberUid: 'joao',
    events: [ev({ attendees: [' a@x.io ', '', 'b@x.io'] })],
  });
  up('two events, all fields', who.agent, {
    memberUid: 'joao',
    events: [
      ev({ allDay: true, attendees: ['x'.repeat(400)] }),
      ev({ sourceEventId: 'ünï/cødé?=1', source: ' outlook ', title: 'T'.repeat(320) }),
    ],
  });
  up('busy only drops details', who.agent, {
    memberUid: 'joao',
    events: [ev({ busyOnly: true, attendees: ['a@x.io'] })],
  });
  up('person books own', who.human, {
    memberUid: who.human.id,
    events: [ev({ source: 'hivenod' })],
  });
  up('person for someone else', who.human, { memberUid: 'maria', events: [ev()] });
  up('no member', who.agent, { memberUid: '', events: [ev()] });
  up('no events', who.agent, { memberUid: 'joao', events: [] });
  up('too many', who.agent, {
    memberUid: 'joao',
    events: Array.from({ length: 101 }, (_, i) => ev({ sourceEventId: `g${i}` })),
  });
  up('end before start', who.agent, {
    memberUid: 'joao',
    events: [ev(), ev({ sourceEventId: 'g2', end: at(60) })],
  });
  up('too long', who.agent, { memberUid: 'joao', events: [ev({ end: at(60 + 32 * 24 * 60) })] });
  up('no source', who.agent, { memberUid: 'joao', events: [ev({ source: '  ' })] });
  up('long source', who.agent, { memberUid: 'joao', events: [ev({ source: 's'.repeat(41) })] });
  up('no source id', who.agent, { memberUid: 'joao', events: [ev({ sourceEventId: ' ' })] });
  up('long source id', who.agent, {
    memberUid: 'joao',
    events: [ev({ sourceEventId: 'é'.repeat(301) })],
  });
  up('twice', who.agent, { memberUid: 'joao', events: [ev(), ev({ title: 'again' })] });

  const del = (name: string, actor: Actor, input: Parameters<typeof calendarDelete>[1]) =>
    act(`calendarDelete/${name}`, 'calendarDelete', actor, input, calendarDelete);
  del('two members', who.agent, {
    events: [
      { id: 'joao_a', memberUid: 'joao' },
      { id: 'maria_b', memberUid: 'maria' },
      { id: 'joao_c', memberUid: 'joao' },
    ],
  });
  del('none', who.agent, { events: [] });
  del('twice', who.agent, {
    events: [
      { id: 'joao_a', memberUid: 'joao' },
      { id: 'joao_a', memberUid: 'joao' },
    ],
  });
  del('person for someone else', who.human, { events: [{ id: 'maria_b', memberUid: 'maria' }] });
  del('no id', who.agent, { events: [{ id: '', memberUid: 'joao' }] });

  pure(
    'calendarEventId/ascii',
    'calendarEventId',
    { memberUid: 'joao', source: 'google', sourceEventId: 'abc_123' },
    (i) => calendarEventId(i.memberUid, i.source, i.sourceEventId),
  );
  pure(
    'calendarEventId/unicode',
    'calendarEventId',
    { memberUid: 'u1', source: 'outlook', sourceEventId: 'AAMk/ü+=?' },
    (i) => calendarEventId(i.memberUid, i.source, i.sourceEventId),
  );

  const free = (name: string, input: Parameters<typeof freeSlots>[0]) =>
    pure(`freeSlots/${name}`, 'freeSlots', input, freeSlots);
  // three organizations' blocks, overlapping, touching, outside the range
  free('three organizations', {
    from: at(0),
    to: at(9 * 60),
    busy: [
      { start: at(60), end: at(120) },
      { start: at(90), end: at(180) },
      { start: at(180), end: at(195) },
      { start: at(300), end: at(360) },
      { start: at(-120), end: at(-60) },
      { start: at(500), end: at(700) },
    ],
  });
  free('nothing busy', { from: at(0), to: at(60), busy: [] });
  free('short gaps dropped', {
    from: at(0),
    to: at(120),
    busy: [
      { start: at(10), end: at(50) },
      { start: at(60), end: at(119) },
    ],
    minMinutes: 10,
  });
  free('all busy', { from: at(0), to: at(60), busy: [{ start: at(-10), end: at(70) }] });
  free('empty range', { from: at(0), to: at(0), busy: [] });
  free('too wide', { from: at(0), to: at(63 * 24 * 60), busy: [] });
  free('bad minMinutes', { from: at(0), to: at(60), busy: [], minMinutes: 1.5 });
  free('minMinutes too big', { from: at(0), to: at(60), busy: [], minMinutes: 1441 });
}
