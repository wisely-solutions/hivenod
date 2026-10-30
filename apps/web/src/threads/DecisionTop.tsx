/**
 * The decision page's top card (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 3.1-3.2): the kicker
 * (which of the six states the thread is in), the ask or headline, the one-line answer, the
 * recommendation with its confidence, the person-step buttons that exist today (a proposal's
 * Approve / Edit / Ask for changes, a plan's Approve plan, a gate's Approve, Retry / Skip / Stop
 * on a blocked plan, a question's answers), and the freshness line with the version history.
 * Without a summary it falls back to the proposal, the gate or the question (never empty).
 */
import {
  outcomeType,
  planView,
  scheduleSchema,
  schedulePaths,
  recheckable,
  staleReason,
  stepSilentText,
  type InboxMessage,
  type InboxOutcome,
  type InboxPlan,
  type InboxThread,
} from '@hive/shared';
import {
  Check,
  ChevronRight,
  Clock,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { useLiveDoc, type Row } from '../lib/live';
import { effectLines } from '../lib/outcomes';
import { ProposalPanel, QuestionPanel, type DecisionCardHandle } from '../today/DecisionCard';
import { Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { UndoButton } from '../ui/UndoButton';
import { AskAgent } from './AskAgent';
import { freshness, quietFor, topState, type ShownSummary, type TopTone } from './decision';
import {
  firstFree,
  keepGreenRecheck,
  type KeepGreenRecheck,
  planInputOf,
  planLive,
  planMain,
  sendBackChoices,
  stepTitle,
} from './plan';
import { GateAsk } from './GateAsk';
import { ActionMenu, type MenuAction } from '../ui/menu';
import { RecheckButton, useRecheck } from './Recheck';
import { SchedulePanel } from './SchedulePanel';
import { scheduleCard } from './schedule';
import { SummaryVersions } from './SummaryVersions';
import { usePlanActions } from './usePlanActions';
import { askOf } from '../needs/logic';
import { NotNowButton, useNotNow } from './NotNow';

export interface AgentInfo {
  name: string;
  online: boolean;
  lastSeen: number | null;
  cliVersion: string | null;
}

export interface DecisionTopProps {
  wid: string;
  uid: string;
  thread: Row<InboxThread>;
  summary: ShownSummary | null;
  /** Open single proposals, oldest first. */
  proposals: Row<InboxOutcome>[];
  /** The plan on show (the live one, else the latest). */
  plan: Row<InboxPlan> | null;
  outcomes: Row<InboxOutcome>[];
  messages: InboxMessage[];
  now: number;
  agentName: (id: string) => string;
  agent: AgentInfo;
  onDone: (label: string) => void;
  /** A phone: the proposal without its reason and effects (they go to More detail), so the
   * buttons stay in reach. */
  compact?: boolean;
}

/** "When you approve, <agent> will: …" for a proposal. */
export function ProposalEffects({
  outcome: o,
  agentName,
  sender,
}: {
  outcome: Row<InboxOutcome>;
  agentName: (id: string) => string;
  sender: { name: string; source: string } | null;
}) {
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
}

const CARD: Record<TopTone, string> = {
  gate: 'border-gate bg-gate-bg',
  agent: 'border-line bg-surface border-l-4 border-l-agent',
  sendback: 'border-sendback-border bg-sendback-bg',
  approve: 'border-line bg-surface border-l-4 border-l-approve',
  neutral: 'border-line bg-surface',
};
const KICKER: Record<TopTone, string> = {
  gate: 'text-gate-text',
  agent: 'text-agent',
  sendback: 'text-sendback',
  approve: 'text-approve-text',
  neutral: 'text-text-2',
};
const MARK: Record<TopTone, string> = {
  gate: '⏸',
  agent: '●',
  sendback: '■',
  approve: '✓',
  neutral: '·',
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The top card. Its handle approves (A) and asks for changes (C) where that exists. */
export const DecisionTop = forwardRef<DecisionCardHandle, DecisionTopProps>(
  function DecisionTop(props, ref) {
    const { wid, thread, summary, proposals, plan, outcomes, messages, now, agentName } = props;
    const t = thread.data;
    const agent = props.agent.name;
    const pl = plan ? planInputOf(plan, outcomes) : null;
    const view = pl ? planView(pl.plan, pl.outcomes) : null;
    const live = plan ? planLive(plan.data.state) : false;
    const main = pl && live ? planMain(pl) : null;
    const cur = view?.current ? outcomes.find((o) => o.id === view.current!.outcomeId) : undefined;
    const gateRow =
      main?.kind === 'step' && main.gate
        ? outcomes.find((o) => o.id === main.outcomeId)
        : undefined;
    const stepRow =
      main?.kind === 'step' && !main.gate
        ? outcomes.find((o) => o.id === main.outcomeId)
        : undefined;
    const top = topState({
      thread: {
        state: t.state,
        question: t.question ? { text: t.question.text, answer: t.question.answer } : null,
        waiting: t.waiting,
        updatedAt: t.updatedAt.toMillis(),
      },
      plan: view
        ? {
            view,
            main,
            label: gateRow ? str(gateRow.data.fields.what) || null : null,
            error:
              cur?.data.result?.error ??
              (plan!.data.state === 'blocked' && plan!.data.sentBack
                ? `sent back ${plan!.data.sentBack.n} times, waiting for you`
                : null),
          }
        : null,
      proposals: main ? 0 : proposals.length,
      agent,
    });
    const asks = top.kind === 'person' || top.kind === 'question';
    // A schedule proposal goes first (slice 6): it has its own card even when another proposal
    // waits next to it; the others show once it is decided.
    const shownProposal =
      top.kind === 'person' && !main
        ? (proposals.find((p) => p.data.type === 'schedule') ?? proposals[0])
        : undefined;
    // A schedule proposal (scheduled tasks, slice 5) has a card of its own.
    const scheduleProposal = shownProposal?.data.type === 'schedule' ? shownProposal : undefined;
    const kicker =
      scheduleProposal && proposals.length === 1 ? 'Your approval · new schedule' : top.kicker;
    // Its ask names the schedule (the panel listens to the same doc: one read).
    const schedLive = useLiveDoc(
      scheduleProposal && typeof scheduleProposal.data.fields.scheduleId === 'string'
        ? schedulePaths.schedule(wid, scheduleProposal.data.fields.scheduleId)
        : null,
      scheduleSchema,
    );
    const schedAsk =
      schedLive.state === 'ready' && schedLive.data ? scheduleCard(schedLive.data, now).ask : null;

    // The headline: the summary's ask while something waits, else its headline; without one,
    // the app's own line (design 4.3), never nothing.
    let fallback = t.title || 'Untitled thread';
    if (top.kind === 'question' && t.question) fallback = t.question.text;
    else if (gateRow)
      fallback = str(gateRow.data.fields.what) || stepTitle('approval', gateRow.data.fields);
    else if (main?.kind === 'approvePlan' && view)
      fallback = `${agentName(plan!.data.proposedBy)} proposes a plan of ${view.total} steps`;
    else if (stepRow) fallback = stepTitle(stepRow.data.type, stepRow.data.fields);
    else if (scheduleProposal)
      fallback =
        schedAsk ?? `Set up the schedule ${agentName(scheduleProposal.data.proposedBy)} proposes?`;
    else if (shownProposal)
      fallback = `${agentName(shownProposal.data.proposedBy)} proposes: ${outcomeType(shownProposal.data.type)?.label ?? shownProposal.data.type}`;
    else if (top.kind === 'blocked' && cur)
      fallback = `${stepTitle(cur.data.type, cur.data.fields)}: failed`;
    else if (top.kind === 'working' && cur) fallback = stepTitle(cur.data.type, cur.data.fields);
    const headline = summary ? (asks && summary.ask ? summary.ask : summary.headline) : fallback;
    const answered =
      t.question?.answer && top.kind !== 'question' ? `You answered: “${t.question.answer}”` : null;
    const answer = summary?.answer ?? answered;

    const fresh = freshness({
      summary: summary ? { version: summary.version, at: summary.at.toMillis() } : null,
      updatedAt: t.updatedAt.toMillis(),
      now,
      agent: props.agent,
    });

    // Plan actions at the top (the rail has the same, on the same countdown).
    const acts = usePlanActions(wid, thread, pl ?? EMPTY_PLAN);
    // Not now (slice 3): what waits now, as Today and the notifier see it.
    const open = outcomes.filter((o) => o.data.state === 'proposed' || o.data.state === 'revising');
    const ask = asks ? askOf(thread, live ? plan : null, open) : null;
    const nn = useNotNow(wid, thread, ask);
    const notNow = <NotNowButton nn={nn} className="max-sm:w-full" />;
    const panelRef = useRef<DecisionCardHandle>(null);
    // Ask for changes on a gate (slice 6): back to an earlier step, with the text.
    const [gateAsk, setGateAsk] = useState(false);
    const gateBack =
      main?.kind === 'step' && main.gate && pl ? sendBackChoices(pl, main.index) : null;
    // Keep green (slice 6c): main moved while Ship it? waits; the agent re-greens the PR.
    const recheck =
      main?.kind === 'step' && main.gate && pl
        ? keepGreenRecheck(pl.plan.steps, outcomes, main.index)
        : null;
    // A plan blocked by a failed step (slice 6c: Keep green gave up) may go back to Build.
    const blockedBack =
      top.kind === 'blocked' && pl && live && cur?.data.state === 'failed' && view?.current
        ? sendBackChoices(pl, view.current.index)
        : null;
    useImperativeHandle(ref, () => ({
      approve: () => {
        if (panelRef.current) panelRef.current.approve();
        else if (main?.kind === 'approvePlan') acts.approveAll();
        else if (main?.kind === 'step' && main.gate && view)
          acts.gate(view.steps[main.index]!, true, summary?.version);
      },
      edit: () => panelRef.current?.edit(),
      reject: () => panelRef.current?.reject(),
      ask: () => {
        if (panelRef.current) return panelRef.current.ask?.() ?? false;
        if (gateBack?.target === null || !gateBack) return false;
        setGateAsk(true);
        return true;
      },
      notNow: () => void nn.notNow(),
    }));

    // Re-check and Ask the agent (items bmNoI, w6O2K): under the top card.
    const rc = useRecheck(wid, thread, now);
    const instructions = Object.keys(t.instructions ?? {}).length > 0;
    // Open by default when nothing waits for the member (asking is then the main action).
    const [askToggle, setAskOpen] = useState<boolean | null>(null);
    const askOpen = askToggle ?? (instructions || !asks);
    const staleStep =
      !!pl &&
      live &&
      outcomes.some(
        (o) =>
          pl.plan.steps.includes(o.id) &&
          recheckable(o.id, o.data, { plan: pl.plan }) &&
          staleReason(o.data, t, now) !== null,
      );

    const last = [...messages].reverse().find((m) => m.direction === 'in');
    const sender = last
      ? { name: last.sender.name, source: last.source, at: last.receivedAt.toMillis() }
      : null;
    const effect = (o: Row<InboxOutcome>) => (
      <ProposalEffects outcome={o} agentName={agentName} sender={sender} />
    );

    let widget: ReactNode = null;
    if (top.kind === 'blocked' && pl && live) {
      // Blocked by its third send back (slice 6): the step is approved, not failed: go on or stop.
      const failed = cur?.data.state === 'failed';
      const back = blockedBack && blockedBack.target !== null ? blockedBack : null;
      widget = (
        <>
          <Row3 counting={acts.counting}>
            <Button variant="approve" data-retry="" className="max-sm:w-full" onClick={acts.retry}>
              {failed ? 'Retry' : 'Go on'}
            </Button>
            {failed ? (
              <Button
                variant="secondary"
                data-skip=""
                className="max-sm:w-full"
                onClick={acts.skip}
              >
                Skip
              </Button>
            ) : null}
            {back ? (
              <Button
                variant="secondary"
                data-blocked-send-back=""
                aria-expanded={gateAsk}
                className="max-sm:w-full"
                onClick={() => setGateAsk(!gateAsk)}
              >
                Send back to{' '}
                {back.choices
                  .find((c) => c.index === back.target)
                  ?.label.replace(/^Step \d+: /, '') ?? 'an earlier step'}
              </Button>
            ) : null}
            <Button variant="sendback" data-stop="" className="max-sm:w-full" onClick={acts.stop}>
              Stop plan
            </Button>
          </Row3>
          {gateAsk && back && back.target !== null && !acts.counting ? (
            <GateAsk
              choices={back.choices}
              target={back.target}
              sentBefore={plan?.data.sentBack?.n ?? 0}
              agent={agent}
              onCancel={() => setGateAsk(false)}
              onSend={(reason, to) => {
                setGateAsk(false);
                acts.sendBack(reason, to);
              }}
            />
          ) : null}
        </>
      );
    } else if (top.kind === 'question') {
      widget = (
        <div className="-mt-1">
          <QuestionPanel
            wid={wid}
            thread={thread}
            agentName={agentName}
            onDone={props.onDone}
            bare={headline === t.question?.text}
          />
          <div className="mt-2 flex">{notNow}</div>
        </div>
      );
    } else if (main?.kind === 'approvePlan') {
      widget = (
        <Row3 counting={acts.counting}>
          <Button
            variant="approve"
            data-approve-plan=""
            className="max-sm:w-full"
            onClick={acts.approveAll}
            leading={<Icon icon={Check} size={16} />}
          >
            Approve plan
          </Button>
          {notNow}
          <MoreDecisions
            actions={[
              {
                id: 'reject-plan',
                label: 'Reject plan',
                tone: 'danger',
                onSelect: acts.rejectAll,
              },
            ]}
          />
        </Row3>
      );
    } else if (main?.kind === 'step' && main.gate && view) {
      const s = view.steps[main.index]!;
      const detail = gateRow ? str(gateRow.data.fields.detail) : '';
      widget = (
        <>
          {detail ? (
            <p className="mt-2 whitespace-pre-wrap text-14 text-text-2 [overflow-wrap:anywhere]">
              {detail}
            </p>
          ) : null}
          {recheck ? <KeepGreenNote recheck={recheck} agent={agent} /> : null}
          <Row3 counting={acts.counting}>
            <Button
              variant="approve"
              data-gate-approve=""
              className="max-sm:w-full"
              onClick={() => acts.gate(s, true, summary?.version)}
              leading={<Icon icon={Check} size={16} />}
            >
              {recheck ? 'Approve anyway' : 'Approve'}
            </Button>
            <Button
              variant="secondary"
              data-gate-ask-open=""
              aria-expanded={gateBack?.target !== null ? gateAsk : askOpen}
              className="max-sm:w-full"
              onClick={() => (gateBack?.target !== null ? setGateAsk(!gateAsk) : setAskOpen(true))}
            >
              Ask for changes
            </Button>
            {notNow}
            <MoreDecisions
              actions={[
                {
                  id: 'not-approved',
                  label: 'Not approved: stop the plan',
                  tone: 'danger',
                  onSelect: () => acts.gate(s, false),
                },
              ]}
            />
          </Row3>
          {gateAsk && gateBack && gateBack.target !== null && !acts.counting ? (
            <GateAsk
              choices={gateBack.choices}
              target={gateBack.target}
              sentBefore={plan?.data.sentBack?.n ?? 0}
              agent={agent}
              onCancel={() => setGateAsk(false)}
              onSend={(reason, to) => {
                setGateAsk(false);
                acts.sendBack(reason, to);
              }}
            />
          ) : null}
        </>
      );
    } else if (stepRow && pl && view) {
      const free = firstFree(pl);
      widget = (
        <ProposalPanel
          ref={panelRef}
          wid={wid}
          thread={thread}
          proposals={[stepRow]}
          sender={sender}
          now={now}
          agentName={agentName}
          onDone={() => undefined}
          plan={pl}
          recheckUi={false}
          noEditKey
          extra={notNow}
          onRemove={
            main?.kind === 'step' && main.index >= free && view.total > 1
              ? () => acts.edit({ op: 'remove', index: main.index }, 'Step removed')
              : undefined
          }
        />
      );
    } else if (scheduleProposal) {
      widget = (
        <SchedulePanel
          ref={panelRef}
          key={scheduleProposal.id}
          wid={wid}
          thread={thread}
          outcome={scheduleProposal}
          now={now}
          agentName={agentName}
          onDone={props.onDone}
          extra={notNow}
          othersPending={proposals.length > 1}
        />
      );
    } else if (shownProposal) {
      widget = (
        <ProposalPanel
          ref={panelRef}
          key={thread.id}
          wid={wid}
          thread={thread}
          proposals={proposals}
          sender={sender}
          now={now}
          agentName={agentName}
          onDone={props.onDone}
          after={props.compact ? undefined : effect}
          compact={props.compact}
          noEditKey
          extra={notNow}
        />
      );
    }

    const rec = summary?.recommendation;
    const conf = summary?.confidence;
    return (
      <section
        aria-label="Decision"
        id={
          top.kind === 'question' ? 'agent-asks' : top.kind === 'person' ? 'proposed' : 'decision'
        }
        data-top={top.kind}
        className={cn(
          'mt-4 scroll-mt-20 rounded-panel border-2 p-4 shadow-e1 sm:p-5',
          CARD[top.tone],
        )}
      >
        <p
          className={cn(
            'font-mono text-12 font-semibold uppercase tracking-[0.08em] [overflow-wrap:anywhere]',
            KICKER[top.tone],
          )}
        >
          <span aria-hidden>{MARK[top.tone]} </span>
          <span data-kicker="">{kicker}</span>
        </p>
        <h2
          data-headline=""
          className="mt-1.5 text-20 font-semibold leading-snug text-ink [overflow-wrap:anywhere]"
        >
          {headline}
        </h2>
        {answer ? (
          <p data-answer="" className="mt-1 text-15 text-ink [overflow-wrap:anywhere]">
            {answer}
          </p>
        ) : null}
        {rec || conf ? (
          <p data-recommends="" className="mt-2 text-14 text-text-2 [overflow-wrap:anywhere]">
            {rec ? (
              <>
                {agent} recommends{' '}
                <strong className="font-semibold text-approve-text">{rec.action}</strong>
              </>
            ) : null}
            {conf ? `${rec ? ' · ' : ''}confidence ${conf}` : null}
            {rec ? ` · ${rec.why}` : null}
          </p>
        ) : null}
        {widget ? <div className="mt-1">{widget}</div> : null}
        {top.kind === 'working' && cur ? (
          <LongProgress outcome={cur.data} now={now} agent={agent} />
        ) : null}
        {top.kind === 'working' && cur && stepSilentText(cur.data, now) ? (
          // Reach out (item KZ6O9): the agent did not answer Hivenod's status request.
          <p className="mt-3">
            <Pill tone="sendback" data-testid="silence-flag">
              <Icon icon={Clock} size={12} />
              {stepSilentText(cur.data, now)}
            </Pill>
          </p>
        ) : null}
        {nn.error ? (
          <p role="alert" className="mt-3 text-14 text-sendback">
            {nn.error}
          </p>
        ) : null}
        {acts.error && pl ? (
          <p role="alert" className="mt-3 text-14 text-sendback">
            {acts.error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-text-2">
          {summary && fresh.updated ? (
            <>
              <span data-updated="">{fresh.updated}</span>
              <span aria-hidden>·</span>
              <SummaryVersions
                wid={wid}
                uid={props.uid}
                tid={thread.id}
                current={summary}
                label={fresh.version!}
              />
            </>
          ) : (
            <span data-updated="none">No summary yet</span>
          )}
          {fresh.stale ? (
            <span
              data-summary-stale=""
              className="inline-flex items-center gap-1 font-medium text-gate-text"
            >
              <Icon icon={TriangleAlert} size={14} />
              {fresh.stale}
            </span>
          ) : null}
          {fresh.why ? (
            <span data-why="" className="basis-full text-text-2">
              {fresh.why}
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
          <Button
            variant="ghost"
            className="min-h-9 px-2 text-agent"
            aria-expanded={askOpen}
            aria-controls="ask-agent"
            onClick={() => setAskOpen(!askOpen)}
            leading={<Icon icon={MessageSquare} size={15} />}
          >
            Ask {agent}…
          </Button>
          {rc.can || rc.counting?.tag === 'top' ? (
            <RecheckButton rc={rc} tag="top" variant="ghost" className="min-h-9 px-2" />
          ) : null}
        </div>
        {askOpen ? (
          <section
            id="ask-agent"
            aria-label="Ask the agent"
            className="mt-2 rounded-card border border-line bg-surface p-3.5"
          >
            <AskAgent
              wid={wid}
              thread={thread}
              outcomes={outcomes}
              messages={messages}
              livePlan={live}
              staleStep={staleStep}
              now={now}
              agent={agent}
              rc={rc}
            />
          </section>
        ) : null}
      </section>
    );
  },
);

const EMPTY_PLAN = {
  planId: '-',
  plan: { memberUid: '', threadId: '', steps: [], cursor: 0, state: 'stopped' as const },
  outcomes: {},
};

/**
 * A long step being worked on (slice 6b): the agent's last progress line and percent, and a
 * warning when it has been quiet for an hour (a new session of the agent picks the step up).
 */
function LongProgress({
  outcome,
  now,
  agent,
}: {
  outcome: InboxOutcome;
  now: number;
  agent: string;
}) {
  if (outcome.state !== 'running' || outcomeType(outcome.type)?.long !== true) return null;
  const p = outcome.progress;
  const beat = Math.max(p?.at.toMillis() ?? 0, outcome.updatedAt.toMillis());
  const quiet = quietFor(beat, now);
  return (
    <div data-long-progress="" className="mt-3">
      {p ? (
        <>
          <p data-progress-line="" className="text-14 text-ink [overflow-wrap:anywhere]">
            {p.line}
            {p.percent !== null ? <span className="text-text-2"> · {p.percent}%</span> : null}
          </p>
          {p.percent !== null ? (
            <div
              role="progressbar"
              aria-label="Progress"
              aria-valuenow={p.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
            >
              <div className="h-full bg-agent" style={{ width: `${p.percent}%` }} />
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-14 text-text-2">Started: no progress reported yet.</p>
      )}
      {quiet ? (
        <p
          data-quiet=""
          className="mt-2 inline-flex items-center gap-1 text-13 font-medium text-gate-text"
        >
          <Icon icon={TriangleAlert} size={14} />
          {agent} quiet for {quiet}: a new session of {agent} picks this step up again.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Keep green while Ship it? waits (slice 6c): main moved and the agent is re-greening the pull
 * request, or it cannot. Approve stays possible (my call: the member decides, and Release
 * rebases and re-checks again before it merges); it reads "Approve anyway".
 */
function KeepGreenNote({ recheck, agent }: { recheck: KeepGreenRecheck; agent: string }) {
  const blocked = recheck.check === 'blocked';
  return (
    <div
      data-keepgreen-recheck={recheck.check}
      role="status"
      className={cn(
        'mt-3 rounded-card border p-3',
        blocked ? 'border-sendback-border bg-sendback-bg' : 'border-line bg-surface-2',
      )}
    >
      <p
        className={cn(
          'inline-flex items-center gap-1.5 text-14 font-semibold',
          blocked ? 'text-sendback' : 'text-agent',
        )}
      >
        <Icon icon={blocked ? TriangleAlert : RefreshCw} size={15} />
        {blocked ? 'Keep green is stuck' : 'Re-checking after main moved'}
      </p>
      <p data-keepgreen-line="" className="mt-1 text-14 text-ink [overflow-wrap:anywhere]">
        {recheck.line}
      </p>
      <p className="mt-1 text-13 text-text-2">
        {blocked
          ? `${agent} cannot re-green it. Ask for changes sends it back to Build; Approve anyway leaves it to Release.`
          : `${agent} is rebasing and re-running the checks. You can approve now: Release rebases and re-checks again before it merges.`}
      </p>
    </div>
  );
}

/** The decisions that leave the plan (Not approved, Reject plan): out of the way, in a ⋯ menu. */
function MoreDecisions({ actions }: { actions: MenuAction[] }) {
  return (
    <ActionMenu
      label="More decisions"
      actions={actions}
      trigger={
        <Button
          variant="ghost"
          data-more-decisions=""
          aria-label="More decisions"
          className="min-h-11 px-3 max-sm:w-full"
          leading={<Icon icon={MoreHorizontal} size={18} />}
        >
          <span className="sm:sr-only">More</span>
        </Button>
      }
    />
  );
}

/** A row of decision buttons (full width on a phone, Approve first); Undo while counting down. */
function Row3({
  counting,
  children,
}: {
  counting: ReturnType<typeof usePlanActions>['counting'];
  children: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      {counting ? <UndoButton countdown={counting} variant="approve" /> : children}
    </div>
  );
}
