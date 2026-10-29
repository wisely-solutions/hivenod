/**
 * The decision card (item kt3E7u9EliL3q2veDDI0, design 2.2): the focused Inbox thread of the
 * Today stack, drawn in full. Who and where, the rank, the title as the headline, the proposal as
 * one sentence with the agent's confidence and its reason, for a reply_book the slot and a
 * free/busy strip, and Approve · Edit · Other · Skip. A question gets answer chips instead.
 *
 * Approve (and Reject, Ignore, Mark done) count down on the pressed button with Undo (no toast):
 * the plan is written when the window ends, then the card collapses to a one-line done row.
 */
import {
  answerQuestion,
  approveOutcome,
  closeThread,
  ignoreThread,
  outcomeType,
  rejectOutcome,
  type ActionPlan,
  type InboxOutcome,
  type InboxThread,
} from '@hive/shared';
import {
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  ChevronDown,
  CircleCheck,
  ExternalLink,
  Forward,
  ListChecks,
  MessageSquareReply,
  Pencil,
  Reply,
  Sparkles,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { Key } from '../components/DecisionBar';
import { stash } from '../lib/pendingDecisions';
import type { Row } from '../lib/live';
import type { NeedsEntry } from '../needs/logic';
import { editedFields, formValues, bandOf } from '../threads/logic';
import { FieldView } from '../threads/OutcomeCard';
import { errorText } from '../threads/parts';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Dialog, useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { waitLabel } from '../inbox/logic';
import { dayLabel, hhmm, proposalSentence, replaceSlotText, slotOptions, type Slot } from './logic';
import {
  bandEdge,
  Chip,
  ConfidenceMeter,
  OrgChip,
  RankChip,
  rankText,
  SenderAvatar,
} from './parts';

export interface DecisionCardHandle {
  approve(): void;
  edit(): void;
  reject(): void;
}

export interface DecisionCardProps {
  entry: NeedsEntry;
  org: { name: string; color: string } | null;
  area: string | null;
  sender: { name: string; source: string } | null;
  now: number;
  /** The member's calendar (busy blocks with details or not), for the slot strip. */
  busy: ReadonlyArray<{ start: Date; end: Date }>;
  agentName: (id: string) => string;
  onOpen: () => void;
  onSkip: () => void;
  /** After the window: the card's one-line done row. */
  onDone: (label: string) => void;
}

const TYPE_ICON: Record<string, LucideIcon> = {
  reply: Reply,
  reply_book: CalendarClock,
  no_reply: CircleCheck,
  make_it_work: ListChecks,
  handover: Forward,
  snooze: CalendarClock,
  nudge: MessageSquareReply,
  ignore: Ban,
};
const DONE_WORD: Record<string, string> = {
  reply: 'Sent',
  reply_book: 'Sent',
  nudge: 'Sent',
  no_reply: 'Closed',
  make_it_work: 'Approved',
  handover: 'Handed over',
  snooze: 'Snoozed',
  ignore: 'Ignored',
};

const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;
const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export const DecisionCard = forwardRef<DecisionCardHandle, DecisionCardProps>(
  function DecisionCard(props, ref) {
    const { entry } = props;
    const t = entry.thread!.data;
    return t.state === 'needsYou' ? (
      <QuestionCard {...props} />
    ) : (
      <ProposalCard {...props} ref={ref} />
    );
  },
);

/** Header shared by both cards: sender, organization, area, age, rank, the title. */
function CardHead({ props, label }: { props: DecisionCardProps; label?: string }) {
  const { entry, org, area, sender, now, onOpen } = props;
  const t = entry.thread!.data;
  const band = bandOf(t, now);
  const rank = rankText(t, band, now);
  return (
    <>
      <div className="flex items-start gap-3">
        <SenderAvatar name={sender?.name ?? t.title} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-14">
            <span className="font-semibold text-ink">{sender?.name ?? 'Inbox'}</span>
            <span className="text-13 text-text-2">
              {sender?.source ? `${sender.source} · ` : ''}
              {waitLabel(entry.since, now)} ago
            </span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {org ? <OrgChip name={org.name} color={org.color} /> : null}
            {area ? <Chip>{area}</Chip> : null}
          </div>
        </div>
        <RankChip text={rank} band={band} />
      </div>
      <h2 className="mt-3 text-16 font-semibold leading-snug text-ink sm:text-[17px]">
        <button
          type="button"
          onClick={onOpen}
          className="text-left [overflow-wrap:anywhere] hov:underline foc:outline-2 foc:outline-offset-2 foc:outline-focus"
          aria-label={label ? `${t.title || 'Untitled thread'}, ${label}` : undefined}
        >
          {t.title || 'Untitled thread'}
        </button>
      </h2>
    </>
  );
}

function shell(band: number | null, children: React.ReactNode, title: string) {
  return (
    <article
      data-decision-card=""
      aria-label={`Decision: ${title}`}
      className={cn(
        'rounded-panel border border-l-4 border-line bg-surface p-4 shadow-e2 sm:p-5',
        bandEdge(band as never),
      )}
    >
      {children}
    </article>
  );
}

const ProposalCard = forwardRef<DecisionCardHandle, DecisionCardProps>(
  function ProposalCard(props, ref) {
    const { entry, now, busy, agentName, onSkip, onDone, onOpen, sender } = props;
    const { session, actionContext, run } = useReady();
    const toast = useToast();
    const wid = entry.wid;
    const thread = entry.thread!;
    const t = thread.data;
    const proposals = entry.proposals ?? [];
    const [shownId, setShownId] = useState<string | null>(null);
    const shown: Row<InboxOutcome> | undefined =
      proposals.find((p) => p.id === shownId) ?? proposals[0];
    const key = shown ? `io:${wid}:${shown.id}` : `io:${wid}:none`;
    const counting = useCountdown(key);
    const threadCounting = useCountdown(`it:${wid}:${thread.id}`);
    const pending = counting ?? threadCounting;
    const [editing, setEditing] = useState(false);
    const [values, setValues] = useState<Record<string, string | boolean>>(() =>
      shown ? formValues(shown.data.type, shown.data.fields) : {},
    );
    const [valuesFor, setValuesFor] = useState(shown?.id);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const [moreReason, setMoreReason] = useState(false);
    if (shown && valuesFor !== shown.id) {
      setValuesFor(shown.id);
      setValues(formValues(shown.data.type, shown.data.fields));
      setEditing(false);
      setNote(null);
    }

    const type = shown ? outcomeType(shown.data.type) : null;
    const label = type?.label ?? shown?.data.type ?? '';
    const edited = shown
      ? editedFields(shown.data.type, values)
      : ({} as Record<string, string | boolean>);
    const dirty = !!shown && !sameFields(edited, shown.data.fields);
    const current = dirty ? edited : (shown?.data.fields ?? {});
    const who = sender ? firstName(sender.name) : '';

    function count(
      k: string,
      tag: string,
      plan: Pick<ActionPlan, 'ops'>,
      announce: string,
      done: string,
    ) {
      const forget = stash(session.me.uid, wid, [plan.ops], `Saved: ${done}`);
      toast.push({
        message: announce,
        duration: 5000,
        countdown: { key: k, tag, announce: `${announce}. Undo available for 5 seconds` },
        onUndo: forget,
        onCommit: () => {
          run(plan).then(
            () => {
              forget();
              onDone(done);
            },
            (e: unknown) => {
              forget();
              setError(errorText(e));
            },
          );
        },
      });
    }

    function approve() {
      const ctx = actionContext(wid);
      if (!ctx || !shown || pending) return;
      setError(null);
      let plan;
      try {
        plan = approveOutcome(ctx, {
          outcomeId: shown.id,
          outcome: shown.data,
          thread: { ...t },
          ...(dirty ? { fields: edited } : {}),
        });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      count(
        key,
        'approve',
        plan,
        `${type?.approve ?? 'Approved'}`,
        `${DONE_WORD[shown.data.type] ?? 'Approved'} · ${label}${who ? ` · ${who}` : ''}`,
      );
    }

    function reject(why: string) {
      const ctx = actionContext(wid);
      if (!ctx || !shown || pending) return;
      setError(null);
      let plan;
      try {
        plan = rejectOutcome(ctx, {
          outcomeId: shown.id,
          outcome: shown.data,
          thread: { ...t },
          reason: why,
          othersPending: proposals.length > 1,
        });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      count(key, 'reject', plan, 'Rejected', `Rejected · ${label}`);
    }

    function threadAct(kind: 'ignore' | 'close') {
      const ctx = actionContext(wid);
      if (!ctx || pending) return;
      setError(null);
      let plan;
      try {
        plan =
          kind === 'ignore'
            ? ignoreThread(ctx, { threadId: thread.id, thread: { ...t } })
            : closeThread(ctx, { threadId: thread.id, thread: { ...t } });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      count(
        `it:${wid}:${thread.id}`,
        kind,
        plan,
        kind === 'ignore' ? 'Ignored' : 'Marked done',
        `${kind === 'ignore' ? 'Ignored' : 'Done'} · ${t.title || 'thread'}`,
      );
    }

    useImperativeHandle(ref, () => ({
      approve,
      edit: () => {
        if (!pending && shown) setEditing((v) => !v);
      },
      reject: () => {
        if (!pending && shown) setRejecting(true);
      },
    }));

    // reply_book: the agent's slot plus up to two more free ones (design 3.6).
    const book = shown?.data.type === 'reply_book';
    const slots = useMemo<Slot[]>(() => {
      if (!book || !shown) return [];
      const s = Date.parse(String(shown.data.fields.start ?? ''));
      const e = Date.parse(String(shown.data.fields.end ?? ''));
      if (Number.isNaN(s) || Number.isNaN(e)) return [];
      return slotOptions({ start: new Date(s), end: new Date(e), busy, now });
    }, [book, shown, busy, now]);
    const curStart = Date.parse(String(current.start ?? ''));
    const pick = (slot: Slot) => {
      if (!shown || pending) return;
      const oldS = new Date(Date.parse(String(current.start)));
      const oldE = new Date(Date.parse(String(current.end)));
      const text = typeof values.text === 'string' ? values.text : '';
      const moved = replaceSlotText(text, oldS, oldE, slot.start, slot.end);
      setValues((v) => ({
        ...v,
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        ...(moved !== null ? { text: moved } : {}),
      }));
      if (moved === null && text && slot.start.getTime() !== oldS.getTime()) {
        setEditing(true);
        setNote(`The reply still mentions ${hhmm(oldS)}–${hhmm(oldE)}: check it.`);
      } else setNote(null);
    };

    if (!shown) return null;
    const others = proposals.filter((p) => p.id !== shown.id);
    const reasonText = shown.data.note;
    const longReason = reasonText.length > 180;
    const TypeIcon = TYPE_ICON[shown.data.type] ?? ListChecks;
    const band = bandOf(t, now);
    const menu = [
      ...others.map((p) => ({
        id: `show-${p.id}`,
        label: `Show: ${outcomeType(p.data.type)?.label ?? p.data.type}`,
        icon: ArrowRight,
        onSelect: () => setShownId(p.id),
      })),
      {
        id: 'reject',
        label: 'Reject proposal',
        icon: X,
        tone: 'danger' as const,
        onSelect: () => setRejecting(true),
      },
      { id: 'ignore', label: 'Ignore thread', icon: Ban, onSelect: () => threadAct('ignore') },
      {
        id: 'close',
        label: 'Mark done',
        icon: CircleCheck,
        onSelect: () => threadAct('close'),
      },
      { id: 'open', label: 'Open thread', icon: ExternalLink, onSelect: onOpen },
    ];

    return shell(
      band,
      <>
        <CardHead props={props} />
        <div
          data-proposal={shown.id}
          data-type={shown.data.type}
          className="mt-3 rounded-card border border-agent/25 bg-agent-soft p-3.5 sm:p-4"
        >
          <div className="flex items-center gap-2">
            <Icon icon={TypeIcon} size={16} className="text-agent" />
            <span className="font-mono text-12 font-semibold uppercase tracking-[0.08em] text-agent">
              {label}
            </span>
            {proposals.length > 1 ? (
              <span className="text-12 text-text-2">
                · {proposals.findIndex((p) => p.id === shown.id) + 1} of {proposals.length}
              </span>
            ) : null}
            <ConfidenceMeter value={shown.data.confidence} className="ml-auto" />
          </div>
          {editing ? (
            <div className="mt-3 flex flex-col gap-3">
              {Object.entries(type?.fields ?? {}).map(([k, f]) => (
                <FieldView
                  key={k}
                  name={k}
                  field={f}
                  value={values[k]}
                  editing
                  onChange={(v) => setValues((cur) => ({ ...cur, [k]: v }))}
                />
              ))}
            </div>
          ) : (
            <p
              data-sentence=""
              className="mt-2 text-15 leading-relaxed text-ink [overflow-wrap:anywhere]"
            >
              {proposalSentence(shown.data.type, current)}
            </p>
          )}
          {note ? <p className="mt-2 text-13 font-medium text-gate-text">{note}</p> : null}
          {reasonText ? (
            <div className="mt-2.5 flex gap-2 text-13 text-text-2">
              <Icon icon={Sparkles} size={14} className="mt-0.5 shrink-0 text-agent" />
              <div className="min-w-0">
                <p
                  data-reason=""
                  className={cn('[overflow-wrap:anywhere]', !moreReason && 'line-clamp-3')}
                >
                  <span className="sr-only">Why: </span>
                  {reasonText}
                </p>
                {longReason ? (
                  <button
                    type="button"
                    aria-expanded={moreReason}
                    onClick={() => setMoreReason((v) => !v)}
                    className="text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus"
                  >
                    {moreReason ? 'less' : 'more'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {book && slots.length ? (
            <SlotStrip
              slots={slots}
              chosen={curStart}
              busy={busy}
              disabled={!!pending}
              onPick={pick}
            />
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-14 text-sendback">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {pending ? (
            <UndoButton
              countdown={pending}
              variant={pending.tag === 'approve' ? 'approve' : 'sendback'}
              keyHint={<Key>Z</Key>}
            />
          ) : (
            <Button variant="approve" onClick={approve} leading={<Icon icon={Check} size={16} />}>
              {type?.approve ?? 'Approve'}
              <Key>A</Key>
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={!!pending}
            aria-pressed={editing}
            onClick={() => {
              if (editing) {
                setValues(formValues(shown.data.type, shown.data.fields));
                setNote(null);
              }
              setEditing((v) => !v);
            }}
            leading={<Icon icon={editing ? Undo2 : Pencil} size={15} />}
          >
            {editing ? 'Cancel edit' : 'Edit'}
            {editing ? null : <Key>E</Key>}
          </Button>
          <ActionMenu
            label="Other actions"
            actions={menu}
            trigger={
              <Button variant="ghost" disabled={!!pending}>
                Other
                <Icon icon={ChevronDown} size={15} />
              </Button>
            }
          />
          <Button variant="ghost" className="ml-auto" disabled={!!pending} onClick={onSkip}>
            Skip
            <Key>S</Key>
          </Button>
        </div>
        <Dialog
          open={rejecting}
          onOpenChange={(o) => {
            if (!o) setRejecting(false);
          }}
          title={`Reject ${label}?`}
          description={`${agentName(shown.data.proposedBy)} hears why, if you say.`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
              <Button
                variant="sendback"
                onClick={() => {
                  setRejecting(false);
                  reject(reason);
                  setReason('');
                }}
              >
                Reject
              </Button>
            </>
          }
        >
          <Textarea
            label="Why (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Dialog>
      </>,
      t.title,
    );
  },
);

/** The slot choices of a reply_book, and a free/busy strip of that day (08-18). */
function SlotStrip({
  slots,
  chosen,
  busy,
  disabled,
  onPick,
}: {
  slots: Slot[];
  chosen: number;
  busy: ReadonlyArray<{ start: Date; end: Date }>;
  disabled: boolean;
  onPick: (s: Slot) => void;
}) {
  const pickedSlot = slots.find((s) => s.start.getTime() === chosen) ?? slots[0]!;
  const day = new Date(pickedSlot.start);
  const from = new Date(day);
  from.setHours(8, 0, 0, 0);
  const to = new Date(day);
  to.setHours(18, 0, 0, 0);
  const span = to.getTime() - from.getTime();
  const pos = (s: Date, e: Date) => {
    const a = Math.max(s.getTime(), from.getTime());
    const b = Math.min(e.getTime(), to.getTime());
    return b > a
      ? { left: `${((a - from.getTime()) / span) * 100}%`, width: `${((b - a) / span) * 100}%` }
      : null;
  };
  const sameDay = (d: Date) => d.toDateString() === day.toDateString();
  return (
    <div className="mt-3">
      <p className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        Book · {dayLabel(day)}
      </p>
      <div role="group" aria-label="Pick a time" className="mt-2 grid grid-cols-3 gap-2">
        {slots.map((s, i) => {
          const on = s.start.getTime() === pickedSlot.start.getTime();
          return (
            <button
              key={s.start.toISOString()}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              data-slot={i}
              onClick={() => onPick(s)}
              className={cn(
                'flex min-h-11 flex-col items-start rounded-btn border px-2.5 py-1.5 text-left transition-colors duration-120',
                'foc:outline-2 foc:outline-offset-2 foc:outline-focus disabled:opacity-60',
                on
                  ? 'border-approve bg-approve-bg text-ink'
                  : 'border-line bg-surface text-ink hov:bg-canvas',
              )}
            >
              <span className="text-14 font-semibold tabular-nums">
                {hhmm(s.start)}–{hhmm(s.end)}
              </span>
              <span className="text-12 text-text-2">
                {i === 0 ? 'agent’s pick' : sameDay(s.start) ? 'free' : dayLabel(s.start)}
              </span>
            </button>
          );
        })}
      </div>
      <div
        aria-hidden
        data-freebusy=""
        className="relative mt-2 h-7 overflow-hidden rounded-btn border border-line bg-surface"
      >
        {busy.map((b, i) => {
          const p = sameDay(b.start) ? pos(b.start, b.end) : null;
          return p ? (
            <span key={i} className="absolute inset-y-1 rounded-sm bg-line-strong/40" style={p} />
          ) : null;
        })}
        {(() => {
          const p = pos(pickedSlot.start, pickedSlot.end);
          return p ? (
            <span
              className="absolute inset-y-0.5 rounded-sm border-2 border-dashed border-gate bg-gate-bg"
              style={p}
            />
          ) : null;
        })()}
        <span className="absolute bottom-0 left-1 text-[10px] text-text-3">08</span>
        <span className="absolute bottom-0 right-1 text-[10px] text-text-3">18</span>
      </div>
    </div>
  );
}

/** A question from the agent: up to 4 answer chips, or a written answer. */
function QuestionCard(props: DecisionCardProps) {
  const { entry, onDone, onSkip, agentName } = props;
  const { actionContext, run } = useReady();
  const t: InboxThread = entry.thread!.data;
  const q = t.question;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(text: string) {
    const ctx = actionContext(entry.wid);
    if (!ctx || !text.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      await run(
        answerQuestion(ctx, { threadId: entry.thread!.id, thread: { ...t }, answer: text }),
      );
      onDone(`Answered · ${t.title || 'thread'}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return shell(
    bandOf(t, props.now),
    <>
      <CardHead props={props} />
      <div className="mt-3 rounded-card border border-gate/50 bg-gate-bg p-3.5 sm:p-4">
        <p className="font-mono text-12 font-semibold uppercase tracking-[0.08em] text-gate-text">
          {q ? `${agentName(q.by)} asks` : 'Question'}
        </p>
        <p className="mt-1.5 whitespace-pre-wrap text-15 leading-relaxed text-ink [overflow-wrap:anywhere]">
          {q?.text}
        </p>
        {q?.options?.length ? (
          <div role="group" aria-label="Answers" className="mt-3 flex flex-wrap gap-2">
            {q.options.map((o) => (
              <Button
                key={o}
                variant="secondary"
                disabled={busy}
                data-chip=""
                onClick={() => void send(o)}
              >
                {o}
              </Button>
            ))}
          </div>
        ) : null}
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void send(answer);
          }}
        >
          <div className="min-w-0 flex-1">
            <Textarea
              label="Your answer"
              rows={2}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={!answer.trim()}>
            Answer
          </Button>
        </form>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" onClick={onSkip}>
          Skip
          <Key>S</Key>
        </Button>
      </div>
    </>,
    t.title,
  );
}
