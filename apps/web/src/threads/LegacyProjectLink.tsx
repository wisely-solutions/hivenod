import { Navigate } from '@tanstack/react-router';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useReady } from '../auth/context';
import { LoadingMark } from '../components/Loading';
import { db } from '../lib/db';
import { migratedThreadId, orgsToTry } from './legacyLink';

type Target = { wid: string; tid: string } | 'inbox' | null;

/**
 * An old project or item link (Projects were removed, item OE8FmrTaIxFVGcaeGG3N slice 10): an item
 * that was moved to Inbox opens its thread, anything else opens Inbox.
 */
export function LegacyProjectLink({ pid, iid }: { pid: string; iid?: string }) {
  const { session } = useReady();
  const [target, setTarget] = useState<Target>(iid ? null : 'inbox');
  useEffect(() => {
    if (!iid) return;
    let gone = false;
    void (async () => {
      for (const wid of orgsToTry(session.workspaceId, session.profile.workspaceIds)) {
        try {
          const tid = await migratedThreadId(wid, pid, iid);
          const snap = await getDoc(doc(db, `workspaces/${wid}/inboxThreads/${tid}`));
          if (snap.exists()) {
            if (!gone) setTarget({ wid, tid });
            return;
          }
        } catch {
          // Not this organization's (or not this person's): try the next.
        }
      }
      if (!gone) setTarget('inbox');
    })();
    return () => {
      gone = true;
    };
  }, [pid, iid, session.workspaceId, session.profile.workspaceIds]);
  if (target === null) return <LoadingMark />;
  if (target === 'inbox') return <Navigate to="/inbox" replace />;
  return (
    <Navigate
      to="/inbox/$wid/t/$tid"
      params={{ wid: target.wid, tid: target.tid }}
      search={{}}
      replace
    />
  );
}
