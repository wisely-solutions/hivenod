/**
 * Scheduled tasks, slice 2: the actions on ./scheduleDocs.ts (design section 4, 5.2, 7). Like
 * ./inbox.ts, each is ONE batch: the change plus exactly one inbox event. The member creates,
 * edits, pauses, resumes and deletes his schedules, decides runs that could not happen and flips
 * his Off switch; an agent only proposes (a `proposed` schedule with a `schedule` outcome, which
 * the member approves through approveOutcome); the scheduler (notifier, Admin SDK, no rules)
 * fires runs with `fireScheduledRun`.
 */
import {
  ActionError,
  nid,
  requireAgent,
  requireHuman,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type WriteOp,
} from './actions';
import {
  cleanPlanSteps,
  inboxPaths,
  inboxPlan,
  INBOX_LIMITS,
  type PlanStepInput,
  type ThreadStateOf,
} from './inbox';
import { outcomeKind, outcomeType } from './outcomes';
import { planTemplate, templateSendBack } from './planTemplates';
import { planThreadState } from './plans';
import {
  RUN_CHOICE_STATE,
  SCHEDULE_LIMITS,
  scheduleDeleteEventId,
  schedulePaths,
  runDocId,
  type RunChoice,
  type ScheduleOf,
  type ScheduleRunOf,
  type ScheduleStep,
} from './scheduleDocs';
import {
  checkRule,
  fillPlaceholders,
  occurrenceWords,
  ruleSentence,
  urgencyOf,
  DEFAULT_SCHEDULE_TZ,
  type Occurrence,
  type ScheduleRule,
} from './schedules';

function need(cond: boolean, msg: string) {
  if (!cond) throw new ActionError(msg);
}
function owner(ctx: ActionContext, member: string) {
  requireHuman(ctx);
  need(member === ctx.actor.id, 'Only the person this is for can do this.');
}
const stamp = (eventId: string) => ({ updatedAt: SERVER_TIME, lastEventId: eventId });
const upd = (path: string, data: Record<string, unknown>, eventId: string): WriteOp => ({
  kind: 'update',
  path,
  data: { ...data, ...stamp(eventId) },
});

// ---------- the schedule's content ----------

/** What a member's form or an agent's proposal gives for a schedule. */
export interface ScheduleInput {
  title: string;
  what: string;
  rule: ScheduleRule;
  /** Default: "<title> · {period}". */
  runTitle?: string | null;
  steps: readonly PlanStepInput[];
  templateId?: string | null;
  subjectId?: string | null;
}
type CleanSchedule = Pick<
  ScheduleOf,
  'title' | 'what' | 'rule' | 'runTitle' | 'steps' | 'templateId' | 'subjectId'
>;

const RULE_KEYS = [
  'freq',
  'at',
  'tz',
  'date',
  'weekdays',
  'monthDay',
  'month',
  'weekend',
  'until',
] as const;

/** The rule with only its known keys, checked (checkRule's errors as one message). */
export function cleanRule(rule: ScheduleRule): ScheduleRule {
  need(!!rule && typeof rule === 'object', 'A schedule needs a rule.');
  const extra = Object.keys(rule).filter((k) => !(RULE_KEYS as readonly string[]).includes(k));
  need(extra.length === 0, `The rule has no ${extra.join(', ')}.`);
  const out: Record<string, unknown> = {};
  for (const k of RULE_KEYS) if (rule[k] !== undefined) out[k] = rule[k];
  const errors = checkRule(out as unknown as ScheduleRule);
  need(errors.length === 0, `The rule: ${errors.join('; ')}.`);
  need(
    out.tz === undefined || String(out.tz).length <= SCHEDULE_LIMITS.tz,
    'The time zone name is too long.',
  );
  return out as unknown as ScheduleRule;
}

function line(what: string, v: string | null | undefined, max: number): string {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  need(t.length > 0, `${what} is empty.`);
  need(t.length <= max, `${what} is at most ${max} characters.`);
  return t;
}

export function cleanSchedule(input: ScheduleInput): CleanSchedule {
  const title = line('The title', input.title, SCHEDULE_LIMITS.title);
  const what = (input.what ?? '').trim();
  need(what.length > 0, 'Say what to do each time.');
  need(
    what.length <= SCHEDULE_LIMITS.what,
    `What to do is at most ${SCHEDULE_LIMITS.what} characters.`,
  );
  const runTitle = input.runTitle?.trim()
    ? line('The run title', input.runTitle, SCHEDULE_LIMITS.runTitle)
    : `${title.slice(0, SCHEDULE_LIMITS.runTitle - 11)} · {period}`;
  const templateId = input.templateId?.trim() || null;
  need(
    templateId === null || planTemplate(templateId) !== null,
    `There is no template ${templateId}.`,
  );
  const steps: ScheduleStep[] = cleanPlanSteps(input.steps).map((s) => ({
    type: s.type,
    fields: s.fields,
  }));
  const subjectId = input.subjectId?.trim() || null;
  need(subjectId === null || subjectId.length <= 128, 'That subject id is too long.');
  return { title, what, rule: cleanRule(input.rule), runTitle, steps, templateId, subjectId };
}

