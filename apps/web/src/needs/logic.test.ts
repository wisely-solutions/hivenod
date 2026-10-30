import type { InboxOutcome, InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { Row } from '../lib/live';
import {
  askOf,
  buildNeeds,
  countKinds,
  filterByLabel,
  filterKind,
  filterOrg,
  labelsOfNeeds,
  orderNeeds,
  orderToday,
  theirDraftWaits,
  type NeedsEntry,
  type OrgInput,
} from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });

function thread(over: Partial<InboxThread> = {}): InboxThread {
  return {
    memberUid: 'me',
    subjectId: null,
    state: 'yourCall',
    waiting: null,
    question: null,
    title: 'Invoice from Acme',
    refs: [],
    lastMessageAt: ts(100),
    fetchedBy: 'agent',
    createdAt: ts(100),
    updatedAt: ts(300),
    lastEventId: 'e',
    ...over,
  } as unknown as InboxThread;
}

function org(wid: string, over: Partial<OrgInput> = {}): OrgInput {
  return {
    wid,
    name: wid.toUpperCase(),
    threads: [],
    openOutcomes: [],
    names: { ana: 'Ana', me: 'Me' },
    ...over,
  };
}

const row = <T>(id: string, data: T): Row<T> => ({ id, data }) as Row<T>;
function outcome(threadId: string, type: string, over: Partial<InboxOutcome> = {}): InboxOutcome {
  return {
    memberUid: 'me',
    threadId,
    type,
    fields: {},
    state: 'proposed',
    note: '',
    proposedBy: 'agent',
    executor: null,
    decision: null,
    result: null,
    createdAt: ts(100),
    updatedAt: ts(100),
    lastEventId: 'e',
    ...over,
  } as unknown as InboxOutcome;
}

describe('buildNeeds: Inbox threads of every organization (Projects removed, OE8Fm slice 10)', () => {
  const a = org('wa', {
    threads: [row('t1', thread()), row('t2', thread({ state: 'done' }))],
    openOutcomes: [row('o1', outcome('t1', 'reply'))],
  });
  const b = org('wb', {
    threads: [
      row('t3', thread({ state: 'needsYou' })),
      row('other', thread({ memberUid: 'ana', state: 'needsYou' })),
    ],
  });
  it("lists the member's threads at Needs you or Your call only", () => {
    const n = buildNeeds([a, b], 'me');
    expect(n.todo.map((x) => x.key).sort()).toEqual(['t:wa:t1', 't:wb:t3']);
    expect(n.todo.every((x) => x.kind === 'thread')).toBe(true);
    expect(Object.keys(n)).toEqual(['todo']);
  });
});

const e = (over: Partial<NeedsEntry> & { key: string }): NeedsEntry => ({
  wid: 'w1',
  org: 'W1',
  kind: 'thread',
  since: 0,
  urgent: false,
  thread: { id: over.key, data: thread() },
  ...over,
});

describe('orderNeeds', () => {
  it('groups by organization, urgent on top, then oldest first', () => {
    const list = [
      e({ key: 'w1-new', since: 50 }),
      e({ key: 'w2-old', wid: 'w2', since: 10 }),
      e({ key: 'w1-old', since: 20 }),
      e({ key: 'w1-urgent', since: 90, urgent: true }),
    ];
    expect(orderNeeds(list, ['w1', 'w2']).map((x) => x.key)).toEqual([
      'w1-urgent',
      'w1-old',
      'w1-new',
      'w2-old',
    ]);
  });
  it('narrows to one organization', () => {
    const list = [e({ key: 'a' }), e({ key: 'c', wid: 'w2' })];
    expect(filterOrg(list, 'w2').map((x) => x.key)).toEqual(['c']);
    expect(filterOrg(list, null).length).toBe(2);
  });
});

describe('kind filter', () => {
  it('Your call is a decision, Needs you a question', () => {
    const t = (state: string) =>
      e({ key: state, thread: { id: state, data: thread({ state } as never) } });
    const list = [t('yourCall'), t('needsYou')];
    expect(filterKind(list, 'approvals').map((x) => x.key)).toEqual(['yourCall']);
    expect(filterKind(list, 'questions').map((x) => x.key)).toEqual(['needsYou']);
    expect(countKinds(list)).toEqual({ all: 2, approvals: 1, questions: 1 });
  });
});

