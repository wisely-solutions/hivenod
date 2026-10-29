import type { InboxEvent, InboxMessage, InboxSubject, InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import {
  bookedText,
  editedFields,
  eventText,
  findSubjectRows,
  formValues,
  countWaitingThreads,
  subjectRows,
  timeline,
  waitingText,
  type ThreadRow,
} from './logic';

const ts = (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 });
const subject = (id: string, name: string, at = 0) => ({
  wid: 'w',
  id,
  data: { memberUid: 'u', name, updatedAt: ts(at) } as unknown as InboxSubject,
});
const thread = (id: string, over: Partial<InboxThread> & { at?: number } = {}): ThreadRow => ({
  wid: 'w',
  id,
  data: {
    memberUid: 'u',
    subjectId: 's1',
    state: 'waiting',
    waiting: null,
    question: null,
    title: id,
    refs: [],
    lastMessageAt: ts(over.at ?? 0),
    updatedAt: ts(over.at ?? 0),
    ...over,
  } as unknown as InboxThread,
});

describe('countWaitingThreads', () => {
  it('counts needsYou and yourCall threads across subjects, the Inbox tab and page line', () => {
    const rows = subjectRows(
      [subject('s1', 'A', 1)],
      [
        thread('t1', { subjectId: 's1', state: 'needsYou' }),
        thread('t2', { subjectId: 's1', state: 'yourCall' }),
        thread('t3', { subjectId: null, state: 'yourCall' }),
        thread('t4', { subjectId: 's1', state: 'done' }),
      ],
    );
    expect(countWaitingThreads(rows)).toBe(3);
    expect(countWaitingThreads([])).toBe(0);
  });
});

describe('subjects', () => {
  it('subjects with threads waiting for me come first, then by activity', () => {
    const rows = subjectRows(
      [subject('s1', 'Old and quiet', 10), subject('s2', 'Busy', 5), subject('s3', 'New', 50)],
      [
        thread('t1', { subjectId: 's2', state: 'yourCall', at: 6 }),
        thread('t2', { subjectId: 's2', state: 'done', at: 7 }),
        thread('t3', { subjectId: 's1', state: 'waiting', at: 20 }),
        thread('t4', { subjectId: null, state: 'investigating', at: 30 }),
      ],
    );
    expect(rows.map((r) => r.name)).toEqual(['Busy', 'New', 'Not filed yet', 'Old and quiet']);
    expect(rows[0]).toMatchObject({ waiting: 1, open: 1 });
    expect(rows[0]!.threads.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('find: searchSubjects per workspace, over names, people, channels and text; filters', () => {
    const subjects = [subject('s1', 'Klarna refunds', 100), subject('s2', 'Grafana access', 1)];
    const threads = [
      thread('t1', { subjectId: 's1', state: 'needsYou', at: 100 }),
      thread('t2', { subjectId: 's2', state: 'done', at: 1 }),
    ];
    const rows = subjectRows(subjects, threads);
    const data = {
      subjects,
      threads,
      messages: [
        {
          wid: 'w',
          data: {
            threadId: 't2',
            direction: 'in' as const,
            sender: { name: 'Zoë Ops', handle: 'zoe@example.com' },
            source: 'teams',
            text: 'Need a dashboard login',
          },
        },
      ],
      relations: [],
    };
    const find = (q: string, f = { waitingForMe: false, hasOpen: false, days: 0 }) =>
      findSubjectRows(rows, ['w'], data, q, f, 2 * 86_400_000).map((r) => r.name);
    expect(find('zoe@example')).toEqual(['Grafana access']);
    expect(find('teams dashboard')).toEqual(['Grafana access']);
    expect(find('klarna')).toEqual(['Klarna refunds']);
    expect(find('', { waitingForMe: true, hasOpen: false, days: 0 })).toEqual(['Klarna refunds']);
    expect(find('', { waitingForMe: false, hasOpen: true, days: 0 })).toEqual(['Klarna refunds']);
    expect(
      findSubjectRows(
        rows,
        ['other'],
        data,
        'klarna',
        { waitingForMe: false, hasOpen: false, days: 0 },
        0,
      ),
    ).toEqual([]);
  });
});

describe('threads', () => {
  it('waiting text', () => {
    expect(waitingText({ on: 'them', until: null })).toBe('Waiting on them');
    expect(waitingText({ on: 'thirdParty', until: null })).toBe('Waiting on someone else');
    expect(waitingText({ on: 'date', until: ts(Date.UTC(2026, 10, 3, 9)) })).toMatch(/until/);
  });

  it('timeline: messages and shown events, oldest first', () => {
    const ev = (id: string, at: number, type: InboxEvent['type'], data = {}) => ({
      id,
      data: {
        actor: { type: 'agent', id: 'a', name: 'Payments agent' },
        type,
        data,
        at: ts(at),
      } as unknown as InboxEvent,
    });
    const t = timeline(
      [{ id: 'm1', data: { receivedAt: ts(1) } as InboxMessage }],
      [
        ev('e1', 3, 'thread.note', { text: 'Checked the refund log' }),
        ev('e0', 2, 'inbox.added'),
        ev('e2', 4, 'thread.titled'),
      ],
    );
    expect(t.map((x) => x.id)).toEqual(['m1', 'e1']);
    expect(eventText((t[1] as { event: InboxEvent }).event)).toBe(
      'Payments agent noted: “Checked the refund log”',
    );
  });

  it('outcome forms follow the registry', () => {
    expect(formValues('reply', { text: 'Hi' })).toEqual({ text: 'Hi', holding: false });
    expect(editedFields('reply', { text: 'Hi there', holding: false })).toEqual({
      text: 'Hi there',
    });
    expect(editedFields('snooze', { until: '2026-11-03T09:00:00.000Z', reason: '' })).toEqual({
      until: '2026-11-03T09:00:00.000Z',
    });
  });
});

describe('bookings', () => {
  it('says what was booked', () => {
    expect(
      bookedText({
        start: '2026-11-03T10:00:00.000Z',
        end: '2026-11-03T10:30:00.000Z',
        with: 'Sam',
        text: 'x',
      }),
    ).toMatch(/^Booked in your calendar: .+ to .+, with Sam$/);
  });
});
