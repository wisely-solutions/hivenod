import { useMemo } from 'react';
import { useReady } from '../auth/context';
import { isPersonalOrg, orgColor } from './color';
import { useOrgs } from './data';

/** How an organization looks everywhere (item icVly): its colour and whether it is Personal. */
export interface OrgLook {
  color: string;
  personal: boolean;
}

/**
 * The colour of each of the member's organizations (the same in Inbox and Today) and which
 * one is their Personal organization. Before the list has loaded, the one on screen still gets its
 * colour from its name alone.
 */
export function useOrgLooks(): (wid: string) => OrgLook {
  const { session } = useReady();
  const uid = session.me.uid;
  const orgs = useOrgs(uid, session.profile.workspaceIds);
  return useMemo(() => {
    const here = {
      id: session.workspaceId,
      name: session.workspace.name,
      ownerUid: session.workspace.ownerUid,
      members: Object.keys(session.workspace.memberRoles).length,
    };
    const rows = orgs.some((o) => o.id === here.id) ? orgs : [...orgs, here];
    const colorOrgs = rows.map((o) => ({ wid: o.id, name: o.name }));
    return (wid: string) => {
      const o = rows.find((r) => r.id === wid);
      return {
        color: orgColor(wid, colorOrgs),
        personal: o ? isPersonalOrg(o, uid) : false,
      };
    };
  }, [orgs, session.workspaceId, session.workspace, uid]);
}
