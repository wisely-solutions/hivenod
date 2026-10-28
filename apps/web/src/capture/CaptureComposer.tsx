import { Paperclip, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Select } from '../ui/form';
import { Icon } from '../ui/icon';
import {
  CAPTURE_TYPES,
  FILE_LIMIT,
  fileTooBigMessage,
  MAX_TITLE,
  fileKind,
  resolveDraft,
  splitPaste,
  type CaptureType,
  type Draft,
  type PickedFile,
} from './logic';
import { readFile } from './readFile';

export interface ComposerProject {
  id: string;
  name: string;
  emoji: string;
}

const MAX_FILES = 5;

/**
 * The capture box: one line to type, Enter to add. The project and the type are chips you can
 * change; the type is guessed from the text and says so. Used full-size in the capture sheet and
 * compact (`inline`) in the first column of a board, so both behave the same.
 */
export function CaptureComposer({
  draft,
  onChange,
  projects,
  variant,
  onSubmit,
  busy,
  error,
  autoFocus,
  idPrefix,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  projects: ComposerProject[];
  variant: 'sheet' | 'inline';
  /** Add the item. `keepOpen` (Cmd/Ctrl+Enter) means: stay, so the next one can be typed. */
  onSubmit: (keepOpen: boolean) => void;
  busy?: boolean;
  error?: string;
  autoFocus?: boolean;
  idPrefix?: string;
}) {
  const auto = useId();
  const id = idPrefix ?? auto;
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState('');
  const [over, setOver] = useState(false);
  const inline = variant === 'inline';
  const resolved = resolveDraft(draft, projects);

  // Typing is for the title; after "keep open" the box is empty and wants the next one.
  const filled = draft.title === '' && draft.details === '' && draft.files.length === 0;
  useEffect(() => {
    if (filled && !inline) titleRef.current?.focus();
  }, [filled, inline]);

  async function addFiles(list: FileList | File[]) {
    setFileError('');
    const next = [...draft.files];
    for (const f of Array.from(list)) {
      const kind = fileKind(f);
      if (!kind) {
        setFileError(`${f.name || 'That file'} can't be attached. Use an image, PDF or text file.`);
        continue;
      }
      if (next.length >= MAX_FILES) {
        setFileError(`Up to ${MAX_FILES} files.`);
        break;
      }
      try {
        const content = await readFile(f, kind);
        if (content.length > FILE_LIMIT) {
          setFileError(fileTooBigMessage(f.name || 'That file', kind, f.size, content.length));
          continue;
        }
        next.push({
          name: f.name || `pasted.${kind === 'image' ? 'png' : 'txt'}`,
          kind,
          content,
          bytes: content.length,
        });
      } catch {
        setFileError(`Could not read ${f.name || 'that file'}.`);
      }
    }
    onChange({ files: next });
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (inline) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    const text = e.clipboardData.getData('text');
    if (e.currentTarget === titleRef.current && text.includes('\n') && draft.title.trim() === '') {
      e.preventDefault();
      const { title, details } = splitPaste(text);
      onChange({ title: title.slice(0, MAX_TITLE), details: details || draft.details });
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    if (inline) return;
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  }

  function onTitleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (e.shiftKey) {
      // A second line is the details: move there instead of making the title two lines.
      if (!inline) detailsRef.current?.focus();
      return;
    }
    onSubmit(!inline && (e.metaKey || e.ctrlKey));
  }

  function onDetailsKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit(true);
    }
  }

  const canAdd = resolved.title !== '' && resolved.project !== null && !busy;
  const projectOptions = projects.map((p) => ({
    value: p.id,
    label: `${p.emoji} ${p.name}`.trim(),
  }));
  const proj = projects.find((p) => p.id === resolved.project?.id);

  const typeSelect = (
    <Select
      hideLabel
      inline
      label="Type"
      value={resolved.type}
      onValueChange={(v) => onChange({ type: v as CaptureType })}
      options={CAPTURE_TYPES.map((t) =>
        !inline && t.value === resolved.type && resolved.guessed && draft.title.trim()
          ? { ...t, label: `${t.label} · guessed` }
          : t,
      )}
    />
  );

  return (
    <form
      className={cn(inline ? 'flex flex-wrap items-start gap-2' : 'flex flex-col gap-3')}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(false);
      }}
      onDragOver={(e) => {
        if (inline) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-capture={variant}
    >
      {!inline ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            hideLabel
            inline
            label="Project"
            value={resolved.project?.id ?? ''}
            onValueChange={(v) => onChange({ projectId: v })}
            options={
              proj ? projectOptions : [{ value: '', label: 'Pick a project' }, ...projectOptions]
            }
          />
          {typeSelect}
        </div>
      ) : null}

      <div
        className={cn(
          'flex flex-col gap-1.5',
          inline && 'min-w-24 flex-1 basis-0 sm:min-w-[13.5rem]',
        )}
      >
        <label htmlFor={`${id}-title`} className="sr-only">
          {inline ? 'Add an idea, request or bug' : 'Title'}
        </label>
        <textarea
          id={`${id}-title`}
          ref={titleRef}
          rows={1}
          // The box was opened to type one thing: the title takes focus.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          value={draft.title}
          maxLength={MAX_TITLE}
          enterKeyHint="send"
          placeholder={inline ? 'Add an idea, request or bug' : 'What is it? Press Enter to add'}
          onChange={(e) => onChange({ title: e.target.value.replace(/\n/g, ' ') })}
          onKeyDown={onTitleKey}
          onPaste={onPaste}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          className={cn(
            'w-full resize-none rounded-btn bg-transparent text-ink placeholder:text-text-3 outline-hidden [field-sizing:content]',
            inline
              ? 'min-h-11 border border-line-strong bg-surface px-3 py-2.5 text-16 transition-[border-color,box-shadow] duration-120 ease-standard hov:border-text-2 foc:border-focus foc:outline-2 foc:outline-focus'
              : 'min-h-9 py-1 text-20 font-semibold leading-snug',
          )}
        />
        {!inline ? (
          <>
            <label htmlFor={`${id}-details`} className="sr-only">
              Details (optional)
            </label>
            <textarea
              id={`${id}-details`}
              ref={detailsRef}
              rows={2}
              value={draft.details}
              maxLength={20000}
              placeholder="Add details (optional)"
              onChange={(e) => onChange({ details: e.target.value })}
              onKeyDown={onDetailsKey}
              onPaste={onPaste}
              className="max-h-48 min-h-12 w-full resize-none bg-transparent text-16 leading-snug text-ink placeholder:text-text-3 outline-hidden [field-sizing:content]"
            />
          </>
        ) : null}
      </div>

      {draft.files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Files to attach">
          {draft.files.map((f: PickedFile, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex min-h-9 max-w-full items-center gap-1 rounded-btn border border-line bg-canvas py-0.5 pl-2.5 pr-0.5 text-13"
            >
              {f.kind === 'image' ? (
                <img src={f.content} alt="" className="mr-1 size-6 rounded-[4px] object-cover" />
              ) : (
                <Icon icon={Paperclip} size={14} className="text-text-2" />
              )}
              <span className="max-w-40 truncate">{f.name}</span>
              <IconButton
                label={`Remove ${f.name}`}
                className="size-8 min-h-8 min-w-8"
                onClick={() => onChange({ files: draft.files.filter((_, j) => j !== i) })}
              >
                <Icon icon={X} size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}

      {error || fileError ? (
        <p
          id={`${id}-err`}
          role="alert"
          className={cn('text-13 text-sendback', inline && 'order-last basis-full')}
        >
          {error || fileError}
        </p>
      ) : null}

      <div
        className={cn(
          'flex items-center gap-2',
          inline && 'shrink-0',
          !inline && 'justify-between',
          !inline && 'border-t border-line pt-3',
          over && 'rounded-btn outline-2 outline-dashed outline-focus',
        )}
      >
        {!inline ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept="image/*,application/pdf,text/*,.md,.json,.csv"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="flex items-center gap-1">
              <IconButton label="Attach a file" onClick={() => fileInput.current?.click()}>
                <Icon icon={Paperclip} size={20} />
              </IconButton>
              <p className="hidden text-12 text-text-2 sm:block">
                Enter adds · Cmd+Enter adds another · Shift+Enter for details · paste or drop files
              </p>
            </div>
          </>
        ) : (
          typeSelect
        )}
        <Button
          type="submit"
          variant={inline ? 'secondary' : 'primary'}
          disabled={!canAdd}
          className={cn(!inline && 'min-w-24')}
        >
          Add
        </Button>
      </div>
    </form>
  );
}
