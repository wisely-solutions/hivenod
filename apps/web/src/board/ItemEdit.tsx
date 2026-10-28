import { attach, updateItem, type Item, type ItemType } from '@hive/shared';
import { Paperclip, Pencil } from 'lucide-react';
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useReady } from '../auth/context';
import { FILE_LIMIT, MAX_TITLE, fileKind, fileTooBigMessage } from '../capture/logic';
import { readFile } from '../capture/readFile';
import { Markdown } from '../process/markdown';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Input, Select, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';

const SUMMARY_MAX = 20000;
const TYPES: Array<{ value: string; label: string }> = [
  { value: 'idea', label: 'Idea' },
  { value: 'request', label: 'Request' },
  { value: 'bug', label: 'Bug' },
  { value: 'task', label: 'Task' },
];

/** Puts the caret in a field that just replaced a button the person pressed. */
function focusOnMount(el: HTMLInputElement | HTMLTextAreaElement | null) {
  el?.focus();
}

/** Saves one change to the item's wording, with its event (so it shows in the history). */
function useSaveItem(pid: string, itemId: string, item: Item) {
  const { session, actionContext, run } = useReady();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(changes: { title?: string; summary?: string; type?: ItemType }) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return false;
    setSaving(true);
    setError('');
    try {
      await run(
        updateItem(ctx, {
          projectId: pid,
          itemId,
          changes,
          before: { title: item.title, type: item.type },
        }),
      );
      return true;
    } catch {
      setError("That didn't save. Check your connection and try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { save, saving, error };
}

interface Common {
  pid: string;
  itemId: string;
  item: Item;
}

/** The title; people who may edit it get a pencil that turns it into a field. */
export function EditableTitle({ pid, itemId, item, canEdit }: Common & { canEdit: boolean }) {
  const { save, saving, error } = useSaveItem(pid, itemId, item);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.title);
  if (!editing) {
    return (
      <div className="flex items-start gap-1">
        {/* Click to edit in place; the pencil is the keyboard way in. */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
        <h2
          className={cn(
            'min-w-0 flex-1 text-20 font-semibold leading-snug text-ink',
            canEdit && 'cursor-text',
          )}
          onClick={
            canEdit
              ? () => {
                  setValue(item.title);
                  setEditing(true);
                }
              : undefined
          }
        >
          {item.title}
        </h2>
        {canEdit ? (
          <IconButton
            label="Edit title"
            variant="ghost"
            onClick={() => {
              setValue(item.title);
              setEditing(true);
            }}
          >
            <Icon icon={Pencil} size={16} />
          </IconButton>
        ) : null}
      </div>
    );
  }
  const next = value.trim();
  async function commit() {
    if (!next || next === item.title) {
      setEditing(false);
      return;
    }
    if (await save({ title: next })) setEditing(false);
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <Input
        label="Title"
        value={value}
        maxLength={MAX_TITLE}
        ref={focusOnMount}
        error={error || undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" loading={saving} disabled={!next}>
          Save title
        </Button>
        <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The type chip; people who may edit it get a native select that looks like the chip. */
export function TypePicker({ pid, itemId, item }: Common) {
  const { save, error } = useSaveItem(pid, itemId, item);
  return (
    <>
      <Select
        hideLabel
        inline
        label="Type"
        value={item.type}
        onValueChange={(v) => void save({ type: v as ItemType })}
        options={TYPES}
      />
      {error ? (
        <p role="alert" className="text-13 text-sendback">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The description, in Markdown: shown as text, edited in place by who may edit it. */
export function EditableSummary({ pid, itemId, item, canEdit }: Common & { canEdit: boolean }) {
  const { save, saving, error } = useSaveItem(pid, itemId, item);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.summary);
  if (editing) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (value === item.summary || (await save({ summary: value }))) setEditing(false);
        }}
      >
        <Textarea
          label="Description"
          hint="Markdown supported. Agents read this as the brief."
          value={value}
          maxLength={SUMMARY_MAX}
          ref={focusOnMount}
          error={error || undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div className="flex gap-2">
          <Button type="submit" loading={saving}>
            Save description
          </Button>
          <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  const start = () => {
    setValue(item.summary);
    setEditing(true);
  };
  return (
    <div className="flex flex-col gap-2">
      {item.summary ? (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          className={canEdit ? 'cursor-text' : undefined}
          onClick={(e) => {
            // A click on the text edits it; a click on a link opens the link, and selecting text keeps it.
            if (
              canEdit &&
              !(e.target as HTMLElement).closest('a') &&
              !window.getSelection()?.toString()
            )
              start();
          }}
        >
          <Markdown source={item.summary} />
        </div>
      ) : (
        <p className="text-14 text-text-2">
          {canEdit
            ? 'No description yet. Agents work from the title alone.'
            : 'No description yet.'}
        </p>
      )}
      {canEdit ? (
        <Button
          variant="secondary"
          className="self-start"
          leading={<Icon icon={Pencil} size={14} />}
          onClick={start}
        >
          {item.summary ? 'Edit description' : 'Add a description'}
        </Button>
      ) : null}
    </div>
  );
}

const MAX_PER_ADD = 5;

/** Adds files to the item as an attachment each; the shared logic of the zone and the note field. */
export function useAddFiles(pid: string, itemId: string) {
  const { session, actionContext, run } = useReady();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(list: File[]) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx || list.length === 0) return;
    setError('');
    setBusy(true);
    const problems: string[] = [];
    try {
      for (const f of list.slice(0, MAX_PER_ADD)) {
        const kind = fileKind(f);
        const name = f.name || `pasted.${kind === 'image' ? 'png' : 'txt'}`;
        if (!kind) {
          problems.push(`${name} can't be attached. Use an image, PDF or text file.`);
          continue;
        }
        const content = await readFile(f, kind);
        if (content.length > FILE_LIMIT) {
          problems.push(fileTooBigMessage(name, kind, f.size, content.length));
          continue;
        }
        try {
          await run(attach(ctx, { projectId: pid, itemId, kind, name, content }));
        } catch {
          problems.push(`${name} didn't save.`);
        }
      }
      if (list.length > MAX_PER_ADD) problems.push(`Up to ${MAX_PER_ADD} files at a time.`);
    } finally {
      setBusy(false);
      setError(problems.join(' '));
    }
  }
  return { add, busy, error };
}

/**
 * A paste handler that sends pasted files to `add` and leaves plain-text pastes alone.
 * Returns true when it took the paste.
 */
export function takePastedFiles(e: ClipboardEvent<HTMLElement>, add: (f: File[]) => void): boolean {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return false;
  e.preventDefault();
  add(files);
  return true;
}

/** Add files (picked, dropped or pasted screenshots) to the item, as an attachment each. */
export function AddFiles({
  pid,
  itemId,
  children,
}: {
  pid: string;
  itemId: string;
  children: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { add, busy, error } = useAddFiles(pid, itemId);
  const [over, setOver] = useState(false);

  function onPaste(e: ClipboardEvent<HTMLElement>) {
    takePastedFiles(e, (f) => void add(f));
  }
  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setOver(false);
    void add(Array.from(e.dataTransfer.files));
  }

  return (
    <div
      data-testid="attach-zone"
      onPaste={onPaste}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col gap-2 rounded-card',
        over && 'outline-dashed outline-2 outline-agent',
      )}
    >
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          loading={busy}
          leading={<Icon icon={Paperclip} size={14} />}
          onClick={() => input.current?.click()}
        >
          Add a file
        </Button>
        <span className="text-13 text-text-2">
          or drop files, or paste a screenshot (up to 900 KB each once encoded: about 675 KB for
          images and PDFs)
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Add files"
          accept="image/*,application/pdf,text/*,.md,.markdown,.html,.htm,.log,.csv,.json"
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-13 text-sendback">
          {error}
        </p>
      ) : null}
    </div>
  );
}
