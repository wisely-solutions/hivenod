/**
 * Contract cases for scheduled tasks, slice 5 (agents propose schedules): checkRule, ruleSentence
 * and nextRuns of packages/shared/src/schedules.ts, proposeSchedule and reviseSchedule of
 * scheduleActions.ts, and their Go port cli/internal/actions/schedules.go. Kept apart from
 * cases.ts so parallel work on other actions merges cleanly.
 */
import {
  checkRule,
  nextRuns,
  proposeSchedule,
  proposeScheduleEnd,
  reviseOutcome,
  reviseSchedule,
  ruleSentence,
} from '../../packages/shared/src/index';
import type {
  ActionContext,
  Actor,
  OutcomeStateOf,
  ScheduleOf,
  ScheduleRule,
  ThreadStateOf,
} from '../../packages/shared/src/index';

type Act = <I>(
  name: string,
  action: string,
  actor: Actor,
  input: I,
  fn: (ctx: ActionContext, input: I) => unknown,
) => void;
type Pure = <I>(name: string, action: string, input: I, fn: (input: I) => unknown) => void;

const MONTHLY: ScheduleRule = { freq: 'monthly', at: '09:00', tz: 'Europe/Lisbon', monthDay: 1 };

export function scheduleCases(
  act: Act,
  pure: Pure,
  who: { agent: Actor; other: Actor; human: Actor },
) {
  // ---------- checkRule: the same plain errors in Go ----------
  const check = (name: string, rule: unknown) =>
    pure(`checkRule/${name}`, 'checkRule', { rule }, (i) => checkRule(i.rule as ScheduleRule));
  check('monthly ok', MONTHLY);
  check('daily weekdays ok', { freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 4, 5] });
  check('weekly without weekdays', { freq: 'weekly', at: '16:00' });
  check('weekly bad weekdays', { freq: 'weekly', at: '16:00', weekdays: [0, 8] });
  check('weekly duplicate weekdays', { freq: 'weekly', at: '16:00', weekdays: [5, 5] });
  check('weekly empty weekdays', { freq: 'weekly', at: '16:00', weekdays: [] });
  check('weekdays on monthly', { ...MONTHLY, weekdays: [1] });
  check('monthDay 0', { ...MONTHLY, monthDay: 0 });
  check('monthDay 32', { ...MONTHLY, monthDay: 32 });
  check('monthDay 1.5', { ...MONTHLY, monthDay: 1.5 });
  check('monthDay last', { ...MONTHLY, monthDay: -1 });
  check('monthly without monthDay', { freq: 'monthly', at: '09:00' });
  check('monthDay on daily', { freq: 'daily', at: '09:00', monthDay: 3 });
  check('at 24:00', { ...MONTHLY, at: '24:00' });
  check('at 9:00', { ...MONTHLY, at: '9:00' });
  check('at a number', { ...MONTHLY, at: 900 });
  check('unknown tz', { ...MONTHLY, tz: 'Mars/Olympus' });
  check('empty tz', { ...MONTHLY, tz: '' });
  check('tz null', { ...MONTHLY, tz: null });
  check('New York tz', { ...MONTHLY, tz: 'America/New_York' });
  check('UTC', { ...MONTHLY, tz: 'UTC' });
  check('once without date', { freq: 'once', at: '10:00' });
  check('once with until', { freq: 'once', at: '10:00', date: '2027-01-05', until: '2027-02-01' });
  check('once ok', { freq: 'once', at: '10:00', date: '2027-01-05' });
  check('bad date', { freq: 'once', at: '10:00', date: '2027-02-30' });
  check('until before date', { ...MONTHLY, date: '2027-03-01', until: '2027-02-01' });
  check('until null', { ...MONTHLY, until: null });
  check('bad until', { ...MONTHLY, until: 'soon' });
  check('yearly without month', { freq: 'yearly', at: '09:00', monthDay: 2 });
  check('yearly 30 Feb', { freq: 'yearly', at: '09:00', monthDay: 30, month: 2 });
  check('yearly 29 Feb', { freq: 'yearly', at: '09:00', monthDay: 29, month: 2 });
  check('month 13', { freq: 'quarterly', at: '09:00', monthDay: 1, month: 13 });
  check('month on monthly', { ...MONTHLY, month: 3 });
  check('weekend bad', { ...MONTHLY, weekend: 'never' });
  check('weekend on daily', { freq: 'daily', at: '09:00', weekend: 'after' });
  check('weekend keep on daily', { freq: 'daily', at: '09:00', weekend: 'keep' });
  check('unknown freq', { freq: 'hourly', at: '09:00' });
  check('not a rule', null);
  check('several errors', { freq: 'weekly', at: '25:00', tz: 'Nowhere', monthDay: 3 });

  // ---------- ruleSentence ----------
  const sentence = (name: string, rule: ScheduleRule) =>
    pure(`ruleSentence/${name}`, 'ruleSentence', { rule }, (i) => ruleSentence(i.rule));
  sentence('monthly', MONTHLY);
  sentence('monthly last day, Mon if weekend', { ...MONTHLY, monthDay: -1, weekend: 'after' });
  sentence('weekly New York', {
    freq: 'weekly',
    at: '16:00',
    tz: 'America/New_York',
    weekdays: [5],
  });
  sentence('daily weekdays', { freq: 'daily', at: '08:30', weekdays: [5, 1, 2, 3, 4] });
  sentence('daily every day', { freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 4, 5, 6, 7] });
  sentence('daily until', { freq: 'daily', at: '08:30', until: '2027-01-31' });
  sentence('weekly two runs', { freq: 'weekly', at: '07:00', weekdays: [1, 2, 4, 6, 7] });
  sentence('quarterly', {
    freq: 'quarterly',
    at: '17:00',
    monthDay: -1,
    month: 2,
    weekend: 'before',
  });
  sentence('yearly', { freq: 'yearly', at: '09:00', monthDay: 2, month: 3 });
  sentence('yearly last day', { freq: 'yearly', at: '09:00', monthDay: -1, month: 2 });
  sentence('once', { freq: 'once', at: '10:00', date: '2026-11-12', tz: 'Asia/Tokyo' });

  // ---------- nextRuns: schedule_list's next runs ----------
  const LISBON_2026 = Date.UTC(2026, 9, 30, 12, 0); // Fri 30 Oct 2026 12:00 UTC
  const runs = (name: string, rule: ScheduleRule, fromMs = LISBON_2026, n = 3) =>
    pure(`nextRuns/${name}`, 'nextRuns', { rule, fromMs, n }, (i) =>
      nextRuns(i.rule, i.fromMs, i.n),
    );
  runs('monthly', MONTHLY);
  runs('monthly day 31', { ...MONTHLY, monthDay: 31 }, LISBON_2026, 5);
  runs('monthly weekend before', { ...MONTHLY, weekend: 'before' }, LISBON_2026, 6);
  runs('monthly weekend after', { ...MONTHLY, weekend: 'after' }, LISBON_2026, 6);
  runs('yearly 29 Feb', { freq: 'yearly', at: '09:00', monthDay: 29, month: 2 }, LISBON_2026, 3);
  runs('quarterly anchor Feb', { freq: 'quarterly', at: '17:00', monthDay: -1, month: 2 });
  runs(
    'daily gap',
    { freq: 'daily', at: '01:30', tz: 'Europe/Lisbon' },
    Date.UTC(2026, 2, 27, 12),
    4,
  );
  runs(
    'daily overlap',
    { freq: 'daily', at: '01:30', tz: 'Europe/Lisbon' },
    Date.UTC(2026, 9, 23, 12),
    4,
  );
  runs(
    'weekly New York over its DST change',
    { freq: 'weekly', at: '16:00', tz: 'America/New_York', weekdays: [5] },
    Date.UTC(2026, 9, 20),
    4,
  );
  runs('daily Mon-Fri', { freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 4, 5] }, LISBON_2026, 5);
  runs('daily until', { freq: 'daily', at: '08:30', until: '2026-11-01' }, LISBON_2026, 5);
  runs('daily from a start date', { freq: 'daily', at: '08:30', date: '2026-12-24' });
  runs('once ahead', { freq: 'once', at: '10:00', date: '2026-11-12', tz: 'Asia/Tokyo' });
  runs('once passed', { freq: 'once', at: '10:00', date: '2026-10-01' });
  runs('today later', { freq: 'daily', at: '23:59', tz: 'UTC' }, LISBON_2026, 2);
  runs('Sydney', { freq: 'monthly', at: '00:15', tz: 'Australia/Sydney', monthDay: 1 });
  runs('zero', MONTHLY, LISBON_2026, 0);

  // ---------- proposeSchedule ----------
  const TH = (over: Partial<ThreadStateOf> = {}): ThreadStateOf => ({
    memberUid: 'joao',
    subjectId: 's1',
    state: 'investigating',
    fetchedBy: 'agentA',
    refs: ['r1'],
    waiting: null,
    ...over,
  });
  const BASE = {
    threadId: 'it1',
    thread: TH(),
    title: '  Send   invoices ',
    what: ' Prepare the invoices from the hours log and ask me before sending. ',
    rule: MONTHLY,
    steps: [
      { type: 'reply', fields: { text: ' Invoices for {period} are ready. ' } },
      { type: 'approval', fields: { what: 'Send the invoices for {month}' } },
    ],
  };
  const SCH = (over: Partial<ScheduleOf> = {}): ScheduleOf => ({
    memberUid: 'joao',
    agentUid: 'agentA',
    title: 'Send invoices',
    what: 'Prepare the invoices.',
    rule: MONTHLY,
    runTitle: 'Send invoices · {period}',
    steps: [{ type: 'approval', fields: { what: 'Send them' } }],
    templateId: null,
    subjectId: 's9',
    state: 'active',
    proposal: null,
    replaces: null,
    version: 3,
    ...over,
  });
  const prop = (name: string, actor: Actor, over: Record<string, unknown>) =>
    act(
      `proposeSchedule/${name}`,
      'proposeSchedule',
      actor,
      { ...BASE, ...over } as Parameters<typeof proposeSchedule>[1],
      proposeSchedule,
    );
  prop('new', who.agent, {});
  prop('with everything', who.agent, {
    runTitle: ' Invoices · {month} {year} ',
    templateId: 'dev',
    subjectId: ' s2 ',
    note: ' Same as by hand on 1 Oct. ',
    confidence: 'high',
    checks: [' Ran it by hand on 1 Oct '],
    scheduleId: 'sch1',
    outcomeId: 'out1',
  });
  prop('long title default run title', who.agent, { title: 'x'.repeat(80) });
  prop('a change of an active one', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    rule: { freq: 'weekly', at: '16:00', weekdays: [5] },
  });
  prop('a change of a paused one', who.agent, {
    replaces: { id: 'sA', schedule: SCH({ state: 'paused' }) },
  });
  prop('a change of a proposed one', who.agent, {
    replaces: { id: 'sA', schedule: SCH({ state: 'proposed' }) },
  });
  prop('a change of an ended one', who.agent, {
    replaces: { id: 'sA', schedule: SCH({ state: 'ended' }) },
  });
  prop('a change of someone else’s', who.agent, {
    replaces: { id: 'sA', schedule: SCH({ memberUid: 'ana' }) },
  });
  prop('a change of another agent’s', who.agent, {
    replaces: { id: 'sA', schedule: SCH({ agentUid: 'agentB' }) },
  });
  prop('a merge', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [
      { id: 'sB', schedule: SCH({ state: 'paused' }) },
      { id: 'sC', schedule: SCH() },
    ],
  });
  prop('a merge keeps ids in order', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [{ id: 'sB', schedule: SCH() }],
    scheduleId: 'sch2',
    outcomeId: 'out2',
  });
  prop('ends without replaces', who.agent, { ends: [{ id: 'sB', schedule: SCH() }] });
  prop('a merge of nine', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, schedule: SCH() })),
  });
  prop('a merge names one twice', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [{ id: 'sA', schedule: SCH() }],
  });
  prop('a merge with a repeated end', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [
      { id: 'sB', schedule: SCH() },
      { id: 'sB', schedule: SCH() },
    ],
  });
  prop('a merge with someone else’s', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [{ id: 'sB', schedule: SCH({ memberUid: 'ana' }) }],
  });
  prop('a merge with another agent’s', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [{ id: 'sB', schedule: SCH({ agentUid: 'agentB' }) }],
  });
  prop('a merge with an ended one', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [{ id: 'sB', schedule: SCH({ state: 'ended' }) }],
  });
  prop('a merge with a proposed one', who.agent, {
    replaces: { id: 'sA', schedule: SCH() },
    ends: [{ id: 'sB', schedule: SCH({ state: 'proposed' }) }],
  });
  prop('ignored thread', who.agent, { thread: TH({ state: 'ignored' }) });
  prop('not the home agent', who.other, {});
  prop('a person', who.human, {});
  prop('bad rule', who.agent, { rule: { freq: 'weekly', at: '24:00' } });
  prop('extra rule key', who.agent, { rule: { ...MONTHLY, every: 2 } });
  prop('long tz', who.agent, { rule: { ...MONTHLY, tz: 'A'.repeat(70) } });
  prop('empty title', who.agent, { title: '   ' });
  prop('long title', who.agent, { title: 'x'.repeat(81) });
  prop('empty what', who.agent, { what: ' ' });
  prop('long what', who.agent, { what: 'x'.repeat(4001) });
  prop('long run title', who.agent, { runTitle: 'x'.repeat(101) });
  prop('unknown template', who.agent, { templateId: 'nope' });
  prop('no steps', who.agent, { steps: [] });
  prop('nine steps', who.agent, {
    steps: Array.from({ length: 9 }, () => ({ type: 'approval', fields: { what: 'x' } })),
  });
  prop('not a plan step', who.agent, { steps: [{ type: 'schedule', fields: {} }] });
  prop('bad step fields', who.agent, { steps: [{ type: 'reply', fields: {} }] });
  prop('long subject id', who.agent, { subjectId: 's'.repeat(129) });
  prop('long note', who.agent, { note: 'x'.repeat(2001) });
  prop('bad confidence', who.agent, { confidence: 'sure' });
  prop('too many checks', who.agent, { checks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });

  // ---------- proposeScheduleEnd (schedule_end) ----------
  const endIt = (name: string, actor: Actor, over: Record<string, unknown>) =>
    act(
      `proposeScheduleEnd/${name}`,
      'proposeScheduleEnd',
      actor,
      {
        threadId: 'it1',
        thread: TH(),
        schedule: { id: 'sA', data: SCH() },
        reason: ' Replaced by the weekly report. ',
        ...over,
      } as Parameters<typeof proposeScheduleEnd>[1],
      proposeScheduleEnd,
    );
  endIt('active', who.agent, {});
  endIt('paused, with everything', who.agent, {
    schedule: { id: 'sA', data: SCH({ state: 'paused' }) },
    note: ' Nobody reads it any more. ',
    confidence: 'high',
    checks: [' Last 3 runs were skipped '],
    outcomeId: 'out1',
  });
  endIt('a proposed one', who.agent, { schedule: { id: 'sA', data: SCH({ state: 'proposed' }) } });
  endIt('an ended one', who.agent, { schedule: { id: 'sA', data: SCH({ state: 'ended' }) } });
  endIt('someone else’s', who.agent, { schedule: { id: 'sA', data: SCH({ memberUid: 'ana' }) } });
  endIt('another agent’s', who.agent, {
    schedule: { id: 'sA', data: SCH({ agentUid: 'agentB' }) },
  });
  endIt('ignored thread', who.agent, { thread: TH({ state: 'ignored' }) });
  endIt('not the home agent', who.other, {});
  endIt('a person', who.human, {});
  endIt('no reason', who.agent, { reason: '   ' });
  endIt('long reason', who.agent, { reason: 'x'.repeat(301) });
  endIt('long note', who.agent, { note: 'x'.repeat(2001) });
  endIt('bad confidence', who.agent, { confidence: 'sure' });
  endIt('too many checks', who.agent, { checks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });

  // ---------- reviseSchedule (schedule_propose revises) ----------
  const OUT = (over: Partial<OutcomeStateOf> = {}): OutcomeStateOf => ({
    memberUid: 'joao',
    threadId: 'it1',
    type: 'schedule',
    fields: { scheduleId: 'sp1', sentence: 'Monthly · day 1 · 09:00' },
    state: 'revising',
    executor: null,
    proposedBy: 'agentA',
    note: 'First go.',
    revise: { instruction: 'At 08:30', chips: [], byUid: 'joao', at: null as never },
    ...over,
  });
  const PROPOSED = SCH({
    state: 'proposed',
    proposal: { threadId: 'it1', outcomeId: 'o1', by: 'agentA' },
    version: 1,
  });
  const rev = (name: string, actor: Actor, over: Record<string, unknown>) =>
    act(
      `reviseSchedule/${name}`,
      'reviseSchedule',
      actor,
      {
        ...BASE,
        rule: { ...MONTHLY, at: '08:30' },
        outcomeId: 'o1',
        outcome: OUT(),
        thread: TH({ state: 'yourCall' }),
        schedule: { id: 'sp1', data: PROPOSED },
        note: ' Moved to 08:30. ',
        ...over,
      } as Parameters<typeof reviseSchedule>[1],
      reviseSchedule,
    );
  rev('revised', who.agent, {});
  rev('subject given', who.agent, { subjectId: 's3', confidence: 'medium', checks: ['ok'] });
  rev('subject cleared', who.agent, { subjectId: null });
  rev('second revision', who.agent, {
    outcome: OUT({
      versions: [
        {
          n: 1,
          fields: { scheduleId: 'sp1', sentence: 'a' },
          note: '',
          confidence: null,
          checks: [],
          by: 'agentA',
          eventId: null,
          asked: null,
        },
        {
          n: 2,
          fields: { scheduleId: 'sp1', sentence: 'b' },
          note: '',
          confidence: null,
          checks: [],
          by: 'agentA',
          eventId: 'ev2',
          asked: { instruction: 'x', chips: [] },
        },
      ],
    }),
  });
  rev('a merge stays a merge', who.agent, {
    outcome: OUT({ fields: { scheduleId: 'sp1', sentence: 'x', ends: 'sB,sC' } }),
  });
  rev('nobody asked', who.agent, { outcome: OUT({ state: 'proposed', revise: null }) });
  rev('not a schedule outcome', who.agent, { outcome: OUT({ type: 'reply' }) });
  rev('another schedule', who.agent, { schedule: { id: 'sp2', data: PROPOSED } });
  rev('already active', who.agent, {
    schedule: { id: 'sp1', data: { ...PROPOSED, state: 'active' } },
  });
  rev('another agent', who.other, {});
  rev('bad rule', who.agent, { rule: { freq: 'monthly', at: '09:00' } });
  rev('a person', who.human, {});
  act(
    'reviseOutcome/schedule refused',
    'reviseOutcome',
    who.agent,
    { outcomeId: 'o1', outcome: OUT(), thread: TH(), fields: {} },
    reviseOutcome,
  );
}
