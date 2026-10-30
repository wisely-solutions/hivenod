/**
 * Firestore side of the Their reply reminders (./remind.ts). Admin writes skip the rules, so the
 * one write checks first, in a transaction, that the step still waits on the same message.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { RemindPorts } from './remind';

/** Node timers take at most ~24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function firestoreRemindPorts(db: Firestore, log: (s: string) => void): RemindPorts {
  return {
    now: () => Date.now(),
    setTimer: (fn, delay) => setTimeout(fn, Math.min(delay, MAX_TIMER_MS)),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log,
    fire: (s) =>
      db.runTransaction(async (tx) => {
        const ref = db.doc(`workspaces/${s.wid}/inboxOutcomes/${s.oid}`);
        const x = (await tx.get(ref)).data();
        const ask = (x?.ext as { ask?: { n?: unknown; state?: unknown } } | undefined)?.ask;
        if (
          !x ||
          x.type !== 'their_reply' ||
          x.state !== 'running' ||
          ask?.state !== 'sent' ||
          Number(ask.n) !== s.n ||
          Number(x.remindDue ?? 0) >= s.n
        )
          return false;
        tx.update(ref, { remindDue: s.n });
        return true;
      }),
  };
}