// ---------- the member's own schedules ----------

/** The member makes a schedule himself: active at once (his form is his approval). */
export function createSchedule(
  ctx: ActionContext,
  input: ScheduleInput & { agentUid: string; scheduleId?: string },
): ActionPlan & { scheduleId: string } {
  requireHuman(ctx);
  const agentUid = input.agentUid?.trim() ?? '';
  need(agentUid.length > 0 && agentUid.length <= 128, 'Pick the agent that runs it.');
  const c = cleanSchedule(input);
  const scheduleId = input.scheduleId ?? nid(ctx);
  const me = ctx.actor.id;
  const p = inboxPlan(
    ctx,
    'schedule.created',
    { memberUid: me, subjectId: c.subjectId },
    { scheduleId },
    (eventId) => [
      {
        kind: 'set',
        path: schedulePaths.schedule(ctx.workspaceId, scheduleId),
        data: {
          memberUid: me,
          agentUid,
          ...c,
          state: 'active',
          activeFrom: SERVER_TIME,
          proposal: null,
          replaces: null,
          version: 1,
          createdBy: { type: 'human', id: me },
          createdAt: SERVER_TIME,
          ...stamp(eventId),
        },
      },
    ],
  );
  return { ...p, scheduleId };
}

function editable(s: ScheduleOf) {
  need(
    s.state === 'active' || s.state === 'paused',
    s.state === 'proposed'
      ? 'This schedule is still a proposal: approve or reject it.'
      : 'This schedule has ended.',
  );
}

/**
 * Edit: what, rule, run title, plan, template, subject. A changed rule starts from now
 * (activeFrom), so a past time of the new rule never fires late.
 */
export function editSchedule(
  ctx: ActionContext,
  input: { scheduleId: string; schedule: ScheduleOf; changes: Partial<ScheduleInput> },
): ActionPlan {
  const s = input.schedule;
  owner(ctx, s.memberUid);
  editable(s);
  const c = cleanSchedule({ ...s, ...input.changes });
  const ruleChanged = JSON.stringify(c.rule) !== JSON.stringify(cleanRule(s.rule));
  return inboxPlan(
    ctx,
    'schedule.updated',
    { memberUid: s.memberUid, subjectId: c.subjectId },
    { scheduleId: input.scheduleId, ruleChanged },
    (eventId) => [
      upd(
        schedulePaths.schedule(ctx.workspaceId, input.scheduleId),
        { ...c, version: s.version + 1, ...(ruleChanged ? { activeFrom: SERVER_TIME } : {}) },
        eventId,
      ),
    ],
  );
}

/** Pause: nothing fires until resumed. */
export function pauseSchedule(
  ctx: ActionContext,
  input: { scheduleId: string; schedule: ScheduleOf },
): ActionPlan {
  const s = input.schedule;
  owner(ctx, s.memberUid);
  need(s.state === 'active', 'Only an active schedule can be paused.');
  return inboxPlan(
    ctx,
    'schedule.paused',
    { memberUid: s.memberUid, subjectId: s.subjectId },
    { scheduleId: input.scheduleId },
    (eventId) => [
      upd(
        schedulePaths.schedule(ctx.workspaceId, input.scheduleId),
        { state: 'paused', version: s.version + 1 },
        eventId,
      ),
    ],
  );
}

/** Resume: from now on (runs that fell in the pause never fire, and are not asked about). */
export function resumeSchedule(
  ctx: ActionContext,
  input: { scheduleId: string; schedule: ScheduleOf },
): ActionPlan {
  const s = input.schedule;
  owner(ctx, s.memberUid);
  need(s.state === 'paused', 'Only a paused schedule can be resumed.');
  return inboxPlan(
    ctx,
    'schedule.resumed',
    { memberUid: s.memberUid, subjectId: s.subjectId },
    { scheduleId: input.scheduleId },
    (eventId) => [
      upd(
        schedulePaths.schedule(ctx.workspaceId, input.scheduleId),
        { state: 'active', activeFrom: SERVER_TIME, version: s.version + 1 },
        eventId,
      ),
    ],
  );
}

