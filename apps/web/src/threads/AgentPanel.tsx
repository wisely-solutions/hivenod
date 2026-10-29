/**
 * The agent panel of a thread (item kt3E7u9EliL3q2veDDI0, design 2.3): who worked on it and on how
 * many sources, what it read and checked (the open proposal's checks, then its notes), the
 * proposal with "When you approve, <agent> will…", the agent's question, the outcomes already
 * decided, and the related subjects. On a phone it is a bottom sheet: collapsed it shows the
 * proposal and Approve; its handle opens the rest.
 */
import type { InboxEvent, InboxMessage, InboxOutcome, InboxThread } from '@hive/shared';
import { Bot, Check, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { forwardRef, useState, type ReactNode } from 'react';
import type { Row } from '../lib/live';
import { effectLines } from '../lib/outcomes';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { ProposalPanel, QuestionPanel, type DecisionCardHandle } from '../today/DecisionCard';
import { ConfidenceMeter } from '../today/parts';
import { OutcomeCard } from './OutcomeCard';
import { RelatedSubjects } from './RelatedSubjects';

export interface AgentPanelProps {
  wid: string;
  uid: string;
  thread: Row<InboxThread>;
  proposals: Row<InboxOutcome>[];
  decided: Row<InboxOutcome>[];
  notes: Array<{ id: string; event: InboxEvent }>;
  messages: InboxMessage[];
  now: number;
  busy: ReadonlyArray<{ start: Date; end: Date }>;
  agentName: (id: string) => string;
  onDone: (label: string) => void;
  /** Phone: the panel is a bottom sheet. */
  sheet?: boolean;
}

function Block({
  title,
  children,
  label,
}: {
  title: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <section aria-label={label} className="border-t border-line px-4 py-4 first:border-t-0 sm:px-5">
      <h2 className="mb-2.5 flex items-center gap-2 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        {title}
      </h2>
      {children}
    </section>
  );
}

export const AgentPanel = forwardRef<DecisionCardHandle, AgentPanelProps>(
  function AgentPanel(props, ref) {
    const { wid, uid, thread, proposals, decided, notes, messages, now, busy, agentName } = props;
    const { onDone, sheet } = props;
    const t = thread.data;
    const [open, setOpen] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    const [shownId, setShownId] = useState<string | null>(null);
    const shown = proposals.find((p) => p.id === shownId) ?? proposals[0];
    const agent = agentName(shown?.data.proposedBy ?? t.fetchedBy);
    const sources = new Set(messages.map((m) => m.source)).size;
    const last = [...messages].reverse().find((m) => m.direction === 'in');
    const sender = last
      ? { name: last.sender.name, source: last.source, at: last.receivedAt.toMillis() }
      : null;
    const asks = t.state === 'needsYou' && t.question && !t.question.answer;
    // The phone sheet, collapsed: only the decision itself.
    const collapsed = sheet && !open;

    const head = (
      <div className="flex items-center gap-3 px-4 pt-4 sm:px-5">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-btn bg-agent text-on-solid"
        >
          <Icon icon={Bot} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-15 font-semibold text-ink">{agent}</p>
          <p className="text-13 text-text-2">
            worked on this · {sources} {sources === 1 ? 'source' : 'sources'}
          </p>
        </div>
        {shown ? <ConfidenceMeter value={shown.data.confidence} /> : null}
      </div>
    );

    const checks = shown?.data.checks ?? [];
    const read =
      checks.length || notes.length ? (
        <Block title="What I read and checked" label="What the agent checked">
          {checks.length ? (
            <ul aria-label="What the agent checked" className="flex flex-col gap-1.5">
              {checks.map((c, i) => (
                <li key={i} className="flex gap-2 text-14 text-ink">
                  <Icon icon={Check} size={15} className="mt-0.5 shrink-0 text-approve-text" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{c}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {notes.length ? (
            <div className={checks.length ? 'mt-3' : undefined}>
              <button
                type="button"
                aria-expanded={notesOpen}
                onClick={() => setNotesOpen((v) => !v)}
                className="inline-flex min-h-9 items-center gap-1 text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus"
              >
                <Icon icon={notesOpen ? ChevronDown : ChevronRight} size={14} />
                Notes ({notes.length})
              </button>
              {notesOpen ? (
                <ul className="mt-1 flex flex-col gap-2">
                  {notes.map((n) => (
                    <li
                      key={n.id}
                      className="whitespace-pre-wrap rounded-btn bg-canvas px-3 py-2 text-13 text-text-2 [overflow-wrap:anywhere]"
                    >
                      {String((n.event.data as { text?: unknown }).text ?? '')}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Block>
      ) : null;

    const effect = (o: Row<InboxOutcome>) => {
      const e = effectLines(o.data.type, o.data.fields, {
        agent: agentName(o.data.executor ?? o.data.proposedBy),
        channel: sender?.source,
        to: sender?.name.split(' ')[0],
      });
      return e.lines.length ? (
        <div data-effects="" className="mt-3 rounded-card border border-line bg-surface-2 p-3.5">
          <p className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
            {e.lead}
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {e.lines.map((l) => (
              <li key={l} className="flex gap-2 text-14 text-ink">
                <Icon icon={ChevronRight} size={14} className="mt-1 shrink-0 text-text-3" />
                <span className="min-w-0">{l}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null;
    };

    const proposal = shown ? (
      <Block
        label="Proposed"
        title={
          <>
            Proposed
            {proposals.length > 1 ? (
              <span>
                · {proposals.findIndex((p) => p.id === shown.id) + 1} of {proposals.length}
              </span>
            ) : null}
          </>
        }
      >
        <div className="-mt-3">
          <ProposalPanel
            ref={ref}
            key={thread.id}
            wid={wid}
            thread={thread}
            proposals={proposals}
            sender={sender}
            now={now}
            busy={busy}
            agentName={agentName}
            onDone={onDone}
            after={effect}
            compact={collapsed}
            narrow
            onShown={setShownId}
          />
        </div>
      </Block>
    ) : null;

    const question = asks ? (
      <Block title="Agent asks" label="Agent asks">
        <div className="-mt-3">
          <QuestionPanel wid={wid} thread={thread} agentName={agentName} onDone={onDone} />
        </div>
      </Block>
    ) : null;

    const outcomesAndRelated = (
      <>
        {decided.length ? (
          <Block title="Outcomes" label="Outcomes">
            <div className="flex flex-col gap-3">
              {decided.map((o) => (
                <OutcomeCard
                  key={o.id}
                  wid={wid}
                  oid={o.id}
                  outcome={o.data}
                  thread={t}
                  othersPending={false}
                  agentName={agentName}
                />
              ))}
            </div>
          </Block>
        ) : null}
        {t.subjectId ? (
          <div className="border-t border-line px-4 pb-4 sm:px-5 [&>section]:mt-4">
            <RelatedSubjects wid={wid} sid={t.subjectId} uid={uid} />
          </div>
        ) : null}
      </>
    );

    if (!sheet)
      return (
        <aside
          aria-label="Agent panel"
          data-agent-panel=""
          className="overflow-hidden rounded-panel border border-line bg-surface shadow-e1"
        >
          {head}
          <div className="mt-3">
            {read}
            {proposal}
            {question}
            {outcomesAndRelated}
          </div>
        </aside>
      );

    return (
      <aside
        aria-label="Agent panel"
        data-agent-panel=""
        data-sheet={open ? 'open' : 'collapsed'}
        className={cn(
          'fixed inset-x-0 z-30 flex flex-col rounded-t-panel border border-b-0 border-line bg-surface shadow-e3',
          'bottom-[calc(3.5rem+env(safe-area-inset-bottom))]',
          open ? 'max-h-[78dvh]' : 'max-h-[60dvh]',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full shrink-0 flex-col items-center justify-center gap-1 foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
        >
          <span aria-hidden className="h-1.5 w-10 rounded-full bg-line-strong" />
          <span className="inline-flex items-center gap-1 text-12 font-medium text-text-2">
            <Icon icon={open ? ChevronDown : ChevronUp} size={14} />
            {open ? 'Show less' : 'Notes, outcomes and related'}
          </span>
        </button>
        <div className="min-h-0 overflow-y-auto pb-2">
          {open ? head : null}
          {proposal}
          {question}
          {!proposal && !question && !open ? (
            <p className="px-4 pb-2 text-13 text-text-2">Nothing to decide here now.</p>
          ) : null}
          {open ? (
            <>
              {read}
              {outcomesAndRelated}
            </>
          ) : null}
        </div>
      </aside>
    );
  },
);
