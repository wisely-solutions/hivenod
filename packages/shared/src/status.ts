/**
 * Status checks on ongoing work (item AzveC).
 *
 *  - A project may ask the agent holding an actively worked item for a one-line status every
 *    `statusEvery` minutes (15, 30, 60; 0 = off, the default). The channel session keeps the
 *    clock and pushes a `status` event; the agent answers with the `status` tool (reportStatus),
 *    which replaces the previous status of the item.
 *  - A person may press "Ask for status" (askForStatus): the holder gets a status event at once.
 *    At most once per STATUS_ASK_EVERY_MS per item.
 *  - Silence is counted from the item's last activity: the claim, any log line of the run, any
 *    tool write by the holder (progress, note, attachment, status...). With none for the
 *    project's `silenceAfter` minutes (default 40), or SILENCE_GRACE_MS after a person asked, the
 *    notifier flags the item (`silence`) and tells its deciders once per silence.
 *
 * "Actively worked": claimed, working, not parked, not waiting for an answer, not stopped.
 */
import { nextOnPath } from './itempath';
import {
  ActionError,
  ownClaim,
  parkOf,
  plan,
  requireAgent,
  requireHuman,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type ItemState,
} from './actions';
import {
  DEFAULT_SILENCE_AFTER,
  DEFAULT_STATUS_EVERY,
  MAX_STATUS_TEXT_CHARS,
  paths,
  SILENCE_AFTER_CHOICES,
  SILENCE_GRACE_MS,
  STATUS_ASK_EVERY_MS,
  STATUS_EVERY_CHOICES,
  type Item,
  type Project,
  type Silence,
  type SilenceAfter,
  type StatusAsk,
  type StatusEvery,
  type StatusUpdate,
} from './schema';

/** A status may not be reported more often than this (it would flood the history). */
export const STATUS_MIN_GAP_MS = 30_000;

/** The project's status interval in minutes (0 = off). */
export function statusEveryOf(project: { statusEvery?: number }): StatusEvery {
  const v = project.statusEvery;
  return v !== undefined && (STATUS_EVERY_CHOICES as readonly number[]).includes(v)
    ? (v as StatusEvery)
    : DEFAULT_STATUS_EVERY;
}

/** The project's silence threshold in minutes (0 = never flagged). */
export function silenceAfterOf(project: { silenceAfter?: number }): SilenceAfter {
  const v = project.silenceAfter;
  return v !== undefined && (SILENCE_AFTER_CHOICES as readonly number[]).includes(v)
    ? (v as SilenceAfter)
    : DEFAULT_SILENCE_AFTER;
}

type Claimed = Pick<ItemState, 'claim' | 'parked' | 'statusUpdate' | 'statusAsk'>;

/** The status in force on an item: only while the claim it was written under holds. */
export function statusOf(item: Claimed): StatusUpdate | null {
  const s = item.statusUpdate;
  return s && item.claim && item.claim.runId === s.runId ? s : null;
}

/** A person's open ask for a status on the current claim, or null. */
export function statusAskOf(item: Claimed): StatusAsk | null {
  const a = item.statusAsk;
  return a && item.claim && item.claim.runId === a.runId ? a : null;
}

/** Whether the ask on the current claim is still waiting for the agent's answer. */
export function statusAskOpen(item: Claimed): boolean {
  const a = statusAskOf(item);
  if (!a) return false;
  const s = statusOf(item);
  return !s || s.at.toMillis() < a.at.toMillis();
}

/** The silence flag in force (the notifier's), unless a status came after it (the notifier
 * clears it on any other activity). */
export function silenceOf(item: Claimed & { silence?: Silence | null }): Silence | null {
  const f = item.silence;
  if (!f || !item.claim || item.claim.runId !== f.runId) return null;
  const s = statusOf(item);
  if (s && s.at.toMillis() > f.since) return null;
  return f;
}

/** Claimed, working, not parked, not waiting for an answer and not stopped. */
export function activelyWorked(
  item: Pick<ItemState, 'status' | 'claim' | 'parked' | 'awaitingAnswer' | 'workStopped'>,
): boolean {
  return (
    item.status === 'working' &&
    !!item.claim &&
    !parkOf(item) &&
    !item.awaitingAnswer &&
    !item.workStopped
  );
}

/** "Running release checks · 70%". */
export function statusLine(s: Pick<StatusUpdate, 'text' | 'pct'>): string {
  return s.pct === null || s.pct === undefined ? s.text : `${s.text} · ${s.pct}%`;
}

const utf16Len = (s: string) => s.length;

/**
 * Agent: the one-line status of the item it holds, with an optional percentage. It replaces the
 * previous one. A repeat of the same line is marked `repeat` in the event (the history folds it).
 */
