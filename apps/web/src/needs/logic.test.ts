import type { Group, InboxThread, Item, Message, Project } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { Row } from '../lib/live';
import {
  buildNeeds,
  countKinds,
  countNeeds,
  filterKind,
  filterNeeds,
  groupsOf,
  orderNeeds,
  parseScope,
  whoLabel,
  type NeedsEntry,
  type OrgInput,
} from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });

function project(
  name: string,
  gate: {
    deciderUids: string[];
    rule?: 'any' | 'all' | 'atLeast';
    n?: number;
    groupIds?: string[];
  },
  over: Partial<Project> = {},
): Project {
  return {
    name,
    emoji: 'P',
    steps: [
      { id: 'draft', name: 'Draft', kind: 'agent', description: '', outputs: [] },
      {
        id: 'review',
        name: 'Review',
        kind: 'human',
        description: '',
        outputs: [],
        gate: {
          groupIds: [],
          rule: 'any',
          n: 1,
          mustInclude: [],
          rejectPolicy: 'one',
          remindAfterHours: 24,
          ...gate,
        },
      },
    ],
    memberUids: ['me'],
    createdBy: 'me',
    archivedAt: null,
    ...over,
  } as unknown as Project;
}

function item(over: Partial<Item> = {}): Item {
  return {
    title: 'Post',
    type: 'idea',
    stepId: 'review',
    status: 'waiting',
    summary: 's',
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    updatedAt: ts(1000),
    ...over,
  } as unknown as Item;
}

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
    adminUids: [],
    groups: [],
    threads: [],
    names: { ana: 'Ana', ben: 'Ben', cy: 'Cy', me: 'Me' },
    projects: [],
    items: {},
    questions: {},
    ...over,
  };
}

const row = <T>(id: string, data: T): Row<T> => ({ id, data }) as Row<T>;

describe('buildNeeds: rows of every organization', () => {
  const a = org('wa', {
    projects: [row('pa', project('Blog', { deciderUids: ['me'] }))],
    items: { pa: [row('i1', item({ title: 'Solo', updatedAt: ts(2000) } as Partial<Item>))] },
  });
  const b = org('wb', {
    projects: [row('pb', project('Site', { deciderUids: ['me', 'ana'] }))],
    items: { pb: [row('i2', item({ title: 'Shared', updatedAt: ts(500) } as Partial<Item>))] },
    threads: [row('t1', thread()), row('t2', thread({ state: 'done' }))],
  });
  const c = org('wc', {
    projects: [row('pc', project('Ops', { deciderUids: ['me', 'ana', 'ben'], groupIds: ['g1'] }))],
    groups: [row('g1', { name: 'Product team', memberUids: ['ana', 'ben'] } as Group)],
    items: { pc: [row('i3', item({ title: 'Group' } as Partial<Item>))] },
  });

  it('lists rows from all three, Inbox threads at Needs you or Your call only', () => {
    const n = buildNeeds([a, b, c], 'me');
    expect(n.todo.map((e) => e.key).sort()).toEqual(
      ['a:pa:i1', 'a:pb:i2', 'a:pc:i3', 't:wb:t1'].sort(),
    );
    expect(n.todo.every((e) => e.wid && (e.entry ? e.entry.wid === e.wid : true))).toBe(true);
  });

  it('tags Only you and You or others, with a group by its name', () => {
    const n = buildNeeds([a, b, c], 'me');
    const by = Object.fromEntries(n.todo.map((e) => [e.key, whoLabel(e.who)]));
    expect(by['a:pa:i1']).toBe('Only you');
    expect(by['a:pb:i2']).toBe('You or others · Ana');
    expect(by['a:pc:i3']).toBe('You or others · Product team');
    expect(by['t:wb:t1']).toBe('Only you');
  });

  it('a gate that needs everyone, or names me as a must, is Only you', () => {
    const all = org('w', {
      projects: [row('p', project('X', { deciderUids: ['me', 'ana'], rule: 'all' }))],
      items: { p: [row('i', item())] },
    });
    expect(buildNeeds([all], 'me').todo[0]!.who).toEqual({ only: true });
  });

  it('votes count: others who already decided cannot act again', () => {
    const voted = org('w', {
      projects: [
        row('p', project('X', { deciderUids: ['me', 'ana', 'ben'], rule: 'atLeast', n: 2 })),
      ],
      items: {
        p: [
          row(
            'i',
            item({
              gate: { stepId: 'review', approvals: { ana: ts(1) }, rejections: {} },
            } as unknown as Partial<Item>),
          ),
        ],
      },
    });
    // One more approval is needed and Ben can still give it.
    expect(whoLabel(buildNeeds([voted], 'me').todo[0]!.who)).toBe('You or others · Ben');
    const none = org('w', {
      ...voted,
      items: {
        p: [
          row(
            'i',
            item({
              gate: { stepId: 'review', approvals: {}, rejections: { ben: { reason: 'x' } } },
            } as unknown as Partial<Item>),
          ),
        ],
      },
    });
    // Two approvals needed, only Ana left besides me: I am needed.
    expect(buildNeeds([none], 'me').todo[0]!.who).toEqual({ only: true });
  });

  it('a question can be answered by the project people and the admins', () => {
    const qs = org('w', {
      adminUids: ['cy'],
      projects: [
        row(
          'p',
          project('X', { deciderUids: ['me'] }, { memberUids: ['me', 'ana'] } as Partial<Project>),
        ),
      ],
      items: { p: [row('i', item({ status: 'working' } as Partial<Item>))] },
      questions: {
        p: [
          row('m', {
            itemId: 'i',
            kind: 'question',
            text: '?',
            answered: false,
            at: ts(5),
          } as unknown as Message),
        ],
      },
    });
    const e = buildNeeds([qs], 'me').todo[0]!;
    expect(e.kind).toBe('question');
    expect(whoLabel(e.who)).toBe('You or others · Ana, Cy');
  });

  it('suggestions have their own section', () => {
    const f = org('w', {
      projects: [row('p', project('X', { deciderUids: ['me'] }))],
      items: { p: [] },
      suggestions: {
        p: [row('f', item({ status: 'suggested', type: 'finding' } as unknown as Partial<Item>))],
      },
    });
    const n = buildNeeds([f], 'me');
    expect(n.todo).toEqual([]);
    expect(n.suggestions.map((e) => e.key)).toEqual(['f:p:f']);
  });
});

