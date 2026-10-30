/**
 * The button of a silent message (item KZ6O9): Ping again on a thread step. Admin writes skip the
 * rules, so every check is made here first: the step is still in the agent's hands, the person is
 * the thread's member, and no status was asked in the last STATUS_ASK_EVERY_MS.
 */
import { STATUS_ASK_EVERY_MS } from '@hive/shared';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { ReachTelegram } from './engine';

export interface ReachResult {
  ok: boolean;
  text: string;
}

const ms = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;

export async function decideReach(
  db: Firestore,
  a: ReachTelegram,
  nowMs: number,
): Promise<ReachResult> {
  const ref = a.ref;
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
