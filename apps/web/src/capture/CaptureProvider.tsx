import { attach, createItem, shapesNewItems, undoCreateItem, type Project } from '@hive/shared';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { useShellData } from '../shell/data';
import { useShortcut } from '../shell/shortcuts';
import { useToast } from '../ui/overlay';
import { CaptureComposer } from './CaptureComposer';
import { markJustAdded } from './justAdded';
import {
  defaultProject,
  emptyDraft,
  resolveDraft,
  type CaptureType,
  type Draft,
  type PickedFile,
} from './logic';

interface AddInput {
  pid: string;
  project: Project;
  title: string;
  details?: string;
  type: CaptureType;
  files?: PickedFile[];
}

interface Api {
  /** Opens the capture box, on `projectId` when given (else the current project, else the last used). */
  open: (opts?: { projectId?: string }) => void;
  /** Adds an item the same way from anywhere: instant on screen, toast with Open and Undo. */
  add: (input: AddInput) => void;
}
const Ctx = createContext<Api | null>(null);

export function useCapture(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCapture needs <CaptureProvider>');
  return v;
}

/** The capture box, if this tree has one (a screen falling back to Add an item). */
export function useOptionalCapture(): Api | null {
  return useContext(Ctx);
}

const draftKey = (wid: string) => `hive.capture.draft.${wid}`;
function readDraft(wid: string): Draft | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(draftKey(wid)) ?? 'null') as Partial<Draft> | null;
    if (!v || typeof v.title !== 'string' || typeof v.details !== 'string') return null;
    return {
      ...emptyDraft(v.projectId ?? null),
      title: v.title,
      details: v.details,
      type: v.type ?? null,
    };
  } catch {
    return null;
  }
}
function writeDraft(wid: string, d: Draft | null) {
  try {
    if (d) {
      const { title, details, type, projectId } = d;
      sessionStorage.setItem(draftKey(wid), JSON.stringify({ title, details, type, projectId }));
    } else sessionStorage.removeItem(draftKey(wid));
  } catch {
    /* storage is a convenience */
  }
}

const lastKey = (wid: string) => `hive.capture.project.${wid}`;
function readLast(wid: string): string | null {
  try {
    return localStorage.getItem(lastKey(wid));
  } catch {
    return null;
  }
}
function writeLast(wid: string, pid: string) {
  try {
    localStorage.setItem(lastKey(wid), pid);
  } catch {
    /* storage is a convenience */
  }
}

/**
 * Quick capture from anywhere (card M3ipmzNY): the C key, the palette's New item, the phone tab
 * bar's +, and each board's New item button open one box. Saving is optimistic: the item is
 * on screen at once, and the toast offers Open and Undo.
 */
export function CaptureProvider({ children }: { children: ReactNode }) {
  const { session, actionContext, run } = useReady();
  const { projects } = useShellData();
  const toast = useToast();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft(null));
  const [error, setError] = useState('');
  // Kept across closes: Escape keeps an unsent draft.
  // A reload keeps the text (not files) in session storage.
  const hasDraft = useRef(false);
  const draftTaken = useRef(false);
  const [restored] = useState(() => readDraft(session.workspaceId));

  const live = useMemo(
    () =>
      projects
        .filter((p) => !p.data.archivedAt)
        .map((p) => ({ id: p.id, name: p.data.name, emoji: p.data.emoji })),
    [projects],
  );

  const add = useCallback(
    (input: AddInput) => {
      const ctx = actionContext(session.workspaceId);
      if (!ctx) return;
      const { pid, project, title, type } = input;
      const files = input.files ?? [];
      const created = createItem(ctx, {
        project,
        projectId: pid,
        title,
        type,
        summary: input.details?.trim() || undefined,
        // Card st5INNZj: in projects that shape new items an agent picks the path first.
        unshaped: shapesNewItems(project),
      });
      const attachments = files.map((f) =>
        attach(ctx, {
          projectId: pid,
          itemId: created.itemId,
          kind: f.kind,
          name: f.name,
          content: f.content,
        }),
      );
      // Firestore applies a write to the screen at once and sends it in order; nothing waits for
      // the server here. A refusal comes back later and says so.
      const writes = [run(created), ...attachments.map((a) => run(a))];
      writeLast(session.workspaceId, pid);
      markJustAdded(created.itemId);
      Promise.all(writes).catch(() => {
        toast.push({ message: `Could not add "${title}". Try again.` });
      });
      toast.push({
        message: `Added to ${project.name}.`,
        actionLabel: 'Open',
        onAction: () =>
          void navigate({ to: '/p/$pid', params: { pid }, search: { item: created.itemId } }),
        undoLabel: 'Undo',
        duration: 6000,
        onUndo: () => {
          run(
            undoCreateItem(ctx, {
              projectId: pid,
              itemId: created.itemId,
              title,
              attachmentIds: attachments.map((a) => a.attachmentId),
            }),
          ).catch(() => toast.push({ message: `Could not undo. "${title}" stays.` }));
        },
      });
    },
    [actionContext, navigate, run, session.workspaceId, toast],
  );

  const openBox = useCallback(
    (opts?: { projectId?: string }) => {
      const current = /^\/p\/([^/]+)/.exec(path)?.[1] ?? null;
      const start = defaultProject(live, opts?.projectId ?? current, readLast(session.workspaceId));
      setDraft((d) => {
        if (hasDraft.current) return d;
        if (restored && !draftTaken.current) {
          draftTaken.current = true;
          hasDraft.current = true;
          return restored;
        }
        return emptyDraft(start?.id ?? null);
      });
      setError('');
      // The "Added" toast sits above the sheet and would cover its fields (card ASU73ciy).
      toast.dismissAll();
      setOpen(true);
    },
    [live, path, session.workspaceId, restored, toast],
  );

  function change(patch: Partial<Draft>) {
    setError('');
    setDraft((d) => {
      const next = { ...d, ...patch };
      hasDraft.current = next.title !== '' || next.details !== '' || next.files.length > 0;
      writeDraft(session.workspaceId, hasDraft.current ? next : null);
      return next;
    });
  }

  function submit(keepOpen: boolean) {
    const r = resolveDraft(draft, live);
    if (!r.title) {
      setError('Give it a title.');
      return;
    }
    const row = projects.find((p) => p.id === r.project?.id);
    if (!row) {
      setError('Pick a project.');
      return;
    }
    add({
      pid: row.id,
      project: row.data,
      title: r.title,
      details: draft.details,
      type: r.type,
      files: draft.files,
    });
    hasDraft.current = false;
    writeDraft(session.workspaceId, null);
    setDraft(emptyDraft(row.id));
    setError('');
    if (!keepOpen) setOpen(false);
  }

  useShortcut({
    id: 'capture',
    keys: ['c'],
    label: 'Add an item',
    group: 'Actions',
    run: () => openBox(),
  });

  const api = useMemo<Api>(() => ({ open: openBox, add }), [openBox, add]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <ResponsiveModal open={open} onOpenChange={setOpen} title="New item">
        {live.length === 0 ? (
          <p className="text-14 text-text-2">Create a project first, then add items to it.</p>
        ) : (
          <CaptureComposer
            draft={draft}
            onChange={change}
            projects={live}
            variant="sheet"
            onSubmit={submit}
            error={error}
            // The box opens to type one thing: the title takes focus.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            idPrefix="capture"
          />
        )}
      </ResponsiveModal>
    </Ctx.Provider>
  );
}
