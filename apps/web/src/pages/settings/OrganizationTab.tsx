import { beginOrgDelete, leaveOrganization, renameWorkspace } from '@hive/shared';
import { Download, DoorOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReady } from '../../auth/context';
import { ResponsiveModal } from '../../components/ResponsiveModal';
import {
  downloadParts,
  exportFilename,
  exportOrg,
  firestoreExportStore,
} from '../../orgs/exportOrg';
import { countOrg, type OrgCounts } from '../../orgs/deleteOrg';
import { runOrgDelete } from '../../orgs/deleteJobs';
import { NewOrgModal, OrgList } from '../../orgs/OrgSwitcher';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/form';
import { Icon } from '../../ui/icon';
import { Dialog, useToast } from '../../ui/overlay';
import { PageHeader } from '../Chrome';

/** Settings > Organization: your organizations, its name, New and Leave. */
export function OrganizationTab() {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const { workspace, workspaceId, isAdmin } = session;
  const [wsDraft, setWsName] = useState<string | null>(null);
  const wsName = wsDraft ?? workspace.name;
  const [busy, setBusy] = useState<'workspace' | 'leave' | null>(null);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [leaving, setLeaving] = useState(false);

  async function saveWorkspace() {
    const ctx = actionContext(workspaceId);
    if (!ctx) return;
    setBusy('workspace');
    try {
      await run(renameWorkspace(ctx, { name: wsName.trim() }));
      setWsName(null);
      toast.push({ message: 'Organization renamed' });
    } catch {
      toast.push({ message: 'Could not rename the organization.' });
    } finally {
      setBusy(null);
    }
  }

  const adminUids = Object.keys(workspace.memberRoles).filter(
    (u) => workspace.memberRoles[u] === 'admin',
  );
  const lastAdmin = isAdmin && adminUids.length === 1;

  async function confirmLeave() {
    const ctx = actionContext(workspaceId);
    if (!ctx) return;
    setBusy('leave');
    try {
      await run(leaveOrganization(ctx, { adminUids }));
      setLeaving(false);
    } catch {
      toast.push({ message: 'Could not leave the organization. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader section title="Organization" />
      <Card className="flex flex-col gap-2">
        <OrgList />
        <Button
          variant="ghost"
          className="self-start"
          leading={<Icon icon={Plus} />}
          onClick={() => setCreatingOrg(true)}
        >
          New organization
        </Button>
      </Card>
      <Card className="mt-3 flex flex-col gap-4">
        {isAdmin ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (wsName.trim() && wsName.trim() !== workspace.name) saveWorkspace();
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                label="Organization name"
                value={wsName}
                maxLength={120}
                onChange={(e) => setWsName(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="secondary"
              loading={busy === 'workspace'}
              disabled={!wsName.trim() || wsName.trim() === workspace.name}
            >
              Rename
            </Button>
          </form>
        ) : (
          <p className="text-14">
            <span className="text-text-2">Organization </span>
            <span className="font-medium">{workspace.name}</span>
          </p>
        )}
      </Card>
      <div className="mt-3">
        <Button
          variant="ghost"
          leading={<Icon icon={DoorOpen} />}
          disabled={lastAdmin}
          aria-describedby={lastAdmin ? 'leave-org-note' : undefined}
          onClick={() => setLeaving(true)}
        >
          Leave organization
        </Button>
        {lastAdmin ? (
          <p id="leave-org-note" className="mt-1 text-13 text-text-2">
            You are the only admin. Make someone else an admin before you leave.
          </p>
        ) : null}
      </div>

      <Dialog
        open={leaving}
        onOpenChange={(o) => !o && setLeaving(false)}
        title={`Leave ${workspace.name}?`}
        description="You lose access to this organization, its projects and groups. Your past decisions stay in the log. An admin can invite you back."
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaving(false)}>
              Stay
            </Button>
            <Button variant="sendback" loading={busy === 'leave'} onClick={confirmLeave}>
              Leave
            </Button>
          </>
        }
      />
      {isAdmin ? <ExportCard /> : null}
      {isAdmin ? <DangerZone /> : null}

      {creatingOrg ? <NewOrgModal open onClose={() => setCreatingOrg(false)} /> : null}
    </>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Admins only: the organization's data as one JSON file (members, groups, agents, events). */
function ExportCard() {
  const { session } = useReady();
  const { workspace, workspaceId } = session;
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [docs, setDocs] = useState(0);

  async function start() {
    setState('running');
    setDocs(0);
    try {
      const r = await exportOrg(firestoreExportStore, workspaceId, {
        onProgress: (p) => setDocs(p.docs),
      });
      downloadParts(r.parts, exportFilename(workspace.name, workspaceId));
      setDocs(r.total);
      setState('done');
    } catch {
      setState('failed');
    }
  }

  return (
    <section aria-labelledby="export-title" className="mt-8 rounded-card border border-line p-4">
      <h3 id="export-title" className="text-16 font-semibold text-ink">
        Export organization data (JSON)
      </h3>
      <p className="mt-1 text-14 text-text-2">
        One file with the members, groups, agents and events of {workspace.name}. Projects and the
        calendar were removed: the operator export (scripts/export-org.mjs) holds their old data.
      </p>
      <Button
        variant="secondary"
        className="mt-3"
        leading={<Icon icon={Download} />}
        loading={state === 'running'}
        onClick={start}
      >
        Export organization data (JSON)
      </Button>
      <p role="status" className="mt-2 text-13 text-text-2">
        {state === 'running' ? `Reading… ${docs} documents so far` : null}
        {state === 'done' ? `Done: ${docs} documents saved to your downloads.` : null}
        {state === 'failed' ? 'Could not export. Try again.' : null}
      </p>
    </section>
  );
}

/** Admins only: erase the organization for good. */
function DangerZone() {
  const { session } = useReady();
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="danger-title"
      className="mt-8 rounded-card border border-sendback/40 p-4"
    >
      <h3 id="danger-title" className="text-16 font-semibold text-ink">
        Danger zone
      </h3>
      <p className="mt-1 text-14 text-text-2">
        Delete {session.workspace.name} with everything in it. This cannot be undone.
      </p>
      <Button
        variant="sendback"
        className="mt-3"
        leading={<Icon icon={Trash2} />}
        onClick={() => setOpen(true)}
      >
        Delete organization
      </Button>
      {open ? <DeleteOrgDialog onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

function DeleteOrgDialog({ onClose }: { onClose: () => void }) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const { workspace, workspaceId } = session;
  const [counts, setCounts] = useState<OrgCounts | null>(null);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const members = Object.keys(workspace.memberRoles).length;

  useEffect(() => {
    let live = true;
    countOrg(workspaceId, members).then(
      (c) => live && setCounts(c),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, members]);

  const matches = typed === workspace.name;

  async function confirm() {
    const ctx = actionContext(workspaceId);
    if (!ctx || !matches) return;
    setBusy(true);
    try {
      await run(beginOrgDelete(ctx));
    } catch {
      setBusy(false);
      return setError('Could not start deleting. Try again.');
    }
    // From here the organization is flagged and this screen is on its way out: the job lives on.
    toast.push({ message: `Deleting ${workspace.name}…` });
    void runOrgDelete(ctx, workspace.name, true, (message) => toast.push({ message })).catch(
      () => undefined,
    );
    onClose();
  }

  return (
    <ResponsiveModal
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={`Delete ${workspace.name}?`}
      description="Everything in it is erased for good. There is no trash and no undo."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant="sendback"
            loading={busy}
            disabled={!matches || !counts}
            onClick={confirm}
          >
            Delete everything
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        {counts ? (
          <ul aria-label="What will be deleted" className="list-disc pl-5 text-14">
            <li>
              {plural(counts.members, 'member loses', 'members lose')} access
              {counts.members > 1 ? ' (they move to another organization)' : ''}
            </li>
            <li>
              {plural(counts.agents, 'agent', 'agents')} disconnected: their tokens stop working
            </li>
          </ul>
        ) : failed ? (
          <p role="alert" className="text-14 text-sendback">
            Could not count what is in it. Close this and try again.
          </p>
        ) : (
          <p role="status" className="text-14 text-text-2">
            Counting what is in it…
          </p>
        )}
        <Input
          label={`Type ${workspace.name} to confirm`}
          value={typed}
          autoComplete="off"
          onChange={(e) => {
            setTyped(e.target.value);
            setError(undefined);
          }}
          error={error}
        />
      </form>
    </ResponsiveModal>
  );
}