describe('Today (item kt3E7): proposals, tidy-ups and the stack order', () => {
  const NOW = 10 * 86_400_000;
  const H = 3_600_000;
  it('Your call with no open proposal is not listed; a lone sure ignore is a tidy-up', () => {
    const o = org('w', {
      threads: [
        row('carrying', thread()),
        row('tidy', thread()),
        row('two', thread()),
        row('ask', thread({ state: 'needsYou' })),
      ],
      openOutcomes: [
        row('o1', outcome('tidy', 'ignore', { confidence: 'high' })),
        row('o2', outcome('two', 'ignore', { confidence: 'high' })),
        row('o3', outcome('two', 'reply', { createdAt: ts(50) as never })),
        row('o4', outcome('carrying', 'reply', { state: 'approved' })),
      ],
    });
    const n = buildNeeds([o], 'me', NOW);
    expect(n.todo.map((e) => e.key).sort()).toEqual(['t:w:ask', 't:w:tidy', 't:w:two']);
    const by = Object.fromEntries(n.todo.map((e) => [e.key, e]));
    expect(by['t:w:tidy']!.tidy).toBe(true);
    expect(by['t:w:two']!.tidy).toBe(false);
    expect(by['t:w:two']!.proposals!.map((p) => p.id)).toEqual(['o3', 'o2']);
  });

  it('Not now (slice 3): out of Today until its time, only for the decision it was about', () => {
    const nn = (key: string, until: number) =>
      ({ notNow: { key, until: ts(until), at: ts(NOW) } }) as Partial<InboxThread>;
    const q = { text: 'Thursday?', by: 'agent', at: ts(500), answer: null, answeredAt: null };
    const o = org('w', {
      threads: [
        row('hidden', thread(nn('c100', NOW + H))),
        row('expired', thread(nn('c100', NOW - 1))),
        row('newer', thread(nn('c1', NOW + H))),
        row('asked', thread({ state: 'needsYou', question: q, ...nn('q500', NOW + H) } as never)),
      ],
      openOutcomes: ['hidden', 'expired', 'newer'].map((t) => row(`o-${t}`, outcome(t, 'reply'))),
    });
    const n = buildNeeds([o], 'me', NOW);
    expect(n.todo.map((e) => e.key).sort()).toEqual(['t:w:expired', 't:w:newer']);
  });

  it('plans (item qwFAW): a blocked plan waits; a gate not reached yet does not', () => {
    const plan = (threadId: string, state: string, steps: string[], cursor: number) =>
      ({
        memberUid: 'me',
        threadId,
        proposedBy: 'agent',
        steps,
        cursor,
        state,
        note: '',
        createdAt: ts(100),
        updatedAt: ts(100),
        lastEventId: 'e',
      }) as never;
    const o = org('w', {
      threads: [
        row('blocked', thread()),
        row('later', thread()),
        row('gate', thread()),
        row('fresh', thread()),
      ],
      openOutcomes: [
        // later: step 1 approved (running), the gate at step 2 not reached.
        row('l2', outcome('later', 'approval', { planId: 'pl' } as never)),
        row('g2', outcome('gate', 'approval', { planId: 'pg' } as never)),
        row('f1', outcome('fresh', 'reply', { planId: 'pf', confidence: 'high' } as never)),
      ],
      livePlans: [
        row('pb', plan('blocked', 'blocked', ['b1'], 0)),
        row('pl', plan('later', 'active', ['l1', 'l2'], 0)),
        row('pg', plan('gate', 'active', ['g1', 'g2'], 1)),
        row('pf', plan('fresh', 'proposed', ['f1'], 0)),
      ],
    });
    const n = buildNeeds([o], 'me', NOW);
    expect(n.todo.map((x) => x.key).sort()).toEqual(['t:w:blocked', 't:w:fresh', 't:w:gate']);
    const by = Object.fromEntries(n.todo.map((x) => [x.key, x]));
    expect(by['t:w:blocked']!.plan!.id).toBe('pb');
    expect(by['t:w:fresh']!.tidy).toBe(false);
  });

  it('band-1 threads, band-2 threads, then the rest oldest first', () => {
    const t = (key: string, over: Partial<InboxThread>, since: number) =>
      e({ key, since, thread: { id: key, data: thread(over) } });
    const list = [
      t('old', {}, 1),
      t('ask', { state: 'needsYou' }, 5),
      t('due-3d', { due: ts(NOW + 72 * H) as never }, 8),
      t('due-2h', { due: ts(NOW + 2 * H) as never }, 7),
      t('urgent', { urgent: true }, 6),
      { ...t('tidy', {}, 0), tidy: true },
    ];
    expect(orderToday(list, NOW).map((x) => x.key)).toEqual([
      'due-2h',
      'urgent',
      'due-3d',
      'old',
      'ask',
    ]);
  });
});

