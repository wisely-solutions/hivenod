import { ActionError } from '@hive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { haptic } from '../lib/mobile';
import { useToast } from '../ui/overlay';
import { decisionProblem, prepareDecision, type Decision } from './decision';
import type { InboxEntry } from './logic';
import { stash } from '../lib/pendingDecisions';
import { setPending } from './pending';

/**
 * The decide flow (SPEC section 7, signature interaction 1): the row leaves the inbox at once and
 * an Undo toast counts down 5 s. The write is committed when the toast ends, or when the person
 * leaves the screen. Offline, the commit is queued by Firestore's local cache. Returns a problem
 * in plain words when the input is not valid (so the dialog can show it), or null when queued.
 */
/** How long a finally-approved item stays on screen with its Done panel before Needs you moves on. */
export const DONE_HOLD_MS = 3500;
/** The Released toast closes this long before Needs you moves on (its exit animation). */
const TOAST_EXIT_MS = 350;

/** A final approval being shown: counting down (Releasing) or just released (Done). */
export interface Held {
  entry: InboxEntry;
  phase: 'releasing' | 'done';
  /** Needs you is moving on: the entry goes as soon as the next selection is on screen. */
  leaving?: boolean;
}

/** What the person is told when a decision is saved after a reload. */
function savedMessage(entry: InboxEntry, d: Decision): string {
  const what =
    d.kind === 'approve'
      ? 'approval'
      : d.kind === 'reject'
        ? 'rejection'
        : d.kind === 'answer'
          ? 'answer'
          : 'decision';
  return `Saved your ${what} of \u201c${entry.item.title}\u201d`;
}

/** "3 approved, 1 had already moved". */
export function batchMessage(done: number, verb: 'approved' | 'rejected', moved: number): string {
  if (done === 0) return moved ? `Nothing ${verb}: ${moved} had already moved` : `Nothing ${verb}`;
  return `${done} ${verb}${moved ? `, ${moved} had already moved` : ''}`;
}