export function reportStatus(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState; text: string; pct?: number | null },
): ActionPlan {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const text = input.text.trim().replace(/\s+/g, ' ');
  if (!text) throw new ActionError('Say in one line where the work stands');
  if (utf16Len(text) > MAX_STATUS_TEXT_CHARS)
    throw new ActionError(`Keep the status under ${MAX_STATUS_TEXT_CHARS} characters`);
  const pct = input.pct ?? null;
  if (pct !== null && (!Number.isInteger(pct) || pct < 0 || pct > 100))
    throw new ActionError('The percentage is a whole number from 0 to 100');
  const prev = statusOf(input.item);
  if (prev && Date.now() - prev.at.toMillis() < STATUS_MIN_GAP_MS)
    throw new ActionError(
      'You reported a status on this item less than 30 seconds ago (the limit is per item): wait a little before the next one',
    );
  const repeat = !!prev && prev.text === text && (prev.pct ?? null) === pct;
  const statusUpdate = { runId: claim.runId, text, pct, at: SERVER_TIME, by: ctx.actor.id };
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    { status: { text, pct }, ...(repeat ? { repeat: true } : {}) },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { statusUpdate, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/**
 * Person: "Ask for status" on an item being actively worked. The holder's session sends it a
 * status event at once. At most once per STATUS_ASK_EVERY_MS per item.
 */
export function askForStatus(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    item: ItemState;
    /** The current time (ms; the server's when known). */
    nowMs: number;
  },
): ActionPlan {
  requireHuman(ctx);
  if (!activelyWorked(input.item) || !input.item.claim)
    throw new ActionError(
      'Only an item an agent is working on right now can be asked for a status',
    );
  const prev = statusAskOf(input.item);
  if (prev && input.nowMs - prev.at.toMillis() < STATUS_ASK_EVERY_MS)
    throw new ActionError('A status was asked for less than 2 minutes ago');
  const statusAsk = { runId: input.item.claim.runId, byUid: ctx.actor.id, at: SERVER_TIME };
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId },
    { statusAsk: true },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { statusAsk, lastEventId: eventId },
      },
    ],
  );
}

/** Admins and the project's creator: how often agents are asked for a status (0 = never). */
export function setStatusEvery(
  ctx: ActionContext,
  input: { projectId: string; every: StatusEvery },
): ActionPlan {
  requireHuman(ctx);
  if (!STATUS_EVERY_CHOICES.includes(input.every))
    throw new ActionError('Ask for a status every 15, 30 or 60 minutes, or never');
  return plan(
    ctx,
    'project.updated',
    { projectId: input.projectId },
    { statusEvery: input.every },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { statusEvery: input.every, lastEventId: eventId },
      },
    ],
  );
}

/** Admins and the project's creator: after how many minutes without activity an item is flagged. */
export function setSilenceAfter(
  ctx: ActionContext,
  input: { projectId: string; after: SilenceAfter },
): ActionPlan {
  requireHuman(ctx);
  if (!SILENCE_AFTER_CHOICES.includes(input.after))
    throw new ActionError('Flag silence after 20, 40, 60 or 120 minutes, or never');
  return plan(
    ctx,
    'project.updated',
    { projectId: input.projectId },
    { silenceAfter: input.after },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { silenceAfter: input.after, lastEventId: eventId },
      },
    ],
  );
}

/**
 * The notifier's silence check: whether an item is silent now, and since when (ms: its last
 * activity on this claim). Null when it is not silent. `startedMs` is the run's start (the claim
 * time); `activityMs` the latest log line or tool write of the holder on this run, when known
 * (null: none, or not looked up yet; an upper bound, so the notifier only looks it up when the
 * item would otherwise be silent).
 */
export function silenceDue(input: {
  item: Pick<
    Item,
    'status' | 'claim' | 'parked' | 'awaitingAnswer' | 'workStopped' | 'statusUpdate' | 'statusAsk'
  >;
  project: { silenceAfter?: number };
  startedMs: number;
  activityMs: number | null;
  nowMs: number;
}): { runId: string; since: number; asked: boolean } | null {
  const { item, nowMs } = input;
  if (!activelyWorked(item) || !item.claim) return null;
  const since = Math.max(
    input.startedMs,
    statusOf(item)?.at.toMillis() ?? 0,
    input.activityMs ?? 0,
  );
  const after = silenceAfterOf(input.project);
  const quiet = after > 0 && nowMs > since + after * 60_000;
  const ask = statusAskOf(item);
  const asked = !!ask && ask.at.toMillis() > since && nowMs > ask.at.toMillis() + SILENCE_GRACE_MS;
  if (!quiet && !asked) return null;
  return { runId: item.claim.runId, since, asked: asked && !quiet };
}

/** "No update for 42 min" (or hours past two hours). */
export function silenceText(sinceMs: number, nowMs: number): string {
  const min = Math.max(1, Math.floor((nowMs - sinceMs) / 60_000));
  if (min < 120) return `No update for ${min} min`;
  return `No update for ${Math.floor(min / 60)} h`;
}

/**
 * Who is told when an item goes silent: the deciders of the next people step on its path, or the
 * project's creator when no people step follows.
 */
export function silenceDeciders(
  project: Pick<Project, 'steps' | 'createdBy'>,
  item: Parameters<typeof nextOnPath>[1],
): string[] {
  let s = nextOnPath(project, item);
  while (s && s.kind !== 'human') s = nextOnPath(project, item, s.id);
  const uids = s?.gate?.deciderUids ?? [];
  return uids.length ? [...uids] : [project.createdBy];
}
