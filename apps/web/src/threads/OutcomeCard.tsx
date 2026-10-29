/**
 * One outcome of a thread, drawn from the registry (packages/shared/src/outcomes.ts): its fields
 * (editable after Edit), and Approve (the registry's word: Send for a reply), Edit and Reject.
 * Approve and Reject count down on the pressed button with Undo (card eLSSIGOs), and are written
 * when the window ends. Nothing is carried out before the member's approval.
 */
import {
  approveOutcome,
  outcomeType,
  rejectOutcome,
  type InboxOutcome,
  type InboxThread,
  type OutcomeField,
} from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { stash } from '../lib/pendingDecisions';
import { Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Textarea, Toggle } from '../ui/form';
import { useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import {
  bookedText,
  confidenceText,
  editedFields,
  formValues,
  fromLocalInput,
  toLocalInput,
} from './logic';
import { errorText, when } from './parts';

const STATE_TEXT: Record<InboxOutcome['state'], string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  done: 'Done',
  failed: 'Failed',
};

export function OutcomeCard({
  wid,
  oid,
  outcome,
  thread,
  othersPending,
  agentName,
}: {
  wid: string;
  oid: string;
  outcome: InboxOutcome;
  thread: InboxThread;
  /** Other proposals of the thread still wait for the member. */
  othersPending: boolean;
  agentName: (id: string) => string;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const t = outcomeType(outcome.type);
  const key = `io:${wid}:${oid}`;
  const counting = useCountdown(key);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(() => formValues(outcome.type, outcome.fields));
  const [error, setError] = useState<string | null>(null);
  const proposed = outcome.state === 'proposed';
  const label = t?.label ?? outcome.type;

  function decide(kind: 'approve' | 'reject') {
    const ctx = actionContext(wid);
    if (!ctx) return;
    setError(null);
    let plan;
    try {
      plan =
        kind === 'approve'
          ? approveOutcome(ctx, {
              outcomeId: oid,
              outcome,
              thread: { ...thread },
              ...(editing ? { fields: editedFields(outcome.type, values) } : {}),
            })
          : rejectOutcome(ctx, {
              outcomeId: oid,
              outcome,
              thread: { ...thread },
              othersPending,
            });
    } catch (e) {
      setError(errorText(e));
      return;
    }
    const forget = stash(
      session.me.uid,
      wid,
      [plan.ops],
      kind === 'approve' ? `Saved your approval of ${label}` : `Saved your rejection of ${label}`,
    );
    const p = plan;
    toast.push({
      message: kind === 'approve' ? `${t?.approve ?? 'Approved'}.` : 'Rejected.',
      undoLabel: 'Undo',
      duration: 5000,
      countdown: {
        key,
        tag: kind,
        announce: `${kind === 'approve' ? 'Approved' : 'Rejected'}. Undo available for 5 seconds`,
      },
      onUndo: forget,
      onCommit: () => {
        run(p).then(
          () => {
            forget();
            setEditing(false);
          },
          (e: unknown) => {
            forget();
            setError(errorText(e));
          },
        );
      },
    });
  }

  const executor = outcome.executor ? agentName(outcome.executor) : '';
  const status =
    outcome.state === 'approved'
      ? executor
        ? `Approved: ${executor} carries it out`
        : 'Approved'
      : outcome.state === 'done'
        ? ''
        : outcome.state === 'failed'
          ? `Failed${outcome.result?.error ? `: ${outcome.result.error}` : ''}`
          : outcome.state === 'rejected'
            ? `Rejected${outcome.decision?.reason ? `: ${outcome.decision.reason}` : ''}`
            : '';

  return (
    <article
      data-outcome={oid}
      data-type={outcome.type}
      data-outcome-state={outcome.state}
      aria-label={`${label}, ${STATE_TEXT[outcome.state]}`}
      className={
        proposed
          ? 'rounded-card border border-gate/60 bg-surface p-4 shadow-e1'
          : 'rounded-card border border-line bg-surface p-4'
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-14 font-semibold text-ink">{label}</h3>
        <Pill tone={proposed ? 'gate' : outcome.state === 'done' ? 'approve' : 'neutral'}>
          {STATE_TEXT[outcome.state]}
        </Pill>
        <span className="ml-auto text-13 text-text-2">
          {agentName(outcome.proposedBy)} · {when(outcome.createdAt.toMillis())}
        </span>
      </div>
      {outcome.note ? <p className="mb-3 text-14 text-text-2">{outcome.note}</p> : null}
      <Confidence value={outcome.confidence} />
      {outcome.checks?.length ? (
        <ul data-checks="" aria-label="What the agent checked" className="mb-3 flex flex-col gap-1">
          {outcome.checks.map((c, i) => (
            <li key={i} className="flex gap-2 text-13 text-text-2">
              <span aria-hidden="true" className="text-approve-text">
                ✓
              </span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-3">
        {Object.entries(t?.fields ?? {}).map(([k, f]) => (
          <FieldView
            key={k}
            name={k}
            field={f}
            value={editing ? values[k] : outcome.fields[k]}
            editing={editing && proposed}
            onChange={(v) => setValues((cur) => ({ ...cur, [k]: v }))}
          />
        ))}
      </div>
      {status ? <p className="mt-3 text-14 text-text-2">{status}</p> : null}
      {outcome.type === 'reply_book' &&
      (outcome.state === 'approved' || outcome.state === 'done') ? (
        <p data-booked="" className="mt-2 text-14 font-medium text-approve-text">
          {bookedText(outcome.fields)}
        </p>
      ) : null}
      {outcome.state === 'done' && outcome.result?.permalink ? (
        <a
          href={outcome.result.permalink}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-14 font-medium text-agent hover:underline"
        >
          Open what was sent
        </a>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {error}
        </p>
      ) : null}
      {proposed ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {counting?.tag === 'approve' ? (
            <UndoButton countdown={counting} variant="approve" />
          ) : (
            <Button variant="approve" disabled={!!counting} onClick={() => decide('approve')}>
              {t?.approve ?? 'Approve'}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={!!counting}
            aria-pressed={editing}
            onClick={() => {
              if (editing) setValues(formValues(outcome.type, outcome.fields));
              setEditing((v) => !v);
            }}
          >
            {editing ? 'Cancel edit' : 'Edit'}
          </Button>
          {counting?.tag === 'reject' ? (
            <UndoButton countdown={counting} variant="sendback" />
          ) : (
            <Button variant="sendback" disabled={!!counting} onClick={() => decide('reject')}>
              Reject
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}

const BARS = { high: 3, medium: 2, low: 1 } as const;

/** How sure the agent is: a word plus a 3-bar meter; nothing for older outcomes. */
function Confidence({ value }: { value: InboxOutcome['confidence'] }) {
  const word = confidenceText(value);
  if (!word || !value) return null;
  const n = BARS[value];
  return (
    <p data-confidence={value} className="mb-2 flex items-center gap-2 text-13 text-text-2">
      <span className="font-medium text-ink">{word}</span>
      <span aria-hidden="true" className="flex items-end gap-0.5">
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={`inline-block w-1 rounded-sm ${i <= n ? 'bg-agent' : 'bg-line-strong'}`}
            style={{ height: 4 + i * 3 }}
          />
        ))}
      </span>
    </p>
  );
}

export function FieldView({
  name,
  field,
  value,
  editing,
  onChange,
}: {
  name: string;
  field: OutcomeField;
  value: string | boolean | undefined;
  editing: boolean;
  onChange: (v: string | boolean) => void;
}) {
  if (editing) {
    if (field.kind === 'boolean')
      return <Toggle label={field.label} checked={value === true} onCheckedChange={onChange} />;
    if (field.kind === 'text')
      return (
        <Textarea
          label={field.label}
          name={name}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    if (field.kind === 'datetime')
      return (
        <Input
          label={field.label}
          name={name}
          type="datetime-local"
          value={typeof value === 'string' ? toLocalInput(value) : ''}
          onChange={(e) => onChange(fromLocalInput(e.target.value))}
        />
      );
    return (
      <Input
        label={field.label}
        name={name}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (value === undefined || value === '' || value === false) return null;
  return (
    <div data-field={name}>
      <div className="text-13 font-medium text-text-2">{field.label}</div>
      {field.kind === 'boolean' ? (
        <div className="text-14 text-ink">Yes</div>
      ) : field.kind === 'datetime' && typeof value === 'string' ? (
        <div className="text-14 text-ink">{when(Date.parse(value))}</div>
      ) : (
        <div className="whitespace-pre-wrap text-14 text-ink [overflow-wrap:anywhere]">
          {String(value)}
        </div>
      )}
    </div>
  );
}