export function useDecide() {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [held, setHeld] = useState<Held | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(leaveTimer.current);
    },
    [],
  );
  /** Drop the held entry (the screen calls this once the next selection is rendered). */
  const release = useCallback(() => {
    clearTimeout(leaveTimer.current);
    setHeld(null);
  }, []);
  const toasts = useRef(new Map<string, number>());
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  });

  const show = useCallback((key: string, on: boolean) => {
    setPending(key, on);
    setHidden((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const decide = useCallback(
    (
      entry: InboxEntry,
      d: Decision,
      onRestored?: () => void,
      onMoveOn?: () => void,
    ): string | null => {
      const ctx = actionContext(session.workspaceId);
      if (!ctx) return 'You are signed out.';
      let prepared;
      try {
        prepared = prepareDecision(ctx, entry, d);
      } catch (e) {
        if (e instanceof ActionError) return e.message;
        throw e;
      }
      // Approve and Reject (card eLSSIGOs) count down on their own button, with the entry still in
      // place; every other decision leaves at once and shows an Undo toast, as before.
      const inline = d.kind === 'approve' || d.kind === 'reject';
      if (!inline) show(entry.key, true);
      const forget = stash(
        session.me.uid,
        session.workspaceId,
        [prepared.plan.ops],
        savedMessage(entry, d),
      );
      const final = !!prepared.pending;
      haptic('decide');
      const settled = () => {
        forget();
        show(entry.key, false);
        if (final) {
          clearTimeout(holdTimer.current);
          setHeld(null);
        }
      };
      const id = toast.push({
        message: prepared.pending ?? prepared.message,
        undoLabel: 'Undo',
        duration: 5000,
        countdown: inline
          ? {
              key: entry.key,
              tag: d.kind,
              announce: `${d.kind === 'approve' ? 'Approved' : 'Rejected'}. Undo available for 5 seconds`,
            }
          : undefined,
        onUndo: () => {
          forget();
          toasts.current.delete(entry.key);
          show(entry.key, false);
          onRestored?.();
        },
        onCommit: () => {
          toasts.current.delete(entry.key);
          if (inline) show(entry.key, true);
          if (final) {
            // Released shows at once, together with the Done panel (not when the server answers).
            clearTimeout(holdTimer.current);
            const releasedToast = toast.push({ message: prepared.message });
            setHeld({ entry, phase: 'done' });
            // The Released toast closes just before the move (its exit animation finishes first),
            // so it never sits over the next item's bar. The held entry stays until the next item
            // is selected (or 300 ms), so the pane never shows the old item's heading beside the
            // new selection.
            holdTimer.current = setTimeout(() => {
              toastRef.current.dismiss(releasedToast);
              holdTimer.current = setTimeout(() => {
                setHeld((h) => (h ? { ...h, leaving: true } : h));
                leaveTimer.current = setTimeout(() => setHeld(null), 300);
                onMoveOn?.();
              }, TOAST_EXIT_MS);
            }, DONE_HOLD_MS - TOAST_EXIT_MS);
          } else if (inline) {
            onMoveOn?.();
          }
          run(prepared.plan).then(
            () => {
              forget();
              show(entry.key, false);
            },
            () => {
              settled();
              toast.push({ message: 'Could not save that decision. It is back in your inbox.' });
            },
          );
        },
      });
      toasts.current.set(entry.key, id);
      return null;
    },
    [actionContext, run, session.me.uid, session.workspaceId, show, toast],
  );

  /**
   * Approve or reject several entries with ONE Undo on the pressed button (Needs you selection). Entries whose
   * decision can no longer be prepared (someone else decided meanwhile) are skipped and counted.
   * `gone` is the number of selected entries that already left the inbox. Returns a problem in
   * plain words (so the dialog can show it), or null when queued.
   */
  const decideMany = useCallback(
    (
      entries: readonly InboxEntry[],
      d: Extract<Decision, { kind: 'approve' | 'reject' }>,
      gone: number,
      onCommitted?: () => void,
    ): string | null => {
      const ctx = actionContext(session.workspaceId);
      if (!ctx) return 'You are signed out.';
      const problem = decisionProblem(d);
      if (problem) return problem;
      const ready: { entry: InboxEntry; prepared: ReturnType<typeof prepareDecision> }[] = [];
      let moved = gone;
      for (const entry of entries) {
        try {
          ready.push({ entry, prepared: prepareDecision(ctx, entry, d) });
        } catch (e) {
          if (!(e instanceof ActionError)) throw e;
          moved += 1;
        }
      }
      const verb = d.kind === 'approve' ? 'approved' : 'rejected';
      const message = batchMessage(ready.length, verb, moved);
      if (ready.length === 0) {
        toast.push({ message });
        return null;
      }
      const keys = ready.map((r) => r.entry.key);
      const forget = stash(
        session.me.uid,
        session.workspaceId,
        ready.map((r) => r.prepared.plan.ops),
        `Saved your ${verb === 'approved' ? 'approvals' : 'rejections'} of ${ready.length} items`,
      );
      haptic('decide');
      const batchKey = `batch:${keys.join('+')}`;
      const done = () => {
        toasts.current.delete(batchKey);
        for (const k of keys) show(k, false);
      };
      // The rows stay while the pressed button counts down (card eLSSIGOs); they leave when it ends.
      const id = toast.push({
        message,
        undoLabel: 'Undo',
        duration: 5000,
        countdown: {
          key: batchKey,
          tag: `batch-${d.kind}`,
          announce: `${message}. Undo available for 5 seconds`,
        },
        onUndo: () => {
          forget();
          toasts.current.delete(batchKey);
        },
        onCommit: () => {
          toasts.current.delete(batchKey);
          for (const k of keys) show(k, true);
          onCommitted?.();
          // News that is not your own click: some had already moved on, so fewer were decided.
          if (moved > 0) toast.push({ message });
          void Promise.allSettled(ready.map((r) => run(r.prepared.plan))).then((res) => {
            forget();
            done();
            const failed = res.filter((r) => r.status === 'rejected').length;
            if (failed > 0)
              toast.push({
                message: `Could not save ${failed} of ${ready.length} decisions. They are back in your inbox.`,
              });
          });
        },
      });
      toasts.current.set(batchKey, id);
      return null;
    },
    [actionContext, run, session.me.uid, session.workspaceId, show, toast],
  );

  // Leaving the screen commits what is still counting down.
  useEffect(() => {
    const pending = toasts.current;
    return () => {
      for (const id of [...pending.values()]) toastRef.current.dismiss(id);
    };
  }, []);

  return { hidden, decide, decideMany, held, release };
}
