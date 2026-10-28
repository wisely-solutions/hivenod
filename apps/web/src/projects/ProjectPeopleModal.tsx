import { setProjectMembers, type Project } from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import type { Row } from '../lib/live';
import { Button } from '../ui/button';
import { useToast } from '../ui/overlay';
import { PeoplePicker } from './PeoplePicker';

/** Admins choose who can see a project. Mount with a fresh `key` per project. */
export function ProjectPeopleModal({
  project,
  onClose,
}: {
  project: Row<Project>;
  onClose: () => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [people, setPeople] = useState<string[]>(project.data.memberUids);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      // Admins always see everything, so only plain members are stored.
      const members = people.filter((u) => session.workspace.memberRoles[u] === 'member');
      await run(
        setProjectMembers(ctx, {
          projectId: project.id,
          name: project.data.name,
          memberUids: members,
        }),
      );
      toast.push({ message: `People on ${project.data.name} saved.` });
      onClose();
    } catch {
      setError('Could not save. Try again.');
      setBusy(false);
    }
  }

  return (
    <ResponsiveModal
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={`People on ${project.data.name}`}
      description="Only the people ticked here, and admins, can see this project, its items and its activity."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <PeoplePicker value={people} onChange={setPeople} />
      {error ? (
        <p role="alert" className="mt-3 text-13 text-sendback">
          {error}
        </p>
      ) : null}
    </ResponsiveModal>
  );
}
