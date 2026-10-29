import { Check, ChevronsUpDown, Info, Plus } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import { Popover, useToast } from '../ui/overlay';
import { useOrgs, type OrgRow } from './data';
import { runOrgDelete, useDeleting } from './deleteJobs';

/** The little square with an organization's initial. */
export function OrgMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      // The letter is drawn by CSS so it is not text in the button: the visible text of the
      // control is then the org name alone, which its accessible name must start with.
      data-initial={name.trim().charAt(0).toUpperCase() || '?'}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-btn bg-ink text-13 font-semibold text-surface before:content-[attr(data-initial)]',
        className,
      )}
    />
  );
}

/** Every organization the person is in, with the current one ticked. Tapping one switches to it. */
export function OrgList({ onDone }: { onDone?: () => void }) {
  const { session, switchOrg, actionContext } = useReady();
  const deletingNow = useDeleting();
  const toast = useToast();
  const orgs = useOrgs(session.me.uid, session.profile.workspaceIds);
  // The current one is always listed, even before the profile list has caught up.
  const rows: OrgRow[] = orgs.some((o) => o.id === session.workspaceId)
    ? orgs
    : [
        {
          id: session.workspaceId,
          name: session.workspace.name,
          role: session.role,
          members: Object.keys(session.workspace.memberRoles).length,
          deleting: false,
        },
        ...orgs,
      ];
  return (
    <ul aria-label="Your organizations" className="flex flex-col gap-0.5">
      {rows.map((o) => {
        const current = o.id === session.workspaceId;
        if (o.deleting) {
          const busy = deletingNow.includes(o.id);
          return (
            <li key={o.id} className="flex min-h-11 items-center gap-3 px-2">
              <OrgMark name={o.name} className="opacity-50" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-14 font-medium text-text-2">{o.name}</span>
                <span className="block text-13 text-text-2">
                  {busy ? 'Deleting…' : 'Deletion in progress'}
                </span>
              </span>
              {o.role === 'admin' && !busy ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const ctx = actionContext(o.id);
                    if (ctx)
                      void runOrgDelete(ctx, o.name, true, (message) =>
                        toast.push({ message }),
                      ).catch(() => undefined);
                  }}
                >
                  Continue<span className="sr-only"> deleting {o.name}</span>
                </Button>
              ) : null}
            </li>
          );
        }
        return (
          <li key={o.id}>
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              onClick={() => {
                onDone?.();
                if (!current) {
                  switchOrg(o.id).catch(() =>
                    toast.push({ message: 'Could not switch. Try again.' }),
                  );
                }
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-btn px-2 text-left hov:bg-canvas foc:outline-2 foc:outline-focus"
            >
              <OrgMark name={o.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-14 font-medium text-ink">{o.name}</span>
                <span className="block text-13 text-text-2">{orgDetail(o.role, o.members)}</span>
              </span>
              {current ? <Icon icon={Check} size={18} className="text-ink" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Asks for a name, creates the organization, and switches to it. */
export function NewOrgModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { createOrg } = useReady();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function create() {
    const clean = name.trim();
    if (!clean) return setError('Give the organization a name.');
    setBusy(true);
    try {
      await createOrg(clean);
      toast.push({ message: `${clean} is ready.` });
      setName('');
      onClose();
    } catch {
      setError('Could not create it. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title="New organization"
      description="A separate group of people and projects. You become its admin."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={create}>
            Create organization
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input
          label="Name"
          placeholder="Acme"
          autoComplete="off"
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          error={error}
        />
      </form>
    </ResponsiveModal>
  );
}

/** "Admin · 4 people": the line under an organization's name. */
export function orgDetail(role: string | undefined, members: number): string {
  return `${role === 'admin' ? 'Admin' : 'Member'} · ${members} ${members === 1 ? 'person' : 'people'}`;
}

/**
 * Organization name that opens the switcher. `compact` is the icon-only sidebar; `detailed` adds
 * the role and size under the name (the sidebar's Organization zone, item icVly).
 */
export function OrgSwitcher({
  compact = false,
  detailed = false,
  className,
}: {
  compact?: boolean;
  detailed?: boolean;
  className?: string;
}) {
  const { session } = useReady();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const name = session.workspace.name;
  const detail = orgDetail(session.role, Object.keys(session.workspace.memberRoles).length);
  return (
    <>
      <Popover
        label="Organizations"
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button
            type="button"
            aria-label={`${name}, switch organization`}
            className={cn(
              'flex min-h-11 items-center gap-2 rounded-btn border border-line bg-canvas px-2 text-left text-14 transition-colors hover:border-line-strong foc:outline-2 foc:outline-focus',
              compact ? 'justify-center px-0' : 'w-full',
              detailed && !compact && 'min-h-14 gap-2.5 px-2.5',
              className,
            )}
          >
            <OrgMark name={name} />
            {compact ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{name}</span>
                  {detailed ? (
                    // Drawn by CSS, so the button's visible text stays the name its label starts with.
                    <span
                      aria-hidden
                      data-detail={detail}
                      className="block truncate text-12 text-text-2 before:content-[attr(data-detail)]"
                    />
                  ) : null}
                </span>
                <Icon icon={ChevronsUpDown} size={16} className="shrink-0 text-text-3" />
              </>
            )}
          </button>
        }
      >
        <p className="mb-2 px-2 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
          Switch organization
        </p>
        <OrgList onDone={() => setOpen(false)} />
        <p
          data-switch-scope
          className="mx-1 mt-2 flex gap-2 rounded-btn bg-canvas px-2.5 py-2 text-13 text-text-2"
        >
          <Icon icon={Info} size={15} className="mt-0.5 shrink-0" />
          <span>
            Switching changes the Organization section: projects, agents, settings. Today, Inbox
            and Calendar stay across all your organizations.
          </span>
        </p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setCreating(true);
          }}
          className="mt-2 flex min-h-11 w-full items-center gap-3 rounded-btn border-t border-line px-2 pt-1 text-left text-14 text-text-2 hov:text-ink foc:outline-2 foc:outline-focus"
        >
          <Icon icon={Plus} size={18} />
          New organization
        </button>
      </Popover>
      {creating ? <NewOrgModal open onClose={() => setCreating(false)} /> : null}
    </>
  );
}
