import { removeMember, revokeInvite, setMemberRole, type Role } from '@hive/shared';
import { Link2, UserMinus, UserPlus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { PersonAvatar } from '../components/PersonAvatar';
import { CopyButton, InviteModal, inviteUrl } from '../members/InviteModal';
import { displayName, useGroups, useInvites, useProfiles } from '../members/data';
import { removeFromGroupsFlow } from '../members/groupFlow';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { cn } from '../ui/cn';
import { Select } from '../ui/form';
import { Icon } from '../ui/icon';
import { Dialog, useToast } from '../ui/overlay';
import { PageHeader } from './Chrome';

function RoleSelect({
  name,
  value,
  onChange,
  lastAdmin,
}: {
  name: string;
  value: Role;
  onChange: (r: Role) => void;
  /** The only admin cannot be demoted: the organization always keeps one. */
  lastAdmin: boolean;
}) {
  return (
    <Select
      hideLabel
      inline
      label={`Role for ${name}`}
      value={value}
      disabled={lastAdmin}
      title={lastAdmin ? 'An organization always keeps at least one admin' : undefined}
      onValueChange={(r) => onChange(r as Role)}
      options={[
        { value: 'member', label: 'Member' },
        { value: 'admin', label: 'Admin' },
      ]}
    />
  );
}

export function MembersPage() {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const { workspace, workspaceId, isAdmin, me } = session;
  const uids = useMemo(() => Object.keys(workspace.memberRoles), [workspace.memberRoles]);
  const profiles = useProfiles(workspaceId, uids);
  const adminUids = useMemo(
    () => uids.filter((u) => workspace.memberRoles[u] === 'admin'),
    [uids, workspace.memberRoles],
  );
  const groups = useGroups(workspaceId);
  const invites = useInvites(workspaceId, isAdmin);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());

  const ctx = actionContext(workspaceId);
  const fail = (message: string) => toast.push({ message });

  const rows = uids
    .map((uid) => ({ uid, role: workspace.memberRoles[uid]!, profile: profiles[uid] }))
    .sort(
      (a, b) =>
        Number(b.role === 'admin') - Number(a.role === 'admin') ||
        displayName(a.profile, a.uid).localeCompare(displayName(b.profile, b.uid)),
    );

  const pending =
    invites.state === 'ready'
      ? invites.data
          .filter((i) => i.data.usedBy === null)
          .sort((a, b) => a.data.expiresAt.toMillis() - b.data.expiresAt.toMillis())
      : [];

  async function changeRole(uid: string, role: Role) {
    if (!ctx) return;
    try {
      await run(setMemberRole(ctx, { uid, role, adminUids }));
    } catch {
      fail('Could not change the role.');
    }
  }

  async function confirmRemove() {
    const uid = removing;
    if (!uid || !ctx) return;
    setBusy(true);
    try {
      await run(removeMember(ctx, { uid, adminUids }));
      if (groups.state === 'ready') {
        await removeFromGroupsFlow({ run, ctx, groups: groups.data, uid });
      }
      setRemoving(null);
    } catch {
      fail('Could not remove them. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    if (!ctx) return;
    try {
      await run(revokeInvite(ctx, { code }));
    } catch {
      fail('Could not revoke the invite.');
    }
  }

  const removingProfile = removing ? profiles[removing] : null;

  return (
    <>
      <PageHeader
        title="Members"
        section
        subtitle={`${rows.length} ${rows.length === 1 ? 'person' : 'people'} in ${workspace.name}`}
        action={
          isAdmin ? (
            <Button leading={<Icon icon={UserPlus} />} onClick={() => setInviting(true)}>
              Invite
            </Button>
          ) : null
        }
      />

      <ul
        className="overflow-hidden rounded-card border border-line bg-surface shadow-e1"
        aria-label="Members"
      >
        {rows.map(({ uid, role, profile }, i) => {
          const name = displayName(profile, uid);
          const isMe = uid === me.uid;
          const lastAdmin = role === 'admin' && adminUids.length === 1;
          return (
            <li
              key={uid}
              className={cn(
                'flex flex-wrap items-center gap-3 p-3.5',
                i > 0 && 'border-t border-line',
              )}
            >
              <PersonAvatar
                name={name}
                photoURL={profile?.photoURL}
                color={profile?.color ?? 'c8'}
                size="lg"
              />
              <div className="min-w-0 flex-1 basis-40">
                <p className="truncate text-14 font-medium text-ink">
                  {name}
                  {isMe ? <span className="font-normal text-text-2"> (you)</span> : null}
                </p>
                <p className="truncate text-13 text-text-2">{profile?.email ?? ''}</p>
              </div>
              {isAdmin ? (
                <div className="flex items-center gap-1">
                  <RoleSelect
                    name={name}
                    value={role}
                    lastAdmin={lastAdmin}
                    onChange={(r) => changeRole(uid, r)}
                  />
                  <IconButton
                    label={`Remove ${name}`}
                    disabled={lastAdmin}
                    onClick={() => setRemoving(uid)}
                  >
                    <Icon icon={UserMinus} size={18} />
                  </IconButton>
                </div>
              ) : (
                <Badge tone={role === 'admin' ? 'gate' : 'neutral'}>
                  {role === 'admin' ? 'Admin' : 'Member'}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>

      {isAdmin ? (
        <section className="mt-8" aria-labelledby="pending-title">
          <h2 id="pending-title" className="mb-3 text-16 font-semibold">
            Pending invites
          </h2>
          {pending.length === 0 ? (
            <Card>
              <p className="text-14 text-text-2">
                No open invites. Invite someone and their link shows up here.
              </p>
            </Card>
          ) : (
            <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-e1">
              {pending.map((inv, i) => {
                const expired = inv.data.expiresAt.toMillis() <= now;
                const days = Math.max(
                  1,
                  Math.ceil((inv.data.expiresAt.toMillis() - now) / 86_400_000),
                );
                return (
                  <li
                    key={inv.id}
                    className={cn(
                      'flex flex-wrap items-center gap-3 p-3.5',
                      i > 0 && 'border-t border-line',
                    )}
                  >
                    <span className="grid size-11 shrink-0 place-items-center rounded-full bg-canvas text-text-2">
                      <Icon icon={Link2} size={18} />
                    </span>
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="truncate text-14 font-medium text-ink">{inv.data.email}</p>
                      <p className="text-13 text-text-2">
                        {inv.data.role === 'admin' ? 'Admin' : 'Member'} ·{' '}
                        {expired ? 'Expired' : `Expires in ${days} ${days === 1 ? 'day' : 'days'}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {expired ? null : (
                        <CopyButton
                          text={inviteUrl(workspaceId, inv.id, workspace.name)}
                          label="Copy link"
                        />
                      )}
                      <IconButton
                        label={`Revoke invite for ${inv.data.email}`}
                        onClick={() => revoke(inv.id)}
                      >
                        <Icon icon={X} size={18} />
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <p className="mt-6 text-13 text-text-2">Only admins can invite people or change roles.</p>
      )}

      {isAdmin ? <InviteModal open={inviting} onClose={() => setInviting(false)} /> : null}

      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${displayName(removingProfile, removing ?? '')}?`}
        description="They lose access to this organization, its projects and every group. Their past decisions stay in the log."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep
            </Button>
            <Button variant="sendback" loading={busy} onClick={confirmRemove}>
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}
