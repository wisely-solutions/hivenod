import type { InboxOutcome, InboxPlan } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import {
  firstFree,
  itemLinkParts,
  planInputOf,
  planMain,
  planSummary,
  planWaits,
  openQuestionLines,
  planDiff,
  planVersions,
  producesOf,
  stepTitle,
  whoOf,
} from './plan';

const ts = (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 });
const oc = (id: string, type: string, state: InboxOutcome['state'], fields = {}) => ({
  id,
  data: {
    memberUid: 'u',
    threadId: 't',
    type,
    fields,
    state,
    note: '',
    proposedBy: 'a',
    executor: type === 'approval' ? null : 'a',
    decision: null,
    result: null,
    planId: 'p',
    createdAt: ts(0),
    updatedAt: ts(0),
    lastEventId: 'e',
  } as unknown as InboxOutcome,
});
const plan = (steps: string[], cursor: number, state: InboxPlan['state']) => ({
  id: 'p',
  data: {
    memberUid: 'u',
    threadId: 't',
    proposedBy: 'a',
    steps,
    cursor,
    state,
    note: '',
    createdAt: ts(0),
    updatedAt: ts(0),
    lastEventId: 'e',
  } as unknown as InboxPlan,
});

describe('plans on the thread page (item qwFAW, slice 4)', () => {
  it('builds the action input from the plan and only its own steps', () => {
    const pl = planInputOf(plan(['o1', 'o2'], 0, 'proposed'), [
      oc('o1', 'reply', 'proposed', { text: 'x' }),
      oc('o2', 'approval', 'proposed', { what: 'y' }),
      oc('other', 'reply', 'proposed'),
    ]);
    expect(Object.keys(pl.outcomes)).toEqual(['o1', 'o2']);
    expect(pl.plan).toMatchObject({ steps: ['o1', 'o2'], cursor: 0, state: 'proposed' });
  });

  it('the main action: Approve plan, then the step at its turn, then Retry', () => {
    const rows = [
      oc('o1', 'reply', 'proposed', { text: 'x' }),
      oc('o2', 'approval', 'proposed', { what: 'y' }),
      oc('o3', 'nudge', 'proposed', { text: 'z' }),
    ];
    const p0 = planInputOf(plan(['o1', 'o2', 'o3'], 0, 'proposed'), rows);
    expect(planMain(p0)).toEqual({ kind: 'approvePlan' });
    expect(planSummary(p0)).toBe('1 needs you on the way');
    // Step 1 done, the gate at its turn.
    const p1 = planInputOf(plan(['o1', 'o2', 'o3'], 1, 'active'), [
      oc('o1', 'reply', 'done'),
      rows[1]!,
      oc('o3', 'nudge', 'approved', { text: 'z' }),
    ]);
    expect(planMain(p1)).toEqual({ kind: 'step', index: 1, outcomeId: 'o2', gate: true });
    expect(planSummary(p1)).toBe('1 done · 1 approved · 1 needs you on the way');
    // An agent step not approved at its turn.
    const p2 = planInputOf(plan(['o1', 'o3'], 1, 'active'), [oc('o1', 'reply', 'done'), rows[2]!]);
    expect(planMain(p2)).toEqual({ kind: 'step', index: 1, outcomeId: 'o3', gate: false });
    // Blocked.
    const p3 = planInputOf(plan(['o1'], 0, 'blocked'), [oc('o1', 'reply', 'failed')]);
    expect(planMain(p3)).toEqual({ kind: 'retry', index: 0 });
    // Running, nothing to decide.
    const p4 = planInputOf(plan(['o1', 'o3'], 0, 'active'), [
      oc('o1', 'reply', 'approved'),
      oc('o3', 'nudge', 'approved'),
    ]);
    expect(planMain(p4)).toBeNull();
    expect(planWaits(p4)).toBe(false);
    // Approved ahead, but a later agent step still proposed: Approve plan.
    const p5 = planInputOf(plan(['o1', 'o3'], 0, 'active'), [
      oc('o1', 'reply', 'approved'),
      oc('o3', 'nudge', 'proposed'),
    ]);
    expect(planMain(p5)).toEqual({ kind: 'approvePlan' });
    // Done or stopped: nothing.
    expect(planMain(planInputOf(plan(['o1'], 1, 'done'), [oc('o1', 'reply', 'done')]))).toBeNull();
  });

  it('only steps that have not started move', () => {
    const rows = [oc('o1', 'reply', 'approved'), oc('o2', 'nudge', 'proposed')];
    expect(firstFree(planInputOf(plan(['o1', 'o2'], 0, 'active'), rows))).toBe(1);
    expect(
      firstFree(
        planInputOf(plan(['o1', 'o2'], 0, 'proposed'), [oc('o1', 'reply', 'proposed'), rows[1]!]),
      ),
    ).toBe(0);
  });

  it('titles say what each step does', () => {
    expect(stepTitle('reply', { text: 'Thursday works, see you then.' })).toBe(
      'Reply: “Thursday works, see you then.”',
    );
    expect(stepTitle('approval', { what: 'New price list' })).toBe('You approve: New price list');
    expect(stepTitle('make_it_work', { title: 'Update the prices' })).toBe(
      'Build it: Update the prices',
    );
    expect(stepTitle('handover', { to: 'Maria' })).toBe('Hand over to Maria');
    expect(stepTitle('book', { start: '2026-10-30T10:00:00Z' })).toMatch(
      /^Booking \(retired\) Fri 30 Oct, \d\d:00$/,
    );
    expect(stepTitle(null, {})).toBe('…');
    // Never truncated: the title wraps instead.
    expect(stepTitle('reply', { text: 'x'.repeat(80) })).toBe(`Reply: “${'x'.repeat(80)}”`);
  });

  it('reads the project and item of a Build it link', () => {
    expect(itemLinkParts('https://hivenod.com/p/web%20site?item=i%2F9')).toEqual({
      pid: 'web site',
      iid: 'i/9',
    });
    expect(itemLinkParts('https://teams.example.com/m/1')).toBeNull();
    expect(itemLinkParts(null)).toBeNull();
  });
});

