import { paths, workspaceSchema, type Role } from '@hive/shared';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/db';

export interface OrgRow {
  id: string;
  name: string;
  role: Role;
  members: number;
  /** An admin has started deleting it (card 9jpb1Q4a). */
  deleting: boolean;
}

/**
 * The organizations a person belongs to, live. Ids come from their profile; one they have since
 * been removed from (or that fails to load) is left out, so the list is always only real access.
 */
export function useOrgs(uid: string, ids: readonly string[]): OrgRow[] {
  const key = ids.join('|');
  const [rows, setRows] = useState<Record<string, OrgRow | null>>({});
  useEffect(() => {
    const list = key ? key.split('|') : [];
    const stops = list.map((id) =>
      onSnapshot(
        doc(db, paths.workspace(id)),
        (snap) => {
          const r = snap.exists() ? workspaceSchema.safeParse(snap.data()) : null;
          const role = r?.success ? r.data.memberRoles[uid] : undefined;
          setRows((cur) => ({
            ...cur,
            [id]:
              r?.success && role
                ? {
                    id,
                    name: r.data.name,
                    role,
                    members: Object.keys(r.data.memberRoles).length,
                    deleting: Boolean(r.data.deletingAt),
                  }
                : null,
          }));
        },
        () => setRows((cur) => ({ ...cur, [id]: null })),
      ),
    );
    return () => stops.forEach((s) => s());
  }, [key, uid]);
  return useMemo(
    () => (key ? key.split('|') : []).flatMap((id) => (rows[id] ? [rows[id]] : [])),
    [key, rows],
  );
}
