import { converters } from '@hive/shared/firestore';
import { paths, type OpenRun } from '@hive/shared';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../lib/db';

/**
 * The runs of an agent that are still open, for the revoke batch to end (tester finding: a run cut
 * off by revoke stayed "running" forever). Best effort: on a read error the revoke still goes on.
 */
export async function openRunsOf(workspaceId: string, agentUid: string): Promise<OpenRun[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, `workspaces/${workspaceId}/runs`).withConverter(converters.run),
        where('agentUid', '==', agentUid),
        where('endedAt', '==', null),
      ),
    );
    return await Promise.all(
      snap.docs.map(async (d) => {
        const r = d.data();
        const item = await getDoc(
          doc(db, paths.item(workspaceId, r.projectId, r.itemId)).withConverter(converters.item),
        ).catch(() => null);
        return {
          runId: d.id,
          projectId: r.projectId,
          itemId: r.itemId,
          holdsItem: item?.data()?.claim?.runId === d.id,
        };
      }),
    );
  } catch {
    return [];
  }
}