/** Delete: the schedule goes; its past runs and their threads stay. */
export function deleteSchedule(
  ctx: ActionContext,
  input: { scheduleId: string; schedule: ScheduleOf },
): ActionPlan {
  const s = input.schedule;
  owner(ctx, s.memberUid);
  need(s.state !== 'proposed', 'This schedule is a proposal: reject it on its thread.');
  return inboxPlan(
    ctx,
    'schedule.deleted',
    { memberUid: s.memberUid, subjectId: s.subjectId },
    { scheduleId: input.scheduleId, title: s.title },
    () => [{ kind: 'delete', path: schedulePaths.schedule(ctx.workspaceId, input.scheduleId) }],
    scheduleDeleteEventId(input.scheduleId),
  );
}

// ---------- the agent proposes ----------

/**
 * schedule_propose (the agent tool comes in slice 5): a `proposed` schedule and its `schedule`
 * outcome on the member's thread (the thread goes to Your call). Only the member's approval
 * activates it. `replaces`: a change of one of this agent's active (or paused) schedules.
 */
export function proposeSchedule(
  ctx: ActionContext,
  input: ScheduleInput & {
    threadId: string;
    thread: ThreadStateOf;
    note?: string;
    replaces?: { id: string; schedule: ScheduleOf } | null;
    scheduleId?: string;
    outcomeId?: string;
  },
): ActionPlan & { scheduleId: string; outcomeId: string; sentence: string } {
  requireAgent(ctx);
  const t = input.thread;
  const me = ctx.actor.id;
  need(t.state !== 'ignored', 'This thread was ignored: bring it back first.');
  need(t.fetchedBy === me, 'Only the thread’s home agent proposes a schedule on it.');
  const rep = input.replaces ?? null;
  if (rep) {
    need(rep.schedule.memberUid === t.memberUid, 'That schedule is someone else’s.');
    need(rep.schedule.agentUid === me, 'You can only propose changes to schedules you run.');
    editable(rep.schedule);
  }
  const c = cleanSchedule(input);
  const note = (input.note ?? '').trim();
  need(
    note.length <= INBOX_LIMITS.outcomeNote,
    `The note is at most ${INBOX_LIMITS.outcomeNote} characters.`,
  );
  const scheduleId = input.scheduleId ?? nid(ctx);
  const outcomeId = input.outcomeId ?? nid(ctx);
  const sentence = ruleSentence(c.rule).slice(0, 300);
  const fields = { scheduleId, sentence };
  const w = ctx.workspaceId;
  const p = inboxPlan(
    ctx,
    'outcome.proposed',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { outcomeId, type: 'schedule', fields, scheduleId },
    (eventId) => [
      {
        kind: 'set',
        path: schedulePaths.schedule(w, scheduleId),
        data: {
          memberUid: t.memberUid,
          agentUid: me,
          ...c,
          state: 'proposed',
          activeFrom: null,
          proposal: { threadId: input.threadId, outcomeId, by: me },
          replaces: rep?.id ?? null,
          version: 1,
          createdBy: { type: 'agent', id: me },
          createdAt: SERVER_TIME,
          ...stamp(eventId),
        },
      },
      {
        kind: 'set',
        path: inboxPaths.outcome(w, outcomeId),
        data: {
          memberUid: t.memberUid,
          threadId: input.threadId,
          type: 'schedule',
          fields,
          state: 'proposed',
          note,
          proposedBy: me,
          executor: null,
          decision: null,
          result: null,
          createdAt: SERVER_TIME,
          ...stamp(eventId),
        },
      },
      upd(inboxPaths.thread(w, input.threadId), { state: 'yourCall', waiting: null }, eventId),
    ],
  );
  return { ...p, scheduleId, outcomeId, sentence };
}

// ---------- runs that could not happen: the member decides ----------

/**
 * Run now · Try later · Skip this one, on a run that could not happen (`cantRun`). The scheduler
 * acts on it (fires it now, at `laterAt`, or never).
 */
