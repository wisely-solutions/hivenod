/** Activity on threads (slice 9, acceptance 16). */
import { describe, expect, it } from 'vitest';
import {
  FEED_TYPES,
  feedChunks,
  isScheduleEvent,
  typeChunks,
  WHY_TEXT,
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
const e = (
  type: string,
  data: Record<string, unknown> = {},
  actor: { type: 'human' | 'agent' | 'system'; id: string; name: string } = agent,
) => ({ type, data, actor }) as never;

describe('the thread feed', () => {
  it('always reads the member’s own events, by group', () => {
    expect(threadFeedConstraints('u1', '')).toEqual([
      ['memberUid', '==', 'u1'],
      ['type', 'in', typeChunks(FEED_TYPES)[0]],
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

  it('the all view asks in chunks of 30 types', () => {
    expect(feedChunks('')).toBe(2);
    expect(typeChunks(FEED_TYPES).flat()).toEqual([...FEED_TYPES]);
    expect(feedChunks('schedules')).toBe(1);
  });
});

/** Scheduled tasks, slice 8: schedule, run and Off events in Activity. */
describe('schedule events', () => {
  const sys = { type: 'system' as const, id: 'scheduler', name: 'Hivenod scheduler' };
  it('belongs to the Schedules group, and only the schedule outcome among the outcomes', () => {
    for (const t of [
      'schedule.created',
      'schedule.updated',
      'schedule.paused',
      'schedule.resumed',
      'schedule.deleted',
      'run.fired',
      'run.cantRun',
      'run.decided',
      'agents.off',
      'agents.on',
    ])
      expect(groupOf(e(t, {}, sys))).toBe('schedules');
    expect(groupOf(e('outcome.proposed', { type: 'schedule' }))).toBe('schedules');
    expect(groupOf(e('outcome.proposed', { type: 'reply' }))).toBe('plans');
    expect(isScheduleEvent(e('outcome.approved', { type: 'reply' }, human))).toBe(false);
  });
  it('filters: Schedules shows only schedule rows; plans and decisions drop the schedule outcome', () => {
    const all = { group: '' as const, actor: 'all' };
    expect(matches(e('outcome.proposed', { type: 'reply' }), { ...all, group: 'schedules' })).toBe(
      false,
    );
    expect(
      matches(e('outcome.proposed', { type: 'schedule' }), { ...all, group: 'schedules' }),
    ).toBe(true);
    expect(matches(e('outcome.proposed', { type: 'schedule' }), { ...all, group: 'plans' })).toBe(
      false,
    );
    expect(matches(e('outcome.proposed', { type: 'schedule' }), all)).toBe(true);
    expect(matches(e('run.fired', {}, sys), { ...all, group: 'schedules' })).toBe(true);
    expect(matches(e('run.fired', {}, sys), { ...all, group: 'threads' })).toBe(true);
  });
  it('says each in one line', () => {
    expect(
      threadSentence(
        e('outcome.proposed', { type: 'schedule', fields: { sentence: 'Every Monday at 08:00' } }),
      ),
    ).toEqual({
      before: 'proposed the schedule ',
      after: ' · Every Monday at 08:00',
      target: 'schedule',
    });
    expect(
      threadSentence(e('outcome.approved', { type: 'schedule', edited: true }, human)).before,
    ).toBe('edited and approved the schedule ');
    expect(threadSentence(e('schedule.updated', { ruleChanged: true }, human))).toMatchObject({
      before: 'edited the schedule ',
      after: ' · new times',
    });
    for (const [t, w] of [
      ['schedule.created', 'added'],
      ['schedule.paused', 'paused'],
      ['schedule.resumed', 'resumed'],
      ['schedule.deleted', 'deleted'],
    ] as const)
      expect(threadSentence(e(t, {}, human))).toMatchObject({
        before: `${w} the schedule `,
        target: 'schedule',
      });
    expect(threadSentence(e('run.fired', {}, sys), 0, 'Weekly report')).toEqual({
      before: 'started the scheduled run ',
      after: ' · Weekly report',
    });
    expect(threadSentence(e('run.cantRun', { why: 'offline' }, sys), 0, 'Weekly report')).toEqual({
      before: 'could not run ',
      after: `: ${WHY_TEXT.offline} · asked what to do · Weekly report`,
    });
    expect(
      threadSentence(e('run.decided', { choice: 'later' }, human), 0, 'Weekly report'),
    ).toEqual({
      before: 'chose “Try later” for ',
      after: ' · Weekly report',
    });
    expect(threadSentence(e('agents.off', { all: true, agents: [] }, human))).toMatchObject({
      before: 'turned all agents Off',
      target: 'none',
    });
    expect(threadSentence(e('agents.off', { all: false, agents: ['a'] }, human)).before).toBe(
      'turned 1 agent Off',
    );
    expect(threadSentence(e('agents.on', { all: false, agents: [] }, human)).before).toBe(
      'turned agents back On',
    );
  });
});
