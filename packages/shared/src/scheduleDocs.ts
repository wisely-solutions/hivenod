/**
 * Scheduled tasks, slice 2: the documents (design ~/drafts/schedules/design.md, section 4). All
 * under `workspaces/{wid}` (agents are per organization):
 *
 *   schedules/{sid}             a member's schedule: rule, home agent, the plan of each run.
 *                               `proposed` by an agent (with a `schedule` outcome), `active` once
 *                               the member approves (or makes it himself), `paused`, `ended`.
 *   scheduleRuns/{sid}_{key}    one per period (deterministic id, written with create() by the
 *                               scheduler alone: a second fire is a no-op). Written only on its
 *                               transitions; the member only decides a `cantRun` one.
 *   agentsOff/{memberUid}       the member's Off switch in this org (absent = all on).
 *
 * Cost (João, 2026-10-30: "as cheap as possible"): nothing here is rewritten on a timer. A
 * schedule is written when the member or its agent changes it; a run when its state changes;
 * the Off doc when the member flips it. "Next run" is computed (./schedules.ts), never stored.
 *
 * This module has no inbox import (inbox.ts uses its approval ops); the actions are in
 * ./scheduleActions.ts. The rules (firestore.rules, "scheduled tasks") check the same shapes.
 */
import { z } from 'zod';
import { SERVER_TIME, type WriteOp } from './actions';
import { checkRule, SCHEDULE_FREQS, type ScheduleRule } from './schedules';
import { timestamp } from './schema';

export const SCHEDULE_STATES = ['proposed', 'active', 'paused', 'ended'] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

/** A run's states (design 4): written only when it moves from one to the next. */
export const RUN_STATES = [
  'waitingAgent',
  'fired',
  'running',
  'done',
  'stopped',
  'cantRun',
  'runNow',
  'later',
  'skipped',
  'expired',
] as const;
export type RunState = (typeof RUN_STATES)[number];
/** Why a run could not happen. */
export const RUN_WHY = [
  'offline',
  'off',
  'paused',
  'hostDown',
  'noStart',
  'failed',
  'cliOld',
] as const;
export type RunWhy = (typeof RUN_WHY)[number];
/** The member's answer to a run that could not happen, and the run state it leads to. */
export const RUN_CHOICES = ['runNow', 'later', 'skip'] as const;
export type RunChoice = (typeof RUN_CHOICES)[number];
export const RUN_CHOICE_STATE: Record<RunChoice, RunState> = {
  runNow: 'runNow',
  later: 'later',
  skip: 'skipped',
};

export const SCHEDULE_LIMITS = {
  title: 80,
  what: 4000,
  runTitle: 100,
  /** Plan steps of each run (as a plan). */
  steps: 8,
  tz: 64,
  templateId: 40,
  /** Agents one Off doc names. */
  offAgents: 20,
  why: 300,
  /** Try later: at most this far ahead. */
  laterMs: 35 * 24 * 3_600_000,
} as const;

/** The rule as stored: only the keys it uses (checkRule decides the rest). */
export const scheduleRuleSchema = z
  .object({
    freq: z.enum(SCHEDULE_FREQS),
    at: z.string(),
    tz: z.string().max(SCHEDULE_LIMITS.tz).optional(),
    date: z.string().optional(),
    weekdays: z.array(z.number().int()).max(7).optional(),
    monthDay: z.number().int().optional(),
    month: z.number().int().optional(),
    weekend: z.enum(['keep', 'before', 'after']).optional(),
    until: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const e of checkRule(r as ScheduleRule)) ctx.addIssue({ code: 'custom', message: e });
  });

/** One step of each run's plan: a plan type and its fields (placeholders allowed in texts). */
export const scheduleStepSchema = z.object({
  type: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.boolean()])),
});
export type ScheduleStep = z.infer<typeof scheduleStepSchema>;

const by = z.object({ type: z.enum(['human', 'agent']), id: z.string() });