const e = (over: Partial<NeedsEntry>): NeedsEntry => ({
  key: over.key ?? 'k',
  wid: 'w1',
  org: 'W1',
  kind: 'approval',
  since: 0,
  urgent: false,
  who: { only: true },
  group: 'p1',
  ...over,
});

describe('orderNeeds', () => {
  it('groups by organization then project, urgent on top, then oldest first', () => {
    const list = [
      e({ key: 'w1p1-new', since: 50 }),
      e({ key: 'w2p3-old', wid: 'w2', group: 'p3', since: 10 }),
      e({ key: 'w1p2', group: 'p2', since: 30 }),
      e({ key: 'w1p1-old', since: 20 }),
      e({ key: 'w1p1-urgent', since: 90, urgent: true }),
    ];
    expect(orderNeeds(list, ['w1', 'w2']).map((x) => x.key)).toEqual([
      'w1p1-urgent',
      'w1p1-old',
      'w1p1-new',
      'w1p2',
      'w2p3-old',
    ]);
    expect(groupsOf(orderNeeds(list)).map((g) => `${g.wid}/${g.group}`)).toEqual([
      'w1/p1',
      'w1/p2',
      'w2/p3',
    ]);
  });
});

describe('filters and counts', () => {
  const list = [
    e({ key: 'a', who: { only: true } }),
    e({ key: 'b', who: { only: false, others: ['Ana'] } }),
    e({ key: 'c', wid: 'w2', who: { only: true } }),
  ];
  it('Only me, Shared, All and one organization', () => {
    expect(filterNeeds(list, 'mine').map((x) => x.key)).toEqual(['a', 'c']);
    expect(filterNeeds(list, 'shared').map((x) => x.key)).toEqual(['b']);
    expect(filterNeeds(list, 'all', 'w2').map((x) => x.key)).toEqual(['c']);
    expect(parseScope('mine')).toBe('mine');
    expect(parseScope('x')).toBe('all');
  });
  it('counts everything, with Only you apart', () => {
    expect(countNeeds(list)).toEqual({ total: 3, onlyYou: 2, shared: 1 });
  });
  it('names at most three others', () => {
    expect(whoLabel({ only: false, others: ['A', 'B', 'C', 'D', 'E'] })).toBe(
      'You or others · A, B, C +2',
    );
  });
});

describe('kind filter', () => {
  it('threads: Your call is a decision, Needs you a question; findings apart', () => {
    const t = (state: string) =>
      e({ key: state, kind: 'thread', thread: { id: state, data: thread({ state } as never) } });
    const list = [e({ key: 'a' }), e({ key: 'q', kind: 'question' }), t('yourCall'), t('needsYou')];
    expect(filterKind(list, 'approvals').map((x) => x.key)).toEqual(['a', 'yourCall']);
    expect(filterKind(list, 'questions').map((x) => x.key)).toEqual(['q', 'needsYou']);
    expect(countKinds([...list, e({ key: 'f', kind: 'finding' })])).toEqual({
      all: 5,
      approvals: 2,
      questions: 2,
      findings: 1,
    });
  });
});