export function decideRun(
  ctx: ActionContext,
  input: {
    runId: string;
    run: ScheduleRunOf;
    choice: RunChoice;
    laterAt?: Date | null;
    nowMs: number;
  },
): ActionPlan {
  const r = input.run;
  owner(ctx, r.memberUid);
  need(r.state === 'cantRun', 'This run was already decided.');
  const state = RUN_CHOICE_STATE[input.choice];
  need(state !== undefined, 'Run now, try later or skip.');
  const later = input.choice === 'later' ? (input.laterAt ?? null) : null;
  if (input.choice === 'later')
    need(
      later !== null &&
        later.getTime() > input.nowMs &&
        later.getTime() <= input.nowMs + SCHEDULE_LIMITS.laterMs,
      'Pick a later time within the next 35 days.',
    );
  const via = ctx.via === 'telegram' ? 'telegram' : 'web';
  return inboxPlan(
    ctx,
    'run.decided',
    { memberUid: r.memberUid, threadId: r.threadId ?? null },
    { runId: input.runId, scheduleId: r.scheduleId, choice: input.choice },
    (eventId) => [
      upd(
        schedulePaths.run(ctx.workspaceId, input.runId),
        {
          state,
          decision: { choice: input.choice, by: ctx.actor.id, at: SERVER_TIME, via },
          ...(later ? { laterAt: later } : {}),
        },
        eventId,
      ),
    ],
  );
}

// ---------- the Off switch ----------

/**
 * Agents Off / On in this organization (design 9.4: "All agents" writes each org the member is
 * in, one batch each). Off silences every agent (`all`) or the ones listed; no timer turns it
 * back on.
 */
export function setAgentsOff(
  ctx: ActionContext,
  input: { all: boolean; agents?: readonly string[] },
): ActionPlan & { off: boolean } {
  requireHuman(ctx);
  const agents = [...new Set((input.agents ?? []).map((a) => a.trim()))];
  need(
    agents.every((a) => a.length > 0 && a.length <= 128),
    'Pick agents by their id.',
  );
  need(
    agents.length <= SCHEDULE_LIMITS.offAgents,
    `At most ${SCHEDULE_LIMITS.offAgents} agents; turn all of them off instead.`,
  );
  const all = input.all === true;
  const off = all || agents.length > 0;
  const me = ctx.actor.id;
  const p = inboxPlan(
    ctx,
    off ? 'agents.off' : 'agents.on',
    { memberUid: me },
    { all, agents: all ? [] : agents },
    (eventId) => [
      {
        kind: 'set',
        path: schedulePaths.off(ctx.workspaceId, me),
        data: {
          all,
          agents: all ? [] : agents,
          since: off ? SERVER_TIME : null,
          ...stamp(eventId),
        },
      },
    ],
  );
  return { ...p, off };
}

// ---------- the scheduler fires a run (Admin SDK) ----------

export const SCHEDULER_ACTOR = {
  type: 'system',
  id: 'scheduler',
  name: 'Hivenod scheduler',
} as const;
export const SCHEDULE_SOURCE = 'schedule';

/** The first message of a run thread: what, and when it was due. */
export function runMessageText(
  s: Pick<ScheduleOf, 'what' | 'rule'>,
  title: string,
  occ: Occurrence,
) {
  return [
    title,
    s.what,
    `Due ${occurrenceWords(occ)} (${s.rule.tz ?? DEFAULT_SCHEDULE_TZ}) · ${ruleSentence(s.rule)}`,
  ]
    .join('\n\n')
    .slice(0, INBOX_LIMITS.text);
}

/**
 * Fires one run (design 5.2): the run doc (create(): a second fire of the same period fails as a
 * whole), the thread (its id derived from schedule + key by the caller), its first message, the
 * plan with its steps, and one `thread.created` event; one batch, applied with the Admin SDK by
 * the scheduler only (no rule lets anyone else write runs). The schedule's approval is the
 * approval of its agent steps, so they start `approved`; person steps stay gates. The agent's
 * feed then delivers the thread and the first step's carry_out as for any thread.
 * `runExists`: the run was created earlier as `waitingAgent` (or decided Run now / later): it is
 * updated to `fired` instead.
 */
