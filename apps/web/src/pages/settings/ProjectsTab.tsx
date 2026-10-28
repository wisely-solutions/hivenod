import { restoreProject, updateProject, type Project } from '@hive/shared';
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
import { Input, Textarea } from '../../ui/form';
import { Icon } from '../../ui/icon';
import { useToast } from '../../ui/overlay';
import { PageHeader } from '../Chrome';

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

  const rows = useMemo(
    () =>
      [...projects].sort(
        (a, b) =>
          Number(Boolean(a.data.archivedAt)) - Number(Boolean(b.data.archivedAt)) ||
          a.data.name.localeCompare(b.data.name),
      ),
    [projects],
  );

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
            await run(updateProject(ctx, { projectId: editing.id, ...v }));
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
  onSave: (v: { name: string; emoji: string; description: string }) => Promise<void>;
}) {
  const p = project.data;
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
      await onSave({ name: clean, emoji, description: description.trim() });
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
