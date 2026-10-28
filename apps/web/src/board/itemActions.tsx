import { archiveItem, type Item, type Project } from '@hive/shared';
import { Archive, MoreHorizontal, Trash2 } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { stash } from '../lib/pendingDecisions';
import { Button, IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { ActionMenu, type MenuAction } from '../ui/menu';
import { useToast } from '../ui/overlay';
import { eraseItem } from './eraseItem';
import { canEditItem } from './logic';

/**
 * Archive and Delete… for one item (card rHjaDFEK), in pieces the card menu, the List row menu and
 * the item panel (or the focus view's properties column) share: `useItemActions` gives the menu
 * entries and the confirm dialog; `useHiddenItems` lets the screens drop an archived or deleted
 * item at once, before the write lands.
 */

// ---------- items that left the screens at once ----------

const hiddenKeys = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();
const keyOf = (pid: string, id: string) => `${pid}/${id}`;

function setHidden(pid: string, id: string, on: boolean) {
  const k = keyOf(pid, id);
  if (on === hiddenKeys.has(k)) return;
  if (on) hiddenKeys.add(k);
  else hiddenKeys.delete(k);
  snapshot = new Set(hiddenKeys);
  listeners.forEach((l) => l());
}

/** Items archived or deleted a moment ago (inside the Undo window or being written). */
export function useHiddenItems(): { has: (pid: string, id: string) => boolean; size: number } {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
  return { has: (pid, id) => s.has(keyOf(pid, id)), size: s.size };
}

// ---------- who may, and when ----------

export type ItemActionKind = 'archive' | 'delete';

/** Why this person cannot (or must not yet) do it, or null. Mirrors the rules in firestore.rules. */
export function itemActionBlocker(
  kind: ItemActionKind,
  item: Pick<Item, 'createdBy' | 'claim' | 'status'>,
  who: { uid: string; isAdmin: boolean },
): string | null {
  if (!canEditItem(item, who.uid, who.isAdmin)) return 'Only its creator or an admin can.';
  if (item.claim) return 'An agent is working on it. Stop work first.';
  if (kind === 'archive' && item.status !== 'queued' && item.status !== 'waiting')
    return 'Only open items can be archived.';
  return null;
}

// ---------- the hook ----------

export function useItemActions({
  pid,
  itemId,
  item,
  onGone,
}: {
  pid: string;
  itemId: string;
  item: Item;
  project?: Project;
  /** Called when the item has been archived or deleted (close the panel). */
  onGone?: () => void;
}): { actions: MenuAction[]; dialog: ReactNode } {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const who = { uid: session.me.uid, isAdmin: session.isAdmin };
  const mayArchive = itemActionBlocker('archive', item, who) === null;
  const mayDelete = canEditItem(item, who.uid, who.isAdmin);

  const archive = useCallback(() => {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    const archivePlan = archiveItem(ctx, { projectId: pid, itemId, item });
    setHidden(pid, itemId, true);
    onGone?.();
    // Saved so a reload inside the Undo window still archives it (replayed on load).
    const forget = stash(
      session.me.uid,
      session.workspaceId,
      [archivePlan.ops],
      `Saved: ${item.title} archived`,
    );
    toast.push({
      message: `${item.title} archived.`,
      undoLabel: 'Undo',
      onUndo: () => {
        forget();
        setHidden(pid, itemId, false);
      },
      onCommit: () => {
        run(archivePlan).then(
          () => {
            forget();
            setHidden(pid, itemId, false);
          },
          () => {
            forget();
            setHidden(pid, itemId, false);
            toast.push({ message: `Could not archive ${item.title}. It is back on the board.` });
          },
        );
      },
    });
  }, [actionContext, session.workspaceId, session.me.uid, pid, itemId, item, onGone, toast, run]);

  const actions: MenuAction[] = [];
  if (mayArchive)
    actions.push({ id: 'archive', label: 'Archive', icon: Archive, onSelect: archive });
  if (mayDelete)
    actions.push({
      id: 'delete',
      label: item.erasing ? 'Continue deleting…' : 'Delete…',
      icon: Trash2,
      tone: 'danger',
      onSelect: () => {
        const why = itemActionBlocker('delete', item, who);
        if (why) toast.push({ message: why });
        else setConfirming(true);
      },
    });

  const dialog = confirming ? (
    <DeleteItemDialog
      pid={pid}
      itemId={itemId}
      item={item}
      onOpenChange={setConfirming}
      onDeleted={onGone}
    />
  ) : null;
  return { actions, dialog };
}

// ---------- the confirm ----------

export function DeleteItemDialog({
  pid,
  itemId,
  item,
  onOpenChange,
  onDeleted,
}: {
  pid: string;
  itemId: string;
  item: Item;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { session, actionContext } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await eraseItem(ctx, { projectId: pid, itemId, item });
      setHidden(pid, itemId, true);
      toast.push({ message: `Deleted “${item.title}”.` });
      onOpenChange(false);
      onDeleted?.();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? `${e.message} Deleting stopped; choose Delete again to continue.`
          : 'Deleting stopped. Choose Delete again to continue.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveModal
      open
      onOpenChange={onOpenChange}
      title="Delete this item?"
      description={`Delete “${item.title}” and its history for good? Its notes, files and runs are erased too. This cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="sendback" loading={busy} onClick={confirm}>
            Delete
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-13 text-sendback">
          {error}
        </p>
      ) : (
        <p className="text-14 text-text-2">The Activity keeps one line saying you deleted it.</p>
      )}
    </ResponsiveModal>
  );
}

/**
 * The "..." menu of one item with Archive and Delete… (plus `extra` entries first, such as
 * Restore). Drop it anywhere an item is shown: the item panel, a List row, the focus view's
 * properties column. Renders nothing when the person may do none of it.
 */
export function ItemActions({
  pid,
  itemId,
  item,
  extra = [],
  onGone,
  className,
}: {
  pid: string;
  itemId: string;
  item: Item;
  extra?: MenuAction[];
  onGone?: () => void;
  className?: string;
}) {
  const { actions, dialog } = useItemActions({ pid, itemId, item, onGone });
  const all = [...extra, ...actions];
  if (all.length === 0) return null;
  const label = `Actions for ${item.title}`;
  return (
    <>
      <ActionMenu
        label={label}
        actions={all}
        trigger={
          <IconButton label={label} variant="ghost" className={className} data-testid="item-menu">
            <Icon icon={MoreHorizontal} size={16} />
          </IconButton>
        }
      />
      {dialog}
    </>
  );
}
