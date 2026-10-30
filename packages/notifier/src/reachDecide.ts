/**
 * The buttons of a silent message (item KZ6O9): Ping again, Release to queue, Stop. The same
 * ActionPlans the app builds, applied with the Admin SDK; every check the rules would make is
 * made here first (Admin writes skip the rules): the item is still held by the same run, the person
 * is on the project, and only those who may stop work may release or stop it.
 */
import {
  ActionError,
  itemSchema,
  messageDoc,
  paths,
  pingAgent,
  projectSchema,
  releaseStale,
  STATUS_ASK_EVERY_MS,
  stopGateFor,
  stopWork,
  type Item,
  type Project,
} from '@hive/shared';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { applyPlanAdmin } from './admin';
import type { DecideResult } from './decide';
import type { ReachTelegram } from './engine';

export type ReachChoice = 'ping' | 'release' | 'stop';

const ms = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;

export async function decideReach(
  db: Firestore,
  a: ReachTelegram,
  choice: ReachChoice,
  nowMs: number,
): Promise<DecideResult> {
  const ref = a.ref;
  if (ref.kind === 'step') {
    if (choice !== 'ping') return { ok: false, text: 'Only Ping again works on a thread step.' };
    const doc = db.doc(`workspaces/${ref.wid}/inboxOutcomes/${ref.oid}`);
    const o = (await doc.get()).data();
    if (!o || !['approved', 'running'].includes(String(o.state)))
      return { ok: false, text: 'This step is no longer in the agent’s hands.' };
    if (o.memberUid !== a.uid) return { ok: false, text: 'This thread is not yours.' };
    if (nowMs - ms((o.statusAsk as { at?: unknown } | null)?.at) < STATUS_ASK_EVERY_MS)
      return { ok: false, text: 'A status was asked for less than 2 minutes ago.' };
    await doc.update({ statusAsk: { byUid: a.uid, at: FieldValue.serverTimestamp() } });
    return { ok: true, text: 'Asked the agent for a status again.' };
  }
  const [pSnap, iSnap, mSnap, wSnap] = await Promise.all([
    db.doc(paths.project(ref.wid, ref.pid)).get(),
    db.doc(paths.item(ref.wid, ref.pid, ref.iid)).get(),
    db.doc(paths.member(ref.wid, a.uid)).get(),
    db.doc(paths.workspace(ref.wid)).get(),
  ]);
  const pr = pSnap.exists ? projectSchema.safeParse(pSnap.data()) : null;
  const it = iSnap.exists ? itemSchema.safeParse(iSnap.data()) : null;
  if (!pr?.success || !it?.success)
    return { ok: false, text: 'I could not find that item any more.' };
  const project = pr.data as Project;
  const item = it.data as Item;
  const role = (wSnap.data()?.memberRoles as Record<string, string> | undefined)?.[a.uid];
  if (!role) return { ok: false, text: 'You are no longer in this organization.' };
  const isAdmin = role === 'admin';
  if (!isAdmin && !project.memberUids.includes(a.uid))
    return { ok: false, text: 'You are no longer on this project.' };
  if (item.status !== 'working' || item.claim?.runId !== ref.runId)
    return { ok: false, text: 'This item has moved on since the message was sent.' };
  const name = (mSnap.data()?.name as string | undefined) ?? 'Someone';
  const ctx = {
    workspaceId: ref.wid,
    actor: { type: 'human' as const, id: a.uid, name },
    via: 'telegram' as const,
  };
  const claim = item.claim;
  const agent = item.silence?.agent || 'The agent';
  try {
    if (choice === 'ping') {
      await applyPlanAdmin(
        db,
        pingAgent(ctx, { projectId: ref.pid, itemId: ref.iid, item, nowMs }),
      );
      return { ok: true, text: `Asked ${agent} for a status again: ${item.title}` };
    }
    const gate = stopGateFor(project, a.uid, isAdmin);
    if (gate === null)
      return {
        ok: false,
        text: 'Only admins and the people who decide in this project can do that.',
      };
    if (choice === 'release') {
      const p = releaseStale(ctx, {
        projectId: ref.pid,
        itemId: ref.iid,
        runId: claim.runId,
        agentUid: claim.agentUid,
      });
      await applyPlanAdmin(db, {
        ops: [
          ...p.ops,
          {
            kind: 'set',
            path: paths.message(ref.wid, ref.pid, ref.iid, `${p.eventId}-reach`),
            data: messageDoc(
              ctx,
              ref.pid,
              ref.iid,
              'note',
              `${name} put the item back in the queue from Telegram: ${agent} was silent.`,
              null,
              p.eventId,
            ),
          },
          { kind: 'update', path: paths.item(ref.wid, ref.pid, ref.iid), data: { silence: null } },
        ],
      });
      return { ok: true, text: `Back in the queue: ${item.title}` };
    }
    const run = (await db.doc(paths.run(ref.wid, claim.runId)).get()).data();
    const p = stopWork(ctx, {
      project,
      projectId: ref.pid,
      itemId: ref.iid,
      item,
      mode: 'back',
      reason: `${agent} was silent`,
      gateStepId: gate,
      run: run ? { costEur: Number(run.costEur ?? 0), endedAt: run.endedAt ?? null } : null,
    });
    await applyPlanAdmin(db, {
      ops: [
        ...p.ops,
        { kind: 'update', path: paths.item(ref.wid, ref.pid, ref.iid), data: { silence: null } },
      ],
    });
    return { ok: true, text: `Stopped, on hold: ${item.title}` };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, text: e.message };
    throw e;
  }
}