export const scheduleSchema = z.object({
  memberUid: z.string(),
  /** The home agent: every run's thread is its own. */
  agentUid: z.string(),
  title: z.string().min(1).max(SCHEDULE_LIMITS.title),
  /** The instruction: the run's first message. */
  what: z.string().min(1).max(SCHEDULE_LIMITS.what),
  rule: scheduleRuleSchema,
  /** The run thread's title, with placeholders ({period}, {month}, …). */
  runTitle: z.string().min(1).max(SCHEDULE_LIMITS.runTitle),
  steps: z.array(scheduleStepSchema).min(1).max(SCHEDULE_LIMITS.steps),
  templateId: z.string().max(SCHEDULE_LIMITS.templateId).nullable(),
  /** The subject its run threads are filed under (none yet: the agent files the first). */
  subjectId: z.string().nullable(),
  state: z.enum(SCHEDULE_STATES),
  /** Approval, resume or last rule change: no occurrence before it ever fires. Null while proposed. */
  activeFrom: timestamp.nullable(),
  /** Where the agent proposed it (null: the member made it). */
  proposal: z.object({ threadId: z.string(), outcomeId: z.string(), by: z.string() }).nullable(),
  /** A proposed change of this active schedule (its id): approving it rewrites that one. */
  replaces: z.string().nullable(),
  /** +1 per write (the runs record the version that fired them). */
  version: z.number().int().min(1),
  createdBy: by,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type Schedule = z.infer<typeof scheduleSchema>;
/** What the actions need of a schedule (a listener's data). */
export type ScheduleOf = Pick<
  Schedule,
  | 'memberUid'
  | 'agentUid'
  | 'title'
  | 'what'
  | 'runTitle'
  | 'steps'
  | 'templateId'
  | 'subjectId'
  | 'state'
  | 'proposal'
  | 'replaces'
  | 'version'
> & { rule: ScheduleRule };

export const scheduleRunSchema = z.object({
  memberUid: z.string(),
  scheduleId: z.string(),
  agentUid: z.string(),
  /** The period key (./schedules.ts runKey): one run per period. */
  key: z.string(),
  /** The period label, e.g. 'Nov 2026'. */
  period: z.string(),
  dueAt: timestamp,
  title: z.string(),
  state: z.enum(RUN_STATES),
  why: z.object({ code: z.enum(RUN_WHY), text: z.string().max(SCHEDULE_LIMITS.why) }).nullable(),
  threadId: z.string().nullable(),
  attempts: z.number().int().min(0),
  laterAt: timestamp.nullable(),
  firedAt: timestamp.nullable(),
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  /** The can't-run ask: its urgency level, how many sent, first and last (claimed before sending). */
  ask: z
    .object({ level: z.string(), n: z.number().int(), firstAt: timestamp, lastAt: timestamp })
    .nullable(),
  decision: z
    .object({
      choice: z.enum(RUN_CHOICES),
      by: z.string(),
      at: timestamp,
      via: z.enum(['web', 'telegram']),
    })
    .nullable(),
  scheduleVersion: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;
export type ScheduleRunOf = Pick<ScheduleRun, 'memberUid' | 'scheduleId' | 'state'> & {
  threadId?: string | null;
};

/** The member's Off switch in one org: all agents, or the ones listed. */
export const agentsOffSchema = z.object({
  all: z.boolean(),
  agents: z.array(z.string()).max(SCHEDULE_LIMITS.offAgents),
  /** When this Off began (null: all on). */
  since: timestamp.nullable(),
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type AgentsOff = z.infer<typeof agentsOffSchema>;

export const schedulePaths = {
  schedule: (w: string, s: string) => `workspaces/${w}/schedules/${s}`,
  run: (w: string, r: string) => `workspaces/${w}/scheduleRuns/${r}`,
  off: (w: string, uid: string) => `workspaces/${w}/agentsOff/${uid}`,
} as const;

/** The run's id: one per schedule and period, so a second fire of the same period is refused. */
export const runDocId = (scheduleId: string, key: string) => `${scheduleId}_${key}`;
/**
 * The key a run thread's id is hashed from (the notifier: `ts` + the first 24 hex digits of its
 * SHA-256, like inbox ids), so the run and its thread are derived from the same pair.
 */
export const runThreadKey = (scheduleId: string, key: string) => `${scheduleId}\u0000${key}`;
/** Deleting a schedule is tracked by an event at this fixed id (rules: trackedDelete). */
export const scheduleDeleteEventId = (scheduleId: string) => `del-schedule-${scheduleId}`;

/** Whether the Off doc silences this agent. */
export function isOffFor(off: Pick<AgentsOff, 'all' | 'agents'> | null, agentUid: string): boolean {
  return !!off && (off.all || off.agents.includes(agentUid));
}

/**
 * The schedule writes of approving its `schedule` outcome (approveOutcome, one batch): a new
 * schedule turns active from now; a change (`replaces`) rewrites the active one from now and the
 * proposal doc goes (that batch's event is `scheduleDeleteEventId(proposal id)`).
 */
export function scheduleApprovalOps(
  workspaceId: string,
  input: {
    scheduleId: string;
    schedule: ScheduleOf;
    /** The active schedule a change replaces (its version). */
    replaced?: { version: number } | null;
    eventId: string;
  },
): WriteOp[] {
  const s = input.schedule;
  const stamp = { updatedAt: SERVER_TIME, lastEventId: input.eventId };
  if (!s.replaces)
    return [
      {
        kind: 'update',
        path: schedulePaths.schedule(workspaceId, input.scheduleId),
        data: { state: 'active', activeFrom: SERVER_TIME, version: s.version + 1, ...stamp },
      },
    ];
  return [
    {
      kind: 'update',
      path: schedulePaths.schedule(workspaceId, s.replaces),
      data: {
        title: s.title,
        what: s.what,
        rule: s.rule,
        runTitle: s.runTitle,
        steps: s.steps,
        templateId: s.templateId,
        // A change that names no subject keeps the active schedule's.
        ...(s.subjectId !== null ? { subjectId: s.subjectId } : {}),
        activeFrom: SERVER_TIME,
        version: (input.replaced?.version ?? 0) + 1,
        ...stamp,
      },
    },
    { kind: 'delete', path: schedulePaths.schedule(workspaceId, input.scheduleId) },
  ];
}

/** Ending a schedule: state ended (no future runs; the schedule and its past runs stay). */
export function scheduleEndOps(
  workspaceId: string,
  input: { scheduleId: string; schedule: ScheduleOf; eventId: string },
): WriteOp[] {
  return [
    {
      kind: 'update',
      path: schedulePaths.schedule(workspaceId, input.scheduleId),
      data: {
        state: 'ended',
        version: input.schedule.version + 1,
        updatedAt: SERVER_TIME,
        lastEventId: input.eventId,
      },
    },
  ];
}

/** Other schedules a merge ends (the `ends` field of a `schedule` outcome). */
export const MAX_SCHEDULE_ENDS = 8;
export function scheduleEnds(fields: Readonly<Record<string, unknown>>): string[] {
  const v = fields.ends;
  return typeof v === 'string'
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}
