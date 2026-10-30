/**
 * Run now · Try later · Skip from Telegram (scheduled tasks, slice 4): the button carries a code
 * pointing at (org, run, member); the decision is the shared `decideRun` action, applied with the
 * Admin SDK. Admin writes skip the rules, so what they check is checked here first: the person is
 * the run's member, still in the organization, and the run still waits for a decision (else
 * "Decided at HH:MM (Skip)").
 */
import {
  ActionError,
  decideRun,
  laterChoices,
  localClock,
  localDate,
  memberTz,
  notifyPath,
  notifyPrefsSchema,
  paths,
  scheduleRunSchema,
  schedulePaths,
  type ActionContext,
  type RunChoice,
} from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { applyPlanAdmin } from './admin';

/** What a run button points at (telegramActions/{code}). */
export interface RunAction {
  kind: 'run';
  wid: string;
  runId: string;
  uid: string;
  title: string;
}

export type RunDecision =
  | { choice: 'runNow' }
  | { choice: 'skip' }
  | { choice: 'later'; at: 'hour' | 'tomorrow' }
  | { choice: 'later'; atMs: number };

export type RunResult = { ok: true; text: string } | { ok: false; text: string };

const CHOICE_WORD: Record<string, string> = { runNow: 'Run now', later: 'Try later', skip: 'Skip' };

/** The member's zone (their quiet-hours zone, else Lisbon). */
export async function memberZone(db: Firestore, uid: string): Promise<string> {
  const p = notifyPrefsSchema.safeParse((await db.doc(notifyPath.prefs(uid)).get()).data());
  return memberTz(p.success ? p.data : null);
}

function when(ms: number, nowMs: number, tz: string): string {
  const day =
    localDate(ms, tz) === localDate(nowMs, tz)
      ? 'today'
      : new Date(ms).toLocaleDateString('en-GB', {
          timeZone: tz,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });
  return `${day.replace(',', '')} at ${localClock(ms, tz)}`;
}

/** Why this button can't be used now, or null. */
export async function runWhyNot(db: Firestore, a: RunAction): Promise<string | null> {
  const [rSnap, mSnap] = await Promise.all([
    db.doc(schedulePaths.run(a.wid, a.runId)).get(),
    db.doc(paths.member(a.wid, a.uid)).get(),
  ]);
  const r = scheduleRunSchema.safeParse(rSnap.data());
  if (!r.success || !mSnap.exists) return 'I could not find that run any more.';
  if (r.data.memberUid !== a.uid) return 'You can no longer decide this one.';
  if (r.data.state !== 'cantRun') {
    const tz = await memberZone(db, a.uid);
    const d = r.data.decision;
    if (d)
      return `Decided at ${localClock(d.at.toMillis(), tz)} (${CHOICE_WORD[d.choice] ?? d.choice}).`;
    return 'This run no longer waits for a decision.';
  }
  return null;
}

export async function decideRunAction(
  db: Firestore,
  a: RunAction,
  d: RunDecision,
  nowMs: number,
): Promise<RunResult> {
  const why = await runWhyNot(db, a);
  if (why) return { ok: false, text: why };
  const [rSnap, mSnap, tz] = await Promise.all([
    db.doc(schedulePaths.run(a.wid, a.runId)).get(),
    db.doc(paths.member(a.wid, a.uid)).get(),
    memberZone(db, a.uid),
  ]);
  const run = scheduleRunSchema.parse(rSnap.data());
  const ctx: ActionContext = {
    workspaceId: a.wid,
    actor: { type: 'human', id: a.uid, name: (mSnap.data()?.name as string) ?? 'Someone' },
    via: 'telegram',
  };
  let laterAtMs: number | null = null;
  if (d.choice === 'later') {
    if ('atMs' in d) laterAtMs = d.atMs;
    else {
      const c = laterChoices(nowMs, tz);
      laterAtMs = d.at === 'hour' ? c.inHourMs : c.tomorrowMs;
    }
  }
  const choice: RunChoice = d.choice;
  try {
    await applyPlanAdmin(
      db,
      decideRun(ctx, {
        runId: a.runId,
        run,
        choice,
        laterAt: laterAtMs !== null ? new Date(laterAtMs) : null,
        nowMs,
      }),
    );
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, text: e.message };
    throw e;
  }
  const title = a.title || run.title;
  if (choice === 'runNow') return { ok: true, text: `Running “${title}” now.` };
  if (choice === 'skip') return { ok: true, text: `Skipped “${title}” for ${run.period}.` };
  return { ok: true, text: `I’ll try “${title}” again ${when(laterAtMs!, nowMs, tz)}.` };
}
