/**
 * Subject labels (item YaOErIjeIFG8Y3EvZuIp): the kind of request (Sales, Support, ...). The agent
 * suggests one on a new subject; it shows as a dashed "Sales?" chip with OK and Change until the
 * person confirms or changes it. Area (a client, a topic) is a different thing and is untouched.
 */
import {
  DEFAULT_INBOX_LABELS,
  inboxLabelsSchema,
  inboxPaths,
  setSubjectLabel,
  type InboxSubject,
} from '@hive/shared';
import { Check, ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { useLiveDoc } from '../lib/live';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { errorText } from './parts';

/** An organization's label list: the admin's, else the defaults. */
export function useLabelList(wid: string): { labels: readonly string[]; custom: boolean } {
  const live = useLiveDoc(inboxPaths.labels(wid), inboxLabelsSchema);
  return useMemo(
    () =>
      live.state === 'ready' && live.data
        ? { labels: live.data.labels, custom: true }
        : { labels: DEFAULT_INBOX_LABELS, custom: false },
    [live],
  );
}

const CHIP =
  'inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-12 font-semibold leading-none';

/** The label as a read-only chip; dashed with a "?" while it is still the agent's guess. */
export function LabelBadge({
  label,
  suggested,
  className,
}: {
  label: string;
  suggested: boolean;
  className?: string;
}) {
  return (
    <span
      data-label-chip={label}
      data-suggested={suggested ? '' : undefined}
      title={suggested ? 'Suggested by the agent' : undefined}
      className={cn(
        CHIP,
        suggested
          ? 'border-dashed border-agent/60 bg-agent-soft text-agent'
          : 'border-line-strong bg-canvas text-ink',
        className,
      )}
    >
      {label}
      {suggested ? <span aria-hidden>?</span> : null}
      {suggested ? <span className="sr-only"> (suggested)</span> : null}
    </span>
  );
}

/**
 * The person's own label control on a subject: OK and Change on a suggestion, a menu on a
 * confirmed label. Changes save at once; there is nothing to undo, as picking again changes it.
 */
export function LabelChip({
  wid,
  subjectId,
  subject,
  withAdd = false,
}: {
  wid: string;
  subjectId: string;
  subject: Pick<InboxSubject, 'memberUid' | 'name' | 'label' | 'labelSuggested'>;
  /** Also offer "Add label" when the subject has none (the subject page). */
  withAdd?: boolean;
}) {
  const { actionContext, run } = useReady();
  const { labels } = useLabelList(wid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = subject.label?.trim() || null;
  const suggested = Boolean(label) && subject.labelSuggested === true;

  async function save(next: string) {
    setError(null);
    const ctx = actionContext(wid);
    if (!ctx) return;
    setBusy(true);
    try {
      await run(
        setSubjectLabel(ctx, {
          subjectId,
          subject,
          label: next,
          labels: [...labels],
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const choices = labels.map((l) => ({
    id: `label-${l}`,
    label: l,
    onSelect: () => void save(l),
  }));
  const actions = label
    ? [...choices, { id: 'label-none', label: 'No label', onSelect: () => void save('') }]
    : choices;

  if (!label && !withAdd) return null;
  const change = (
    <button
      type="button"
      disabled={busy}
      aria-label={label ? `Change label, now ${label}` : 'Add label'}
      className={cn(
        CHIP,
        'min-h-11 border-line-strong bg-surface text-text-2 hover:text-ink foc:outline-2 foc:outline-focus sm:min-h-6',
      )}
    >
      {label ? 'Change' : 'Add label'}
      <Icon icon={ChevronDown} size={12} />
    </button>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-label-control>
      {label ? <LabelBadge label={label} suggested={suggested} /> : null}
      {suggested ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(label!)}
          aria-label={`Confirm label ${label}`}
          className={cn(
            CHIP,
            'min-h-11 border-approve/40 bg-approve-bg text-approve-text foc:outline-2 foc:outline-focus sm:min-h-6',
          )}
        >
          <Icon icon={Check} size={12} /> OK
        </button>
      ) : null}
      <ActionMenu trigger={change} label="Labels" actions={actions} />
      {error ? (
        <span role="alert" className="text-12 text-sendback">
          {error}
        </span>
      ) : null}
    </span>
  );
}
