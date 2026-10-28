import type { WriteOp } from '@hive/shared';
import { applyPlan } from '@hive/shared/firestore';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useRef } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { takeReplayable, type Stashed } from '../lib/pendingDecisions';
import { replayStashed } from '../lib/replay';
import { useToast } from '../ui/overlay';

/**
 * Card ZVS8ag5i: a decision still inside its 5 s Undo window when the page was reloaded, closed or
 * killed is written on the next load, and the person is told. Safe to repeat: a plan whose event
 * already exists has landed (skipped), and the rules refuse a decision on an item that moved on.
 */
export function useReplayPending(): void {
  const { session } = useReady();
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  });
  const uid = session.me.uid;
  const ws = session.workspaceId;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dead = false;
    const io = {
      exists: async (path: string) => (await getDoc(doc(db, path))).exists(),
      apply: async (ops: WriteOp[]) => {
        await applyPlan(db, { ops });
      },
    };
    const replay = async (s: Stashed) => {
      const r = await replayStashed(uid, ws, s, io);
      // Still unconfirmed (network, killed page): the entry stays and the next load tries again.
      if (r.kept > 0 && r.refused === 0 && r.saved === 0) return;
      if (r.refused > 0) {
        toastRef.current.push({
          message: `Could not save ${r.refused === s.plans.length ? 'your earlier decision' : `${r.refused} of your earlier decisions`}: the item had already changed.`,
        });
      } else if (r.kept === 0) {
        toastRef.current.push({ message: s.done });
      }
    };
    const tick = () => {
      if (dead) return;
      const { ready, again } = takeReplayable(uid, ws);
      for (const s of ready) void replay(s);
      if (again !== null) timer = setTimeout(tick, again + 50);
    };
    tick();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [uid, ws]);
}
