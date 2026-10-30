import { Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { GroupEditor } from '../members/GroupEditor';
import { displayName, useGroups, useProfiles } from '../members/data';
import { deleteGroupFlow, saveGroupFlow } from '../members/groupFlow';
import { AvatarStack } from '../ui/avatar';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/feedback';
import { Icon } from '../ui/icon';
import { Skeleton } from '../ui/feedback';
import { Dialog, useToast } from '../ui/overlay';
import { PageHeader } from './Chrome';
import { cn } from '../ui/cn';

type Editing = { id?: string } | null;

export function GroupsPage() {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const { workspace, workspaceId, isAdmin } = session;
  const uids = Object.keys(workspace.memberRoles);
  const profiles = useProfiles(workspaceId, uids);
  const groups = useGroups(workspaceId);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const people = uids
    .map((uid) => ({ uid, profile: profiles[uid] }))
    .sort((a, b) => displayName(a.profile, a.uid).localeCompare(displayName(b.profile, b.uid)));
  const list = groups.state === 'ready' ? groups.data : [];
  const editingRow = editing?.id ? list.find((g) => g.id === editing.id) : undefined;
  const ctx = actionContext(workspaceId);

  async function save(v: { name: string; memberUids: string[] }) {
    if (!ctx || groups.state !== 'ready') return;
    setBusy(true);
    try {
      await saveGroupFlow({ run, ctx, groups: groups.data, groupId: editing?.id, ...v });
      setEditing(null);
    } catch {
      toast.push({ message: 'Could not save the group. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!ctx || groups.state !== 'ready' || !editing?.id) return;
    setBusy(true);
    try {
      await deleteGroupFlow({ run, ctx, groupId: editing.id });
      setConfirmDelete(false);
      setEditing(null);
    } catch {
      toast.push({ message: 'Could not delete the group. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Groups"
        section
        subtitle="Teams you can pick as deciders at a gate."
        action={
          isAdmin ? (
            <Button leading={<Icon icon={Plus} />} onClick={() => setEditing({})}>
              New group
            </Button>
          ) : null
        }
      />

      {groups.state === 'loading' ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No groups yet"
          description={
            isAdmin
              ? 'Make a group like Product or Leadership, then pick it as a decider at a gate.'
              : 'An admin can make groups like Product or Leadership.'
          }
          action={
            isAdmin ? (
              <Button onClick={() => setEditing({})} leading={<Icon icon={Plus} />}>
                New group
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Groups">
          {list.map((g) => {
            const stack = g.data.memberUids.map((uid) => ({
              name: displayName(profiles[uid], uid),
              photoUrl: profiles[uid]?.photoURL ?? undefined,
            }));
            const inner = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-16 font-semibold text-ink">
                    {g.data.name}
                  </span>
                  <span className="mt-0.5 block text-13 text-text-2">
                    {g.data.memberUids.length === 0
                      ? 'No members'
                      : `${g.data.memberUids.length} ${g.data.memberUids.length === 1 ? 'member' : 'members'}`}
                  </span>
                </span>
                {stack.length > 0 ? <AvatarStack people={stack} max={4} /> : null}
              </>
            );
            const cls =
              'flex min-h-20 w-full items-center gap-3 rounded-card border border-line bg-surface p-4 text-left shadow-e1';
            return (
              <li key={g.id}>
                {isAdmin ? (
                  <button
                    type="button"
                    aria-label={`Edit group ${g.data.name}`}
                    onClick={() => setEditing({ id: g.id })}
                    className={cn(cls, 'transition-colors hover:border-line-strong')}
                  >
                    {inner}
                  </button>
                ) : (
                  <div className={cls}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!isAdmin ? (
        <p className="mt-6 text-13 text-text-2">Only admins can create or change groups.</p>
      ) : null}

      {isAdmin ? (
        <GroupEditor
          open={editing !== null}
          group={editingRow}
          people={people}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
          onDelete={() => setConfirmDelete(true)}
        />
      ) : null}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${editingRow?.data.name ?? 'group'}?`}
        description="Gates that use this group lose its members as deciders. Check them after."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button variant="sendback" loading={busy} onClick={remove}>
              Delete group
            </Button>
          </>
        }
      />
    </>
  );
}
