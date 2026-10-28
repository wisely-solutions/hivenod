import {
  groupSchema,
  inviteSchema,
  memberProfileSchema,
  type Group,
  type Invite,
  type MemberProfile,
} from '@hive/shared';
import { useMemo } from 'react';
import { useLiveCollection, type Live, type Row } from '../lib/live';

export function useGroups(wid: string): Live<Row<Group>[]> {
  const live = useLiveCollection(`workspaces/${wid}/groups`, groupSchema);
  return useMemo(
    () =>
      live.state === 'ready'
        ? {
            state: 'ready',
            data: [...live.data].sort((a, b) => a.data.name.localeCompare(b.data.name)),
          }
        : live,
    [live],
  );
}

export function useInvites(wid: string, enabled: boolean): Live<Row<Invite>[]> {
  return useLiveCollection(enabled ? `workspaces/${wid}/invites` : null, inviteSchema);
}

/**
 * The name and picture of each person, from the member cards of this organization
 * (`workspaces/{wid}/members/{uid}`). A person without a card shows as unknown.
 */
export function useProfiles(
  wid: string,
  uids: readonly string[],
): Record<string, MemberProfile | null> {
  const live = useLiveCollection(`workspaces/${wid}/members`, memberProfileSchema);
  return useMemo(() => {
    const byId = new Map(
      live.state === 'ready' ? live.data.map((r) => [r.id, r.data] as const) : [],
    );
    return Object.fromEntries(uids.map((uid) => [uid, byId.get(uid) ?? null]));
  }, [live, uids]);
}

export function displayName(profile: MemberProfile | null | undefined, uid: string): string {
  return profile?.name || profile?.email || `Member ${uid.slice(0, 4)}`;
}
