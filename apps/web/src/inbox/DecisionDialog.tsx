import { useState } from 'react';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Button } from '../ui/button';
import { Textarea } from '../ui/form';
import { MIN_REASON_CHARS } from '@hive/shared';
import { cn } from '../ui/cn';
import type { Decision } from './decision';
import type { InboxEntry } from './logic';

export type DialogMode = 'approve' | 'reject' | 'dismiss';

const COPY: Record<DialogMode, { title: string; field: string; hint: string; cta: string }> = {
  approve: {
    title: 'Approve',
    field: 'Rationale (optional)',
    hint: 'Saved with the decision and visible in Decision insights.',
    cta: 'Approve',
  },
  reject: {
    title: 'Reject',
    field: 'Why are you dropping it?',
    hint: 'The item stops and leaves the flow. No agent picks it up.',
    cta: 'Reject',
  },
  dismiss: {
    title: 'Dismiss suggestion',
    field: 'Why are you dismissing it?',
    hint: 'Kept in the history, so agents learn what is not wanted.',
    cta: 'Dismiss',
  },
};

/**
 * The one sheet (phone) or dialog (desktop) for decisions that need words: approve with a
 * rationale (swipe right), reject and dismiss. Iterate uses the build 12 send-back dialog.
 */
export function DecisionDialog({
  mode,
  entry,
  initialText = '',
  nextName,
  description,
  onSubmit,
  onClose,
}: {
  mode: DialogMode | null;
  entry: InboxEntry | null;
  initialText?: string;
  nextName?: string;
  /** Replaces the item title under the heading (a decision about several items). */
  description?: string;
  onSubmit: (entry: InboxEntry, d: Decision) => string | null;
  onClose: () => void;
}) {
  const open = !!mode && !!entry;
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={
        mode ? (mode === 'approve' && nextName ? `Approve → ${nextName}` : COPY[mode].title) : ''
      }
      description={description ?? entry?.item.title}
    >
      {open && mode && entry ? (
        <Form
          key={`${mode}:${entry.key}`}
          mode={mode}
          entry={entry}
          initialText={initialText}
          nextName={nextName}
          onSubmit={onSubmit}
          onClose={onClose}
        />
      ) : null}
    </ResponsiveModal>
  );
}

function Form({
  mode,
  entry,
  initialText,
  nextName,
  onSubmit,
  onClose,
}: {
  mode: DialogMode;
  entry: InboxEntry;
  initialText: string;
  nextName?: string;
  onSubmit: (entry: InboxEntry, d: Decision) => string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | undefined>();
  const copy = COPY[mode];
  const needsReason = mode !== 'approve';
  const count = text.trim().length;
  const valid = !needsReason || count >= MIN_REASON_CHARS;

  function submit() {
    const d: Decision =
      mode === 'approve'
        ? { kind: 'approve', rationale: text }
        : mode === 'reject'
          ? { kind: 'reject', rationale: text }
          : { kind: 'dismiss', reason: text };
    const problem = onSubmit(entry, d);
    if (problem) setError(problem);
    else onClose();
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        label={copy.field}
        hint={copy.hint}
        value={text}
        error={error}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className="text-16"
        aria-describedby={needsReason ? 'decision-count' : undefined}
      />
      {needsReason ? (
        <p
          id="decision-count"
          className={cn('-mt-2 text-13 tabular-nums', valid ? 'text-text-2' : 'text-sendback')}
        >
          {count} / {MIN_REASON_CHARS} characters minimum
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant={mode === 'approve' ? 'approve' : 'sendback'}
          disabled={!valid}
        >
          {mode === 'approve' && nextName ? `Approve → ${nextName}` : copy.cta}
        </Button>
      </div>
    </form>
  );
}
