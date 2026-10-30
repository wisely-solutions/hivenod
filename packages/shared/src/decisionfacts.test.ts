/** Decision facts (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7). */
import { describe, expect, it } from 'vitest';
import {
  approveOutcome,
  decisionFacts,
  notNowThread,
  rejectOutcome,
  requestRevision,
  stepLabelOf,
  type OutcomeStateOf,
  type ThreadStateOf,
} from './inbox';
import type { ActionContext } from './actions';

const at = (ms: number) => ({ toMillis: () => ms });
const ctx: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'alice', name: 'Alice' },
  newId: () => 'e1',
};
const thread: ThreadStateOf = {
  memberUid: 'alice',
  subjectId: null,
  state: 'yourCall',
  fetchedBy: 'agentA',
  refs: [],
  summary: { version: 4, recAction: 'Send the reply' },
} as unknown as ThreadStateOf;
const reply: OutcomeStateOf = {
  memberUid: 'alice',
  threadId: 't1',
  type: 'reply',
  fields: { text: 'Hi' },
  state: 'proposed',
  executor: 'agentA',
  updatedAt: at(1_000),
};
const FACTS = ['stepLabel', 'templateId', 'waitedMs', 'recommended', 'summaryVersion'];
const eventData = (p: { ops: { path: string; data: Record<string, unknown> }[] }) =>
  p.ops.find((o) => o.path.includes('/inboxEvents/'))!.data.data as Record<string, unknown>;

describe('decisionFacts', () => {
  it('a step waits from cursorAt (older plans: createdAt); a proposal from its latest version', () => {
    const plan = {
      memberUid: 'alice',
      threadId: 't1',
      steps: ['a', 'b'],
      cursor: 1,
      state: 'active' as const,
      templateId: 'dev',
      cursorAt: at(5_000),
      createdAt: at(1_000),
    };
    const gate = { ...reply, type: 'approval', fields: { what: 'Ship it?' }, executor: null };
    expect(decisionFacts({ thread, plan, outcome: gate, nowMs: 65_000 })).toEqual({
      stepLabel: 'Ship it?',
      templateId: 'dev',
      waitedMs: 60_000,
      recommended: 'Send the reply',
      summaryVersion: 4,
    });
    expect(
      decisionFacts({ thread, plan: { ...plan, cursorAt: null }, outcome: gate, nowMs: 2_000 })
        .waitedMs,
    ).toBe(1_000);
    expect(decisionFacts({ thread, outcome: reply, nowMs: 3_000 })).toMatchObject({
      stepLabel: 'Reply',
      templateId: null,
      waitedMs: 2_000,
    });
    // No summary, nothing known: nulls, never absent.
    const bare = decisionFacts({ thread: { ...thread, summary: null }, stepLabel: null });
    expect(bare).toEqual({
      stepLabel: null,
      templateId: null,
      waitedMs: null,
      recommended: null,
      summaryVersion: null,
    });
  });
  it('an approval step is named by its own words', () => {
    expect(stepLabelOf({ type: 'approval', fields: { what: 'Accept on live' } })).toBe(
      'Accept on live',
    );
    expect(stepLabelOf({ type: 'build', fields: {} })).toBe('Build');
  });
  it('every decision action writes the facts on its event', () => {
    const plans = [
      approveOutcome(ctx, { outcomeId: 'o1', outcome: reply, thread }),
      rejectOutcome(ctx, { outcomeId: 'o1', outcome: reply, thread, othersPending: false }),
      requestRevision(ctx, { outcomeId: 'o1', outcome: reply, thread, instruction: 'Shorter' }),
      notNowThread(ctx, {
        threadId: 't1',
        thread,
        key: 'k',
        until: new Date(Date.now() + 3_600_000),
      }),
    ];
    for (const p of plans) {
      const d = eventData(p as never);
      for (const k of FACTS) expect(d).toHaveProperty(k);
      expect(d.recommended).toBe('Send the reply');
      expect(d.summaryVersion).toBe(4);
    }
    // A gate's approval keeps the version on screen over the mirror's.
    const gate = approveOutcome(ctx, {
      outcomeId: 'o1',
      outcome: reply,
      thread,
      summaryVersion: 2,
    });
    expect(eventData(gate as never).summaryVersion).toBe(2);
  });
});