describe('the plan view (spec view and plan page)', () => {
  it('gives the development steps their real titles', () => {
    expect(stepTitle('shape', { idea: 'Dark mode for the board' })).toBe(
      'Shape: Dark mode for the board',
    );
    expect(stepTitle('build', { brief: 'A theme token set\nand a toggle' })).toBe(
      'Build: A theme token set and a toggle',
    );
    expect(stepTitle('keepgreen', {})).toBe('Keep green: PR rebased and green');
    expect(stepTitle('release', { notes: 'x' })).toBe('Release + live check');
    expect(stepTitle('shape', {})).toBe('Shape');
  });

  it('says who does a step and what it produces', () => {
    expect(whoOf('approval')).toBe('You decide');
    expect(whoOf('their_reply')).toBe('Their reply');
    expect(whoOf('build')).toBe('Agent · Build');
    expect(whoOf('release')).toBe('Agent · Release + live check');
    expect(producesOf('shape')).toBe('a proposal with a size for your OK');
    expect(producesOf('build')).toBe('an open pull request, checks green, not merged');
    expect(producesOf('keepgreen')).toBe('the PR kept current with main');
    expect(producesOf('release')).toBe('the change live and checked');
    expect(producesOf('reply')).toBe('the message sent');
    expect(producesOf('approval')).toBe('your decision');
    expect(producesOf('their_reply')).toBe('their answer');
    expect(producesOf('nudge')).toBe('a reminder sent');
    expect(producesOf('snooze')).toBe('a wait until the date');
    expect(producesOf('handover')).toBe('it is handed over');
    expect(producesOf('book')).toBeNull();
  });

  it('finds open questions: lines starting with Open: or ending with ?', () => {
    expect(openQuestionLines('Plain line\nOpen: which theme?\nShould it sync?\nopen: x')).toEqual([
      { text: 'Plain line', open: false },
      { text: 'Open: which theme?', open: true },
      { text: 'Should it sync?', open: true },
      { text: 'open: x', open: true },
    ]);
  });

  it('numbers plan versions by creation time', () => {
    expect(
      planVersions([
        { id: 'b', createdAtMs: 20 },
        { id: 'a', createdAtMs: 10 },
        { id: 'c', createdAtMs: 20 },
      ]),
    ).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'c', n: 3 },
    ]);
  });

  it('diffs two plans per step position', () => {
    const prev = [
      { type: 'reply', fields: { text: 'On it' } },
      { type: 'approval', fields: { what: 'Prices' } },
      { type: 'nudge', fields: { text: 'Anything else?' } },
    ];
    const cur = [
      { type: 'reply', fields: { text: 'On it, Sam' } },
      { type: 'approval', fields: { what: 'Prices' } },
      { type: 'handover', fields: { to: 'Maria' } },
      { type: 'release', fields: {} },
    ];
    const d = planDiff(prev, cur);
    expect(d.map((x) => x.kind)).toEqual(['changed', 'same', 'changed', 'added']);
    expect(d[0]!.label).toBe('Reply');
    expect(d[0]!.fields).toEqual([
      { name: 'text', label: 'Reply', before: 'On it', after: 'On it, Sam' },
    ]);
    expect(d[2]!.type).toEqual({ before: 'Nudge', after: 'Hand over' });
    expect(planDiff(cur, prev).map((x) => x.kind)).toEqual([
      'changed',
      'same',
      'changed',
      'removed',
    ]);
    expect(planDiff([], cur)).toHaveLength(4);
  });
});
