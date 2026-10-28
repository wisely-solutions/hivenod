import {
  agentsMayCreateItems,
  canEditAgentSettings,
  restoreProject,
  setAgentsMayCreateItems,
  setSilenceAfter,
  setStatusEvery,
  SILENCE_AFTER_CHOICES,
  silenceAfterOf,
  STATUS_EVERY_CHOICES,
  statusEveryOf,
  updateProject,
  type Project,
  type SilenceAfter,
  type StatusEvery,
} from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Pencil, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../../auth/context';
import type { Row } from '../../lib/live';
import { EMOJI_CHOICES } from '../../projects/logic';
import { useArchiveProject } from '../../projects/useArchive';
import { ResponsiveModal } from '../../components/ResponsiveModal';
import { useShellData } from '../../shell/data';
import { Pill } from '../../ui/badge';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Input, Select, Textarea, Toggle } from '../../ui/form';
import { Icon } from '../../ui/icon';
import { useToast } from '../../ui/overlay';
import { PageHeader } from '../Chrome';

/** Item DhsO9: the words of the "Agents may create items" switch. */
export const AGENTS_CREATE_LABEL = 'Agents may create items';
export function agentsCreateHint(may: boolean): string {
  return may
    ? 'Agents on this project can add new work at its first step, at most 30 an hour each.'
    : 'Agents on this project can add new work at its first step. Admins and the project creator switch this.';
}

/** Item AzveC: the words of the status interval. */
export const STATUS_EVERY_LABEL = 'Ask agents for a status';
export const STATUS_EVERY_OPTIONS = STATUS_EVERY_CHOICES.map((m) => ({
  value: String(m),
  label: m === 0 ? 'Never' : `Every ${m} minutes`,
}));
export function statusEveryHint(may: boolean): string {
  return may
    ? 'While an agent works an item, it is asked for a one-line status this often. Off by default: anyone can still press Ask for status.'
    : 'While an agent works an item, it is asked for a one-line status this often. Admins and the project creator change this.';
}

/** Item AzveC: the words of the silence threshold. */
export const SILENCE_AFTER_LABEL = 'Flag an item as silent after';
export const SILENCE_AFTER_OPTIONS = SILENCE_AFTER_CHOICES.map((m) => ({
  value: String(m),
  label: m === 0 ? 'Never' : `${m} minutes without activity`,
}));
export function silenceAfterHint(may: boolean): string {
  return may
    ? 'When the agent working an item has not logged, written or given a status for this long, the item shows No update and its deciders are told once.'
    : 'When the agent working an item has not logged, written or given a status for this long, the item shows No update. Admins and the project creator change this.';
}

const rowBtn =
  'inline-flex min-h-11 items-center gap-1.5 rounded-btn px-3 text-14 font-medium text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-focus';

