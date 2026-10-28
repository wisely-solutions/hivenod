import { archiveProject, type Project } from '@hive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { stash } from '../lib/pendingDecisions';
import { useToast } from '../ui/overlay';

/**
 * Archiving with an Undo toast: the project vanishes from the list at once and the write happens
 * when the toast ends without an undo. Shared by the Projects list and Settings > Projects.
 */
export function useArchiveProject() {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<number>());
  // Projects still inside the Undo window: toast id and a way to cancel without writing.
  const waiting = useRef(new Map<string, { id: number; cancel: () => void }>());
  // The toast API changes identity every render, so unmount reads the latest one from a ref.
  const dismissRef = useRef(toast.dismiss);
  useEffect(() => {
    dismissRef.current = toast.dismiss;
  });
  useEffect(() => {
    const waiting = pending.current;
    return () => waiting.forEach((id) => dismissRef.current(id));
  }, []);

  const unhide = useCallback((pid: string) => {
    setHidden((h) => {
      const next = new Set(h);
      next.delete(pid);
      return next;
    });
  }, []);

  function archive(p: Row<Project>) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setHidden((h) => new Set(h).add(p.id));
    // Card 6wjRumCC: saved so a reload inside the Undo window still archives it (replayed on load).
    const archivePlan = archiveProject(ctx, { projectId: p.id, name: p.data.name });
    const forget = stash(
      session.me.uid,
      session.workspaceId,
      [archivePlan.ops],
      `Saved: ${p.data.name} archived`,
    );
    let cancelled = false;
    const id = toast.push({
      message: `${p.data.name} archived.`,
      undoLabel: 'Undo',
      onUndo: () => {
        pending.current.delete(id);
        waiting.current.delete(p.id);
        forget();
        unhide(p.id);
      },
      onCommit: () => {
        pending.current.delete(id);
        waiting.current.delete(p.id);
        if (cancelled) return;
        run(archivePlan).then(
          // Written: the live list now says archived (the local write is applied at once).
          () => {
            forget();
            unhide(p.id);
          },
          () => {
            forget();
            unhide(p.id);
            toast.push({ message: `Could not archive ${p.data.name}. It is back in the list.` });
          },
        );
      },
    });
    pending.current.add(id);
    waiting.current.set(p.id, {
      id,
      cancel: () => {
        cancelled = true;
        forget();
      },
    });
  }

  /** Restore during the Undo window: cancels the archive (nothing is written) and closes the toast. */
  function cancelArchive(pid: string): boolean {
    const w = waiting.current.get(pid);
    if (!w) return false;
    w.cancel();
    unhide(pid);
    toast.dismiss(w.id);
    return true;
  }

  return { hidden, archive, cancelArchive };
}
