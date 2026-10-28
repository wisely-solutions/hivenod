import { describe, expect, it } from 'vitest';
import type { ActionContext } from './actions';
import {
  proposeRelation,
  rejectRelation,
  relateSubjects,
  relationId,
  searchSubjects,
  unrelateSubjects,
  type SubjectSearchInput,
} from './inbox';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Agent' },
  newId: () => 'e1',
};
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => 'e2',
};
const J = { memberUid: 'joao' };

describe('related subjects (item 4PEHr)', () => {
  it('has one id per pair, either way round', () => {
    expect(relationId('s2', 's1')).toBe('rel-s1-s2');
    expect(relationId('s1', 's2')).toBe('rel-s1-s2');
  });

  it('an agent proposes; the pair is sorted and tracked', () => {
    const p = proposeRelation(agent, {
      a: 's2',
      b: 's1',
      subjectA: J,
      subjectB: J,
      existing: null,
      note: '  same   client ',
    });
    expect(p).toMatchObject({ relationId: 'rel-s1-s2', a: 's1', b: 's2' });
    expect(p.ops[0]).toMatchObject({
      kind: 'set',
      path: 'workspaces/w1/inboxRelations/rel-s1-s2',
      data: { state: 'proposed', note: 'same client', proposedBy: { type: 'agent', id: 'agentA' } },
    });
    expect(p.ops[1]).toMatchObject({ data: { type: 'relation.proposed', subjectId: 's1' } });
  });

  it('refuses the same subject, another person, and a pair already decided', () => {
    const base = { subjectA: J, subjectB: J, existing: null };
    expect(() => proposeRelation(agent, { ...base, a: 's1', b: 's1' })).toThrow(/two different/);
    expect(() =>
      proposeRelation(agent, { ...base, a: 's1', b: 's2', subjectB: { memberUid: 'maria' } }),
    ).toThrow(/same person/);
    const ex = (state: 'proposed' | 'related' | 'rejected') => ({
      memberUid: 'joao',
      a: 's1',
      b: 's2',
      note: '',
      state,
    });
    expect(() =>
      proposeRelation(agent, { ...base, a: 's1', b: 's2', existing: ex('related') }),
    ).toThrow(/related already/);
    expect(() =>
      proposeRelation(agent, { ...base, a: 's1', b: 's2', existing: ex('proposed') }),
    ).toThrow(/proposed already/);
    expect(() =>
      proposeRelation(agent, { ...base, a: 's1', b: 's2', existing: ex('rejected') }),
    ).toThrow(/turned this link down/);
    expect(() => proposeRelation(joao, { ...base, a: 's1', b: 's2' })).toThrow(/Only agents/);
  });

  it('the member accepts, relates directly, turns down and removes', () => {
    const ex = (state: 'proposed' | 'related' | 'rejected') => ({
      memberUid: 'joao',
      a: 's1',
      b: 's2',
      note: 'n',
      state,
    });
    const base = { a: 's1', b: 's2', subjectA: J, subjectB: J };
    const acc = relateSubjects(joao, { ...base, existing: ex('proposed') });
    expect(acc.ops[0]).toMatchObject({ kind: 'update', data: { state: 'related', note: 'n' } });
    expect(acc.ops[1]).toMatchObject({ data: { type: 'relation.accepted' } });
    const made = relateSubjects(joao, { ...base, existing: null, note: 'x' });
    expect(made.ops[0]).toMatchObject({
      kind: 'set',
      data: { state: 'related', proposedBy: { type: 'human', id: 'joao' } },
    });
    expect(made.ops[1]).toMatchObject({ data: { type: 'relation.created' } });
    expect(() => relateSubjects(joao, { ...base, existing: ex('related') })).toThrow(/already/);
    expect(() => relateSubjects(agent, { ...base, existing: null })).toThrow();
    const rej = rejectRelation(joao, { relationId: 'rel-s1-s2', relation: ex('proposed') });
    expect(rej.ops[0]).toMatchObject({ data: { state: 'rejected' } });
    expect(() =>
      rejectRelation(joao, { relationId: 'rel-s1-s2', relation: ex('related') }),
    ).toThrow();
    const rm = unrelateSubjects(joao, { relationId: 'rel-s1-s2', relation: ex('related') });
    expect(rm.ops[1]).toMatchObject({ data: { type: 'relation.removed' } });
    expect(() =>
      unrelateSubjects(
        { ...joao, actor: { ...joao.actor, id: 'maria' } },
        {
          relationId: 'rel-s1-s2',
          relation: ex('related'),
        },
      ),
    ).toThrow(/Only the person/);
  });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28);
const DATA: SubjectSearchInput = {
  query: '',
  filters: {},
  nowMs: NOW,
  subjects: [
    { id: 's1', name: 'Klarna refunds (Payments)' },
    { id: 's2', name: 'Grafana access' },
    { id: 's3', name: 'Quiet one' },
  ],
  threads: [
    {
      id: 't1',
      subjectId: 's1',
      state: 'yourCall',
      title: 'Refund for order 12',
      lastMessageAtMs: NOW - DAY,
    },
    {
      id: 't2',
      subjectId: 's2',
      state: 'waiting',
      title: 'Need a Grafana login',
      lastMessageAtMs: NOW - 2 * DAY,
    },
    { id: 't3', subjectId: 's3', state: 'done', title: 'Old', lastMessageAtMs: NOW - 90 * DAY },
    { id: 't4', subjectId: null, state: 'investigating', title: 'Unfiled', lastMessageAtMs: NOW },
  ],
  messages: [
    {
      threadId: 't1',
      direction: 'in',
      source: 'teams',
      senderName: 'Sam Example',
      senderHandle: 'sam@example.com',
      text: 'Klarna refund stuck',
    },
    {
      threadId: 't1',
      direction: 'out',
      source: 'teams',
      senderName: 'João',
      senderHandle: null,
      text: 'Looking',
    },
    {
      threadId: 't2',
      direction: 'in',
      source: 'jira',
      senderName: 'Ana',
      senderHandle: null,
      text: 'Please give me Grafana',
    },
    {
      threadId: 't4',
      direction: 'in',
      source: 'mail',
      senderName: 'Zed',
      senderHandle: null,
      text: 'klarna',
    },
  ],
  relations: [
    { a: 's1', b: 's2', state: 'related', note: 'same team' },
    { a: 's1', b: 'gone', state: 'related', note: '' },
    { a: 's2', b: 's3', state: 'proposed', note: '' },
  ],
};

describe('searchSubjects (item 4PEHr)', () => {
  it('lists all subjects, waiting ones first, with people, channels and links', () => {
    const r = searchSubjects(DATA);
    expect(r.total).toBe(3);
    expect(r.subjects.map((s) => s.subjectId)).toEqual(['s1', 's2', 's3']);
    expect(r.subjects[0]).toMatchObject({
      forYou: 1,
      open: 1,
      threads: 1,
      people: ['Sam Example'],
      channels: ['teams'],
      related: [{ subjectId: 's2', name: 'Grafana access', note: 'same team' }],
      proposed: [],
      lastActivityAt: new Date(NOW - DAY).toISOString(),
    });
    expect(r.subjects[1]!.proposed).toEqual([{ subjectId: 's3', name: 'Quiet one', note: '' }]);
  });

  it('matches every word in names, people, channels, titles and texts', () => {
    const q = (query: string) => searchSubjects({ ...DATA, query });
    expect(q('klarna').subjects.map((s) => s.subjectId)).toEqual(['s1']);
    expect(q('klarna').subjects[0]!.matched).toEqual(['name', 'text']);
    expect(q('SAM@').subjects[0]!.matched).toEqual(['people']);
    expect(q('jira').subjects.map((s) => s.subjectId)).toEqual(['s2']);
    expect(q('login').subjects[0]!.matched).toEqual(['thread']);
    expect(q('grafana ana').subjects.map((s) => s.subjectId)).toEqual(['s2']);
    expect(q('grafana klarna').total).toBe(0);
  });

  it('filters: waiting for me, active in N days, has open threads, limit', () => {
    const f = (filters: SubjectSearchInput['filters']) =>
      searchSubjects({ ...DATA, filters }).subjects.map((s) => s.subjectId);
    expect(f({ waitingForMe: true })).toEqual(['s1']);
    expect(f({ hasOpen: true })).toEqual(['s1', 's2']);
    expect(f({ activeDays: 30 })).toEqual(['s1', 's2']);
    expect(f({ activeDays: 1 })).toEqual(['s1']);
    expect(f({ limit: 1 })).toEqual(['s1']);
    expect(searchSubjects({ ...DATA, filters: { limit: 1 } }).total).toBe(3);
  });
});