describe('label filter (item YaOErIjeIFG8Y3EvZuIp)', () => {
  const o = org('wb', {
    threads: [
      row('t1', thread({ subjectId: 's1', state: 'needsYou' } as never)),
      row('t2', thread({ subjectId: 's2', state: 'needsYou' } as never)),
      row('t3', thread({ subjectId: 's3', state: 'needsYou' } as never)),
    ],
    subjectLabels: {
      s1: { label: 'Sales', suggested: true },
      s2: { label: 'sales', suggested: false },
    },
  });
  const list = buildNeeds([o], 'me').todo;
  it('puts the subject label on the thread rows', () => {
    expect(list.map((e) => e.label?.label ?? null).sort()).toEqual(['Sales', null, 'sales']);
  });
  it('lists the labels with counts, and narrows to the threads that carry one', () => {
    expect(labelsOfNeeds(list)).toEqual([{ key: 'sales', label: 'Sales', count: 2 }]);
    expect(filterByLabel(list, 'sales').every((e) => e.thread)).toBe(true);
    expect(filterByLabel(list, 'sales').length).toBe(2);
    expect(filterByLabel(list, null).length).toBe(list.length);
  });
});

describe('Their reply drafts wait on Today', () => {
  const NOW = 10 * 86_400_000;
  const ext = (state: string, kind = 'ask') =>
    ({
      ask: { n: 1, kind, text: 'Hi Ana', state, by: 'agent' },
      outAt: null,
      sent: 0,
      reply: null,
    }) as never;
  const step = (state: string, askState: string) =>
    outcome('t1', 'their_reply', { state, planId: 'p1', ext: ext(askState) } as never);
  const plan = {
    memberUid: 'me',
    threadId: 't1',
    proposedBy: 'agent',
    steps: ['s1'],
    cursor: 0,
    state: 'active',
    note: '',
    createdAt: ts(100),
    updatedAt: ts(100),
    lastEventId: 'e',
  } as never;

  it('a running step with a drafted ask counts; a sent or approved one does not', () => {
    expect(theirDraftWaits(step('running', 'proposed'))).toBe(true);
    expect(theirDraftWaits(step('approved', 'proposed'))).toBe(true);
    expect(theirDraftWaits(step('running', 'approved'))).toBe(false);
    expect(theirDraftWaits(step('running', 'sent'))).toBe(false);
    expect(theirDraftWaits(outcome('t1', 'reply', { state: 'running' }))).toBe(false);
  });

  it('puts the thread on the stack, and the thread asks the step with the draft kind', () => {
    const o = org('w', {
      threads: [row('t1', thread())],
      openOutcomes: [row('s1', step('running', 'proposed'))],
      livePlans: [row('p1', plan)],
    });
    const n = buildNeeds([o], 'me', NOW);
    expect(n.todo.map((x) => x.key)).toEqual(['t:w:t1']);
    const e0 = n.todo[0]!;
    const a = askOf(e0.thread!, e0.plan, e0.proposals ?? []);
    expect(a).toMatchObject({ kind: 'step', outcomeId: 's1', ext: { n: 1, kind: 'ask' } });
  });

  it('a step waiting on them is not on the stack', () => {
    const o = org('w', {
      threads: [row('t1', thread())],
      openOutcomes: [],
      livePlans: [row('p1', plan)],
    });
    expect(buildNeeds([o], 'me', NOW).todo).toEqual([]);
  });
});