/** Settings > Projects: every project you can see, archived ones marked. Admins edit and archive. */
export function ProjectsTab() {
  const { session, actionContext, run } = useReady();
  const { projects, loading } = useShellData();
  const toast = useToast();
  const { hidden, archive, cancelArchive } = useArchiveProject();
  const [editing, setEditing] = useState<Row<Project> | null>(null);
  const { isAdmin } = session;
  const mayChange = (p: Row<Project>) =>
    canEditAgentSettings({ uid: session.me.uid, isAdmin }, { createdBy: p.data.createdBy });

  const rows = useMemo(
    () =>
      [...projects].sort(
        (a, b) =>
          Number(Boolean(a.data.archivedAt)) - Number(Boolean(b.data.archivedAt)) ||
          a.data.name.localeCompare(b.data.name),
      ),
    [projects],
  );

  const [switching, setSwitching] = useState<string | null>(null);
  async function setAgentsCreate(p: Row<Project>, on: boolean) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setSwitching(p.id);
    try {
      await run(setAgentsMayCreateItems(ctx, { projectId: p.id, on }));
      toast.push({
        message: on
          ? `Agents may now create items in ${p.data.name}.`
          : `Agents no longer create items in ${p.data.name}.`,
      });
    } catch (e) {
      toast.push({ message: `Could not save: ${(e as Error).message}` });
    } finally {
      setSwitching(null);
    }
  }

  async function changeStatusEvery(p: Row<Project>, every: StatusEvery) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setSwitching(p.id);
    try {
      await run(setStatusEvery(ctx, { projectId: p.id, every }));
      toast.push({
        message:
          every === 0
            ? `Agents in ${p.data.name} are no longer asked for a status.`
            : `Agents in ${p.data.name} are asked for a status every ${every} minutes.`,
      });
    } catch (e) {
      toast.push({ message: `Could not save: ${(e as Error).message}` });
    } finally {
      setSwitching(null);
    }
  }

  async function changeSilenceAfter(p: Row<Project>, after: SilenceAfter) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setSwitching(p.id);
    try {
      await run(setSilenceAfter(ctx, { projectId: p.id, after }));
      toast.push({
        message:
          after === 0
            ? `Items in ${p.data.name} are no longer flagged as silent.`
            : `Items in ${p.data.name} are flagged after ${after} minutes without activity.`,
      });
    } catch (e) {
      toast.push({ message: `Could not save: ${(e as Error).message}` });
    } finally {
      setSwitching(null);
    }
  }

  function restore(p: Row<Project>) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    run(restoreProject(ctx, { projectId: p.id, name: p.data.name })).then(
      () => toast.push({ message: `${p.data.name} restored.` }),
      () => toast.push({ message: `Could not restore ${p.data.name}.` }),
    );
  }

  return (
    <>
      <PageHeader
        section
        title="Projects"
        subtitle={
          isAdmin
            ? 'Edit, open the process, archive or restore. Projects are archived, never deleted.'
            : 'Only an admin changes projects. You see the ones you are on.'
        }
      />
      {loading ? (
        <p className="text-14 text-text-2" role="status">
          Loading projects…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-14 text-text-2">No projects yet.</p>
      ) : (
        <ul
          aria-label="Projects"
          className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-e1"
        >
          {rows.map((p) => {
            // Archived at once on screen; the write follows when the Undo toast ends.
            const pendingArchive = hidden.has(p.id);
            const archived = Boolean(p.data.archivedAt) || pendingArchive;
            return (
              <li key={p.id} aria-label={p.data.name} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span aria-hidden className="text-20">
                    {p.data.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-14 font-medium', archived && 'text-text-2')}>
                      {p.data.name}
                    </p>
                    {p.data.description ? (
                      <p className="truncate text-13 text-text-2">{p.data.description}</p>
                    ) : null}
                  </div>
                  {archived ? <Pill tone="neutral">Archived</Pill> : null}
                </div>
                {archived ? null : (
                  <div data-testid="agents-create-switch">
                    <Toggle
                      label={AGENTS_CREATE_LABEL}
                      description={agentsCreateHint(mayChange(p))}
                      checked={agentsMayCreateItems(p.data)}
                      disabled={!mayChange(p) || switching === p.id}
                      onCheckedChange={(v) => void setAgentsCreate(p, v)}
                    />
                  </div>
                )}
                {archived ? null : (
                  <div data-testid="status-every" className="flex flex-col gap-1">
                    <Select
                      inline
                      label={STATUS_EVERY_LABEL}
                      value={String(statusEveryOf(p.data))}
                      options={STATUS_EVERY_OPTIONS}
                      disabled={!mayChange(p) || switching === p.id}
                      onValueChange={(v) => void changeStatusEvery(p, Number(v) as StatusEvery)}
                    />
                    <p className="text-13 text-text-2">{statusEveryHint(mayChange(p))}</p>
                  </div>
                )}
                {archived ? null : (
                  <div data-testid="silence-after" className="flex flex-col gap-1">
                    <Select
                      inline
                      label={SILENCE_AFTER_LABEL}
                      value={String(silenceAfterOf(p.data))}
                      options={SILENCE_AFTER_OPTIONS}
                      disabled={!mayChange(p) || switching === p.id}
                      onValueChange={(v) => void changeSilenceAfter(p, Number(v) as SilenceAfter)}
                    />
                    <p className="text-13 text-text-2">{silenceAfterHint(mayChange(p))}</p>
                  </div>
                )}
                <div className="-ml-3 flex flex-wrap gap-x-1">
                  {isAdmin ? (
                    <button type="button" className={rowBtn} onClick={() => setEditing(p)}>
                      <Icon icon={Pencil} size={16} />
                      Edit<span className="sr-only"> {p.data.name}</span>
                    </button>
                  ) : null}
                  <Link to="/p/$pid/process" params={{ pid: p.id }} className={rowBtn}>
                    <Icon icon={Workflow} size={16} />
                    Open process<span className="sr-only"> of {p.data.name}</span>
                  </Link>
                  {isAdmin && !archived ? (
                    <button type="button" className={rowBtn} onClick={() => archive(p)}>
                      <Icon icon={Archive} size={16} />
                      Archive<span className="sr-only"> {p.data.name}</span>
                    </button>
                  ) : null}
                  {isAdmin && pendingArchive ? (
                    <button type="button" className={rowBtn} onClick={() => cancelArchive(p.id)}>
                      <Icon icon={ArchiveRestore} size={16} />
                      Restore<span className="sr-only"> {p.data.name}</span>
                    </button>
                  ) : null}
                  {isAdmin && archived && !pendingArchive ? (
                    <button type="button" className={rowBtn} onClick={() => restore(p)}>
                      <Icon icon={ArchiveRestore} size={16} />
                      Restore<span className="sr-only"> {p.data.name}</span>
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <EditProjectModal
          key={editing.id}
          project={editing}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            const ctx = actionContext(session.workspaceId);
            if (!ctx) return;
            const {
              agentsMayCreateItems: on,
              statusEvery: every,
              silenceAfter: after,
              ...rest
            } = v;
            await run(
              updateProject(ctx, {
                projectId: editing.id,
                ...rest,
                ...(on === agentsMayCreateItems(editing.data) ? {} : { agentsMayCreateItems: on }),
                ...(every === statusEveryOf(editing.data) ? {} : { statusEvery: every }),
                ...(after === silenceAfterOf(editing.data) ? {} : { silenceAfter: after }),
              }),
            );
            toast.push({ message: `${v.name} saved.` });
          }}
        />
      ) : null}
    </>
  );
}

function EditProjectModal({
  project,
  onClose,
  onSave,
}: {
  project: Row<Project>;
  onClose: () => void;
  onSave: (v: {
    name: string;
    emoji: string;
    description: string;
    agentsMayCreateItems: boolean;
    statusEvery: StatusEvery;
    silenceAfter: SilenceAfter;
  }) => Promise<void>;
}) {
  const p = project.data;
  const [agentsCreate, setAgentsCreate] = useState(agentsMayCreateItems(p));
  const [statusEvery, setStatusEveryValue] = useState<StatusEvery>(statusEveryOf(p));
  const [silenceAfter, setSilenceAfterValue] = useState<SilenceAfter>(silenceAfterOf(p));
  const [name, setName] = useState(p.name);
  const [emoji, setEmoji] = useState(p.emoji);
  const [description, setDescription] = useState(p.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const choices = EMOJI_CHOICES.includes(p.emoji) ? EMOJI_CHOICES : [p.emoji, ...EMOJI_CHOICES];

  async function save() {
    const clean = name.trim();
    if (!clean) return setError('Give the project a name.');
    setBusy(true);
    try {
      await onSave({
        name: clean,
        emoji,
        description: description.trim(),
        agentsMayCreateItems: agentsCreate,
        statusEvery,
        silenceAfter,
      });
      onClose();
    } catch {
      setError('Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveModal
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={`Edit ${p.name}`}
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
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          label="Name"
          value={name}
          maxLength={120}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          error={error}
        />
        <Textarea
          label="Description"
          hint="Optional. What this project is for."
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Toggle
          label={AGENTS_CREATE_LABEL}
          description={agentsCreateHint(true)}
          checked={agentsCreate}
          onCheckedChange={setAgentsCreate}
        />
        <div className="flex flex-col gap-1">
          <Select
            label={STATUS_EVERY_LABEL}
            value={String(statusEvery)}
            options={STATUS_EVERY_OPTIONS}
            onValueChange={(v) => setStatusEveryValue(Number(v) as StatusEvery)}
          />
          <p className="text-13 text-text-2">{statusEveryHint(true)}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Select
            label={SILENCE_AFTER_LABEL}
            value={String(silenceAfter)}
            options={SILENCE_AFTER_OPTIONS}
            onValueChange={(v) => setSilenceAfterValue(Number(v) as SilenceAfter)}
          />
          <p className="text-13 text-text-2">{silenceAfterHint(true)}</p>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-13 font-medium text-ink">Emoji</legend>
          <div role="radiogroup" aria-label="Emoji" className="flex flex-wrap gap-1">
            {choices.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={e === emoji}
                aria-label={`Emoji ${e}`}
                onClick={() => setEmoji(e)}
                className={cn(
                  'grid size-11 place-items-center rounded-btn border text-20',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  e === emoji ? 'border-ink bg-canvas' : 'border-transparent hover:bg-canvas',
                )}
              >
                <span aria-hidden>{e}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </form>
    </ResponsiveModal>
  );
}
