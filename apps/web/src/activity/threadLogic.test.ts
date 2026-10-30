/** Activity on threads (slice 9, acceptance 16). */
import { describe, expect, it } from 'vitest';
import {
  FEED_TYPES,
  foldProgress,
  groupOf,
  linkLabel,
  matches,
  recommendationKind,
  threadFeedConstraints,
  threadSentence,
} from './threadLogic';

const human = { type: 'human' as const, id: 'alice', name: 'Alice' };
const agent = { type: 'agent' as const, id: 'hive', name: 'Hive' };
const e = (type: string, data: Record<string, unknown> = {}, actor = agent) =>
  ({ type, data, actor }) as never;

describe('the thread feed', () => {
  it('always reads the member’s own events, by group', () => {
    expect(threadFeedConstraints('u1', '')).toEqual([
      ['memberUid', '==', 'u1'],
      ['type', 'in', [...FEED_TYPES]],
    ]);
    expect(threadFeedConstraints('u1', 'summaries')[1]).toEqual([
      'type',
      'in',
      ['summary.written'],
    ]);
  });
  it('filters actors on the rows; a person’s send back is a decision, an agent’s a step', () => {
    expect(matches(e('outcome.done'), { group: '', actor: 'people' })).toBe(false);
    expect(matches(e('outcome.done'), { group: '', actor: 'hive' })).toBe(true);
    expect(matches(e('plan.sent_back'), { group: 'decisions', actor: 'all' })).toBe(false);
    expect(matches(e('plan.sent_back', {}, human), { group: 'decisions', actor: 'all' })).toBe(
      true,
    );
    expect(groupOf(e('plan.sent_back', {}, human))).toBe('decisions');
    expect(groupOf(e('summary.written'))).toBe('summaries');
  });
  it('folds consecutive progress of one step', () => {
    const row = (id: string, type: string, outcomeId: string) => ({
      id,
      data: { type, data: { outcomeId }, actor: agent },
    });
    const out = foldProgress([
      row('1', 'step.progress', 'b'),
      row('2', 'step.progress', 'b'),
      row('3', 'step.progress', 'b'),
      row('4', 'outcome.started', 'b'),
    ] as never);
    expect(out.map((r) => [r.id, r.folded])).toEqual([
      ['1', 2],
      ['4', 0],
    ]);
  });
  it('says each row in one sentence', () => {
    expect(
      threadSentence(
        e('outcome.done', { type: 'build', permalink: 'https://github.com/o/r/pull/86' }),
      ),
    ).toMatchObject({ before: 'finished Build on ', link: { label: 'PR #86' } });
    expect(threadSentence(e('summary.written', { version: 7 })).after).toBe(' · v7');
    expect(
      threadSentence(
        e('plan.sent_back', { stepLabel: 'Ship it?', toLabel: 'Build', reason: 'Bigger' }, human),
      ),
    ).toEqual({
      before: 'asked for changes at Ship it? on ',
      after: ' → back to Build: “Bigger”',
    });
    expect(
      threadSentence(
        e('outcome.approved', { stepLabel: 'Ship it?', recommended: 'Approve' }, human),
      ).after,
    ).toBe(' · followed the recommendation');
    expect(threadSentence(e('inbox.added', { newThread: true })).before).toBe(
      'brought in a new thread: ',
    );
    expect(linkLabel('https://example.com/x')).toBe('link');
  });
  it('reads what a recommendation asks for', () => {
    expect(recommendationKind('Approve')).toBe('approve');
    expect(recommendationKind('Ship it')).toBe('approve');
    expect(recommendationKind('Send back to Build')).toBe('changes');
    expect(recommendationKind('Ask for changes')).toBe('changes');
    expect(recommendationKind('Reject')).toBe('reject');
    expect(recommendationKind('Do not ship')).toBe('reject');
    expect(recommendationKind('Hmm')).toBeNull();
  });
});
