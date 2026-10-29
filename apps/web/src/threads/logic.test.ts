import type { InboxEvent, InboxMessage, InboxSubject, InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import {
  wordDiff,
  bookedText,
  confidenceText,
  dueText,
  editedFields,
  eventText,
  findSubjectRows,
  formValues,
  countWaitingThreads,
  areaCounts,
  filterByAreas,
  groupByArea,
  groupByState,
  filterByLabels,
  subjectState,
  isQuiet,
  labelCounts,
  subjectRows,
  timeline,
  waitingText,
  type SubjectRow,
  type ThreadRow,
} from './logic';

const ts = (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 });
const subject = (id: string, name: string, at = 0, area: string | null = null) => ({
  wid: 'w',
  id,
  data: {
    memberUid: 'u',
    name,
    createdAt: ts(at),
    updatedAt: ts(at),
    area,
  } as unknown as InboxSubject,
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

describe('areas and quiet subjects', () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;
  const rowsOf = () =>
    subjectRows(
      [
        subject('s1', 'Refunds', 0, 'Payments'),
        subject('s2', 'Payouts', 0, 'payments'),
        subject('s3', 'Lunch', 0, null),
        subject('s4', 'VPN', 0, 'Admin'),
        subject('s5', 'Old', 0, 'Admin'),
        subject('s6', 'Old but waiting', 0, 'Admin'),
      ],
      [
        thread('t1', { subjectId: 's1', at: NOW - DAY }),
        thread('t2', { subjectId: 's2', at: NOW - 2 * DAY }),
        thread('t3', { subjectId: 's3', at: NOW - 3 * DAY }),
        thread('t4', { subjectId: 's4', at: NOW - 10 * DAY }),
        thread('t5', { subjectId: 's5', at: NOW - 61 * DAY }),
        thread('t6', { subjectId: 's6', at: NOW - 90 * DAY, state: 'needsYou' }),
        thread('tu', { subjectId: null, at: NOW - 200 * DAY }),
      ],
    );

  it('groups by area, case-blind, areas A to Z, no area last', () => {
    const { groups } = groupByArea(rowsOf(), 60, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Admin', 'Payments', null]);
    expect(groups[1]!.label).toBe('Payments'); // the same either row order
    expect(groups[1]!.rows.map((r) => r.name).sort()).toEqual(['Payouts', 'Refunds']);
  });

  it('a subject quiet for 60 days folds away; waiting and unfiled ones never do', () => {
    const { groups, quiet } = groupByArea(rowsOf(), 60, NOW);
    expect(quiet.map((r) => r.name)).toEqual(['Old']);
    const shown = groups.flatMap((g) => g.rows.map((r) => r.name));
    expect(shown).toContain('Old but waiting');
    expect(shown).toContain('Not filed yet');
  });

  it('is configurable, and 0 turns it off', () => {
    expect(
      groupByArea(rowsOf(), 5, NOW)
        .quiet.map((r) => r.name)
        .sort(),
    ).toEqual(['Old', 'VPN']);
    expect(groupByArea(rowsOf(), 0, NOW).quiet).toEqual([]);
  });

  it('comes back with the next message', () => {
    const before = rowsOf().find((r) => r.name === 'Old')!;
    expect(isQuiet(before, 60, NOW)).toBe(true);
    const after = subjectRows(
      [subject('s5', 'Old', 0, 'Admin')],
      [
        thread('t5', { subjectId: 's5', at: NOW - 61 * DAY }),
        thread('t7', { subjectId: 's5', at: NOW }),
      ],
    )[0]!;
    expect(isQuiet(after, 60, NOW)).toBe(false);
  });

  it('decision data (item kt3E7): due dates and confidence', () => {
    const at = new Date(2026, 9, 30, 12, 0).getTime();
    expect(dueText(at)).toBe('Fri 30 Oct 12:00');
    const ev = (data: Record<string, unknown>, human = false) =>
      ({
        actor: human
          ? { type: 'human', id: 'u', name: 'U' }
          : { type: 'agent', id: 'a', name: 'Desk agent' },
        type: 'thread.due',
        data,
      }) as unknown as InboxEvent;
    expect(eventText(ev({ due: new Date(at).toISOString(), reason: 'Sam: Friday noon' }))).toBe(
      'Desk agent set it due Fri 30 Oct 12:00: “Sam: Friday noon”',
    );
    expect(eventText(ev({ due: null, reason: null }, true))).toBe('You cleared the due date');
    expect(confidenceText('high')).toBe('Sure');
    expect(confidenceText('medium')).toBe('Likely');
    expect(confidenceText('low')).toBe('Unsure');
    expect(confidenceText(undefined)).toBeNull();
  });
});

describe('labels (item YaOErIjeIFG8Y3EvZuIp)', () => {
  const labelled = (id: string, label: string | null, suggested?: boolean) => {
    const s = subject(id, id);
    Object.assign(s.data, { label, labelSuggested: suggested });
    return s;
  };
  it('rows carry the label and whether it is still a suggestion', () => {
    const rows = subjectRows(
      [labelled('a', 'Sales', true), labelled('b', 'Support', false), labelled('c', null, true)],
      [],
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.a).toMatchObject({ label: 'Sales', labelSuggested: true });
    expect(by.b).toMatchObject({ label: 'Support', labelSuggested: false });
    expect(by.c).toMatchObject({ label: null, labelSuggested: false });
  });
  it('counts labels case-blind and filters by them, combined with nothing else', () => {
    const rows = subjectRows(
      [
        labelled('a', 'Sales'),
        labelled('b', 'sales'),
        labelled('c', 'Support'),
        labelled('d', null),
      ],
      [],
    );
    expect(labelCounts(rows)).toEqual([
      { key: 'sales', label: 'Sales', count: 2 },
      { key: 'support', label: 'Support', count: 1 },
    ]);
    expect(filterByLabels(rows, new Set()).length).toBe(4);
    expect(
      filterByLabels(rows, new Set(['sales']))
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(filterByLabels(rows, new Set(['sales', 'support'])).length).toBe(3);
  });
  it('the timeline names a label change', () => {
    expect(
      eventText({
        type: 'subject.label',
        actor: { type: 'human', id: 'u', name: 'U' },
        data: { label: 'Sales' },
      } as never),
    ).toBe('You set the label to “Sales”');
  });
});

describe('Inbox list groups (item kt3E7, design 2.4)', () => {
  const NOW = 100 * 86_400_000;
  const T = (id: string, over: Partial<InboxThread> & { at?: number } = {}) => thread(id, over);
  const S = (id: string, threads: ReturnType<typeof T>[], area: string | null = null) =>
    ({
      wid: 'w',
      id,
      name: id,
      area,
      label: null,
      labelSuggested: false,
      activityAt: Math.max(...threads.map((t) => t.data.lastMessageAt.toMillis()), 0),
      waiting: threads.filter((t) => ['needsYou', 'yourCall'].includes(t.data.state)).length,
      open: threads.length,
      lastAt: Math.max(...threads.map((t) => t.data.updatedAt.toMillis()), 0),
      threads,
    }) as SubjectRow;
  it('groups by the most pressing thread and ranks Needs you', () => {
    const rows = [
      S('call', [T('a', { state: 'yourCall', at: NOW - 1000 })]),
      S('urgent', [
        T('b', { state: 'yourCall', urgent: true, at: NOW - 500 }),
        T('c', { state: 'waiting' }),
      ]),
      S('working', [T('d', { state: 'investigating', at: NOW - 100 })]),
      S('waiting', [T('e', { state: 'waiting', at: NOW - 100 })]),
      S('done', [T('f', { state: 'done', at: NOW - 200 })]),
      S('old', [T('g', { state: 'done', at: NOW - 90 * 86_400_000 })]),
      { ...S('x', [T('h', { state: 'investigating', at: NOW })]), id: null, name: 'Not filed yet' },
    ];
    const g = groupByState(rows, 60, NOW);
    expect(g.needs.map((r) => r.id)).toEqual(['urgent', 'call']);
    expect(g.working.map((r) => r.id)).toEqual(['working']);
    expect(g.waiting.map((r) => r.id)).toEqual(['waiting']);
    expect(g.recent.map((r) => r.id)).toEqual(['done']);
    expect(g.quiet.map((r) => r.id)).toEqual(['old']);
    expect(g.unfiled).toHaveLength(1);
    expect(subjectState(rows[1]!)).toBe('needs');
  });
  it('areas are a filter with counts, case-blind', () => {
    const rows = [S('a', [], 'Payments'), S('b', [], 'payments'), S('c', [], 'Admin'), S('d', [])];
    expect(areaCounts(rows)).toEqual([
      { key: 'admin', label: 'Admin', count: 1 },
      { key: 'payments', label: 'Payments', count: 2 },
    ]);
    expect(filterByAreas(rows, new Set(['payments'])).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterByAreas(rows, new Set())).toHaveLength(4);
  });
});

describe('wordDiff (Ask for changes)', () => {
  it('marks the words taken out and put in, keeping the rest', () => {
    expect(wordDiff('Hi Sam, thanks. Thursday works.', 'Hi Sam, Thursday 10:00 works.')).toEqual([
      { op: 'same', text: 'Hi Sam, ' },
      { op: 'del', text: 'thanks. ' },
      { op: 'same', text: 'Thursday ' },
      { op: 'ins', text: '10:00 ' },
      { op: 'same', text: 'works.' },
    ]);
  });
  it('the same text is one part; empty sides', () => {
    expect(wordDiff('a b', 'a b')).toEqual([{ op: 'same', text: 'a b' }]);
    expect(wordDiff('', 'new')).toEqual([{ op: 'ins', text: 'new' }]);
    expect(wordDiff('old', '')).toEqual([{ op: 'del', text: 'old' }]);
    expect(wordDiff('', '')).toEqual([]);
  });
  it('rebuilds both texts', () => {
    const a = 'One two three four five six';
    const b = 'One 2 three five six seven';
    const d = wordDiff(a, b);
    expect(
      d
        .filter((p) => p.op !== 'ins')
        .map((p) => p.text)
        .join(''),
    ).toBe(a);
    expect(
      d
        .filter((p) => p.op !== 'del')
        .map((p) => p.text)
        .join(''),
    ).toBe(b);
  });
  it('changes only a space apart read as one removed and one added run', () => {
    expect(wordDiff('so I booked 10:00 to 11:00 in', 'so 10:00 or 14:00 in')).toEqual([
      { op: 'same', text: 'so ' },
      { op: 'del', text: 'I booked ' },
      { op: 'same', text: '10:00 ' },
      { op: 'del', text: 'to 11:00' },
      { op: 'ins', text: 'or 14:00' },
      { op: 'same', text: ' in' },
    ]);
  });
  it('gives up on detail for huge texts', () => {
    const big = Array(2500).fill('w').join(' ');
    expect(wordDiff(big, big + ' x').map((p) => p.op)).toEqual(['del', 'ins']);
  });
});
