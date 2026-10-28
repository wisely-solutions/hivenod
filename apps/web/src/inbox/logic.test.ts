import type { Item, Message, Project } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { ActionContext } from '@hive/shared';
import { decisionProblem, prepareDecision } from './decision';
import {
  approvalLine,
  buildInbox,
  countByFilter,
  filterEntries,
  nextKey,
  swipeAction,
  waitLabel,
  type InboxEntry,
  gateRuleLine,
  isStuckHold,
  questionBlocks,
} from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });

function project(rule: 'any' | 'all' = 'all'): Project {
  return {
    name: 'Blog',
    emoji: 'B',
    steps: [
      { id: 'draft', name: 'Draft', kind: 'agent', description: '', outputs: [] },
      {
        id: 'review',
        name: 'Review',
        kind: 'human',
        description: '',
        outputs: [],
        gate: {
          deciderUids: ['me', 'ana'],
          groupIds: [],
          rule,
          n: 1,
          mustInclude: [],
          rejectPolicy: 'one',
          remindAfterHours: 24,
        },
      },
      { id: 'publish', name: 'Publish', kind: 'agent', description: '', outputs: [] },
    ],
    archivedAt: null,
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

const q = (over: Partial<Message> = {}) =>
  ({
    itemId: 'i1',
    kind: 'question',
    text: 'Which audience?',
    answered: false,
    at: ts(500),
    ...over,
  }) as unknown as Message;

describe('buildInbox', () => {
  const projects = [{ id: 'p1', data: project() }];

  it('lists approvals, questions and findings, oldest first', () => {
    const inbox = buildInbox({
      projects,
      items: { p1: [{ id: 'i1', data: item({ updatedAt: ts(3000) }) }] },
      suggestions: {
        p1: [
          {
            id: 'f1',
            data: item({
              type: 'finding',
              stepId: 'draft',
              status: 'suggested',
              gate: null,
              updatedAt: ts(2000),
            }),
          },
        ],
      },
      questions: { p1: [{ id: 'm1', data: q() }] },
      uid: 'me',
      isAdmin: true,
    });
    expect(inbox.todo.map((e) => e.key)).toEqual(['q:p1:i1:m1', 'f:p1:f1', 'a:p1:i1']);
    expect(countByFilter(inbox.todo)).toEqual({ all: 3, approvals: 1, questions: 1, findings: 1 });
  });

  it('lists suggestions only for the people who may triage them', () => {
    const suggestions = {
      p1: [
        {
          id: 'f1',
          data: item({ type: 'finding', stepId: 'draft', status: 'suggested', gate: null }),
        },
      ],
    };
    const p = [{ id: 'p1', data: { ...project(), createdBy: 'cy' } as Project }];
    const keys = (uid: string, isAdmin = false) =>
      buildInbox({ projects: p, items: {}, suggestions, questions: {}, uid, isAdmin }).todo.map(
        (e) => e.key,
      );
    expect(keys('me')).toEqual([]);
    expect(keys('me', true)).toEqual(['f:p1:f1']);
    expect(keys('cy')).toEqual(['f:p1:f1']);
  });

  it('moves an item I already approved to "waiting on others"', () => {
    const inbox = buildInbox({
      projects,
      items: {
        p1: [
          {
            id: 'i1',
            data: item({
              gate: {
                stepId: 'review',
                approvals: { me: { at: ts(1), rationale: '' } },
                rejections: {},
              } as Item['gate'],
            }),
          },
        ],
      },
      questions: {},
      uid: 'me',
    });
    expect(inbox.todo).toEqual([]);
    expect(inbox.waiting.map((e) => e.key)).toEqual(['a:p1:i1']);
  });

  it('skips answered questions, triaged findings, archived projects and non-deciders', () => {
    const inbox = buildInbox({
      projects: [...projects, { id: 'p2', data: { ...project(), archivedAt: ts(1) } as Project }],
      items: {
        p1: [
          { id: 'i1', data: item() },
          {
            id: 'f1',
            data: item({
              type: 'finding',
              stepId: 'draft',
              status: 'queued',
              gate: null,
              triage: { outcome: 'intake' } as Item['triage'],
            }),
          },
        ],
        p2: [{ id: 'i2', data: item() }],
      },
      questions: {
        p1: [
          { id: 'm1', data: q({ answered: true }) },
          { id: 'm2', data: q({ itemId: 'gone' }) },
        ],
      },
      uid: 'someone',
    });
    expect(inbox.todo).toEqual([]);
    expect(inbox.waiting).toEqual([]);
  });
});

describe('helpers', () => {
  it('filters by chip', () => {
    const e = (kind: InboxEntry['kind']) => ({ kind, key: kind }) as InboxEntry;
    const all = [e('approval'), e('question'), e('finding')];
    expect(filterEntries(all, 'all')).toHaveLength(3);
    expect(filterEntries(all, 'questions').map((x) => x.key)).toEqual(['question']);
  });

  it('writes the approvals line', () => {
    const withAna = item({
      gate: {
        stepId: 'review',
        approvals: { ana: { at: ts(1), rationale: '' } },
        rejections: {},
      } as Item['gate'],
    });
    expect(approvalLine(project(), withAna, 'me', { ana: 'Ana' })).toBe(
      '1 of 2 approved · Ana ✓ · you',
    );
    expect(approvalLine(project('any'), item(), 'me', {})).toBe('0 of 1 approved · you');
  });

  it('labels waiting time', () => {
    expect(waitLabel(0, 30_000)).toBe('just now');
    expect(waitLabel(0, 5 * 60_000)).toBe('5 min');
    expect(waitLabel(0, 3 * 3_600_000)).toBe('3 h');
    expect(waitLabel(0, 50 * 3_600_000)).toBe('2 d');
  });

  it('picks the next key after one leaves', () => {
    const l = ['a', 'b', 'c'].map((key) => ({ key }) as InboxEntry);
    expect(nextKey(l, 'a')).toBe('b');
    expect(nextKey(l, 'c')).toBe('b');
    expect(nextKey([l[0]!], 'a')).toBeNull();
  });

  it('reads swipes', () => {
    expect(swipeAction(120)).toBe('approve');
    expect(swipeAction(-120)).toBe('iterate');
    expect(swipeAction(40)).toBeNull();
  });
});

describe('prepareDecision', () => {
  const ctx: ActionContext = {
    workspaceId: 'w',
    actor: { type: 'human', id: 'me', name: 'Me' },
    newId: () => 'evt1',
  };
  const entry = (rule: 'any' | 'all' = 'any'): InboxEntry => ({
    key: 'a:p1:i1',
    kind: 'approval',
    pid: 'p1',
    itemId: 'i1',
    project: project(rule),
    item: item(),
    since: 0,
  });

  it('approves and says where it moved', () => {
    const p = prepareDecision(ctx, entry(), { kind: 'approve', rationale: '' });
    expect(p.message).toBe('Approved. Moved to Publish.');
    expect(p.plan.ops.some((o) => o.path.includes('/decisions/'))).toBe(true);
  });

  it('final approval says Releasing during the Undo window and Released when written', () => {
    const e = entry();
    e.project = {
      ...e.project,
      steps: e.project.steps.slice(0, e.project.steps.findIndex((x) => x.id === e.item.stepId) + 1),
    };
    const p = prepareDecision(ctx, e, { kind: 'approve', rationale: '' });
    expect(p.pending).toMatch(/^Releasing /);
    expect(p.message).toMatch(/^Released\./);
  });

  it('says when it waits for others', () => {
    expect(prepareDecision(ctx, entry('all'), { kind: 'approve', rationale: '' }).message).toBe(
      'Approved by you. Waiting for 1 more.',
    );
  });

  it('requires a reason for reject', () => {
    expect(decisionProblem({ kind: 'reject', rationale: '' })).toMatch(/at least 10/);
    expect(() => prepareDecision(ctx, entry(), { kind: 'reject', rationale: 'no' })).toThrow();
  });

  it('reject stops the item', () => {
    const rej = prepareDecision(ctx, entry(), { kind: 'reject', rationale: 'Not worth doing now' });
    expect(rej.message).toBe('Rejected. The item is dropped.');
  });
});

describe('gateRuleLine (card 9bmMIGlC)', () => {
  const g = (rule: 'any' | 'all' | 'atLeast', n: number, ids: string[]) => ({
    rule,
    n,
    deciderUids: ids,
  });
  it('says the rule in plain words, the same everywhere', () => {
    expect(gateRuleLine(g('any', 1, ['a', 'b']))).toBe('Any one of 2 deciders');
    expect(gateRuleLine(g('all', 1, ['a', 'b', 'c']))).toBe('All 3 deciders');
    expect(gateRuleLine(g('atLeast', 2, ['a', 'b', 'c']))).toBe('2 of 3 deciders');
    expect(gateRuleLine(g('any', 1, ['a']))).toBe('One decider');
    expect(gateRuleLine(undefined)).toBe('');
  });
});

describe('isStuckHold (card KLCTVnX8)', () => {
  const question = { id: 'q9', data: q() };
  const held = (n: number, qid = 'q9') =>
    item({
      agentSendBacks: n,
      awaitingAnswer: { questionId: qid, agentUid: 'a1', at: ts(1) as never },
    });
  it('is the hold of the question asked after 3 agent send-backs', () => {
    const e = (it: Item) => ({ kind: 'question' as const, item: it, question: question as never });
    expect(isStuckHold(e(held(3)))).toBe(true);
    expect(isStuckHold(e(held(2)))).toBe(false);
    expect(isStuckHold(e(held(3, 'other')))).toBe(false);
    expect(isStuckHold({ kind: 'approval', item: held(3), question: question as never })).toBe(
      false,
    );
  });
});

describe('questionBlocks (card pqqOWE3s)', () => {
  it('turns numbered lines into a list between paragraphs', () => {
    expect(
      questionBlocks(
        'Stuck.\n\nReasons so far:\n1. Login fails\n2. Still fails\n\nThis time: Safari',
      ),
    ).toEqual([
      { kind: 'text', text: 'Stuck.\n\nReasons so far:' },
      { kind: 'list', items: ['Login fails', 'Still fails'] },
      { kind: 'text', text: 'This time: Safari' },
    ]);
  });
  it('leaves plain text alone', () => {
    expect(questionBlocks('Which currency?')).toEqual([{ kind: 'text', text: 'Which currency?' }]);
  });
});