export function fireScheduledRun(input: {
  workspaceId: string;
  scheduleId: string;
  schedule: ScheduleOf;
  occurrence: Occurrence;
  threadId: string;
  planId: string;
  stepIds: readonly string[];
  messageId: string;
  eventId: string;
  runExists?: { attempts: number } | null;
}): ActionPlan & { runId: string } {
  const s = input.schedule;
  const occ = input.occurrence;
  const w = input.workspaceId;
  need(s.state === 'active', 'Only an active schedule fires.');
  need(
    input.stepIds.length === s.steps.length && new Set(input.stepIds).size === input.stepIds.length,
    'One distinct id per step.',
  );
  const runId = runDocId(input.scheduleId, occ.key);
  const title = fillPlaceholders(s.runTitle, occ).slice(0, INBOX_LIMITS.title);
  const member = s.memberUid;
  const steps = s.steps.map((st, i) => {
    const t = outcomeType(st.type);
    need(t !== null && t.plan === true, `Step ${i + 1}: ${st.type} is not a plan step.`);
    const fields = Object.fromEntries(
      Object.entries(st.fields).map(([k, v]) => [
        k,
        typeof v === 'string' ? fillPlaceholders(v, occ) : v,
      ]),
    );
    return {
      id: input.stepIds[i]!,
      type: st.type,
      fields,
      state: outcomeKind(st.type) === 'human' ? ('proposed' as const) : ('approved' as const),
      executor: t!.executor === 'agent' ? s.agentUid : null,
    };
  });
  const outs = Object.fromEntries(
    steps.map((st) => [st.id, { type: st.type, fields: st.fields, state: st.state }]),
  );
  const state = planThreadState({ steps: [...input.stepIds], cursor: 0, state: 'active' }, outs);
  const eventId = input.eventId;
  const st = stamp(eventId);
  const run: Record<string, unknown> = input.runExists
    ? {
        state: 'fired',
        why: null,
        threadId: input.threadId,
        attempts: input.runExists.attempts + 1,
        firedAt: SERVER_TIME,
        ...st,
      }
    : {
        memberUid: member,
        scheduleId: input.scheduleId,
        agentUid: s.agentUid,
        key: occ.key,
        period: occ.period,
        dueAt: new Date(occ.dueMs),
        title,
        state: 'fired',
        why: null,
        threadId: input.threadId,
        attempts: 1,
        laterAt: null,
        firedAt: SERVER_TIME,
        startedAt: null,
        endedAt: null,
        ask: null,
        decision: null,
        scheduleVersion: s.version,
        createdAt: SERVER_TIME,
        ...st,
      };
  const ops: WriteOp[] = [
    { kind: input.runExists ? 'update' : 'create', path: schedulePaths.run(w, runId), data: run },
    {
      kind: 'create',
      path: inboxPaths.message(w, input.messageId),
      data: {
        memberUid: member,
        threadId: input.threadId,
        direction: 'in',
        source: SCHEDULE_SOURCE,
        sender: { name: SCHEDULER_ACTOR.name, handle: null },
        text: runMessageText(s, title, occ),
        threadRef: input.threadId,
        messageId: input.messageId,
        permalink: null,
        replyRef: null,
        receivedAt: SERVER_TIME,
        attachments: [],
        fetchedBy: SCHEDULER_ACTOR.id,
        createdAt: SERVER_TIME,
        lastEventId: eventId,
      },
    },
    {
      kind: 'create',
      path: inboxPaths.thread(w, input.threadId),
      data: {
        memberUid: member,
        subjectId: s.subjectId,
        ...state,
        question: null,
        title,
        refs: [input.threadId],
        lastMessageAt: SERVER_TIME,
        fetchedBy: s.agentUid,
        urgent: urgencyOf(s.rule.freq) === 'urgent',
        schedule: { scheduleId: input.scheduleId, runKey: occ.key },
        createdAt: SERVER_TIME,
        ...st,
      },
    },
    ...steps.map((x): WriteOp => ({
      kind: 'create',
      path: inboxPaths.outcome(w, x.id),
      data: {
        memberUid: member,
        threadId: input.threadId,
        type: x.type,
        fields: x.fields,
        state: x.state,
        note: '',
        proposedBy: member,
        executor: x.executor,
        decision: null,
        result: null,
        planId: input.planId,
        createdAt: SERVER_TIME,
        ...st,
      },
    })),
    {
      kind: 'create',
      path: inboxPaths.plan(w, input.planId),
      data: {
        memberUid: member,
        threadId: input.threadId,
        proposedBy: member,
        steps: [...input.stepIds],
        cursor: 0,
        state: 'active',
        note: '',
        templateId: s.templateId,
        ...(s.templateId ? { sendBackTo: templateSendBack(s.templateId, input.stepIds) } : {}),
        createdAt: SERVER_TIME,
        ...st,
      },
    },
    {
      kind: 'create',
      path: inboxPaths.event(w, eventId),
      data: {
        actor: { ...SCHEDULER_ACTOR },
        memberUid: member,
        threadId: input.threadId,
        subjectId: s.subjectId,
        type: 'thread.created',
        data: {
          messageDocId: input.messageId,
          agentUid: s.agentUid,
          planId: input.planId,
          steps: [...input.stepIds],
          templateId: s.templateId,
          scheduleId: input.scheduleId,
          runKey: occ.key,
          runId,
        },
        at: SERVER_TIME,
      },
    },
  ];
  return { eventId, ops, runId };
}
