/**
 * The decision card (item kt3E7u9EliL3q2veDDI0, design 2.2): the focused Inbox thread of the
 * Today stack, drawn in full. Who and where, the rank, the title as the headline, the proposal as
 * one sentence with the agent's confidence and its reason, and Approve · Edit · Other · Skip. A question gets answer chips instead.
 *
 * Approve (and Reject, Ignore, Mark done) count down on the pressed button with Undo (no toast):
 * the plan is written when the window ends, then the card collapses to a one-line done row.
 */
import {
  answerQuestion,
  approveOutcome,
  cancelRevision,
  closeThread,
  ignoreThread,
  INBOX_LIMITS,
  outcomeType,
  rejectOutcome,
  requestRevision,
  REVISABLE_TYPES,
  versionCount,
  type ActionPlan,
  planView,
  type InboxOutcome,
  type InboxPlan,
  type InboxThread,
  type PlanInput,
  isRetiredOutcome,
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
  MessageSquare,
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Reply,
  SkipForward,
  Sparkles,
  Undo2,
  X,
  type LucideIcon,
  User,
  Zap,
} from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { swipeAction } from '../inbox/logic';
import { motion, useReducedMotion } from '../ui/motion';
import { useReady } from '../auth/context';
import { Key } from '../components/DecisionBar';
import { stash } from '../lib/pendingDecisions';
import type { Row } from '../lib/live';
import type { NeedsEntry } from '../needs/logic';
import { editedFields, formValues, bandOf, wordDiff } from '../threads/logic';
import {
  editKey,
  forgetOutcome,
  getAsk,
  getEdit,
  getShown,
  setAsk,
  setEdit,
  setShown,
} from './drafts';
import { askedText, AskBox, DiffText, RevisingStrip, VersionSwitcher } from './Revise';
import { LabelBadge } from '../threads/labels';
import { FieldView } from '../threads/OutcomeCard';
import { useThreadOutcomes } from '../threads/data';
import {
  BAR as PLAN_BAR,
  planInputOf,
  planMain,
  sendBackChoices,
  stepTitle,
} from '../threads/plan';
import { GateAsk } from '../threads/GateAsk';
import { SchedulePanel } from '../threads/SchedulePanel';
import { usePlanActions } from '../threads/usePlanActions';
import { askOf } from '../needs/logic';
import { NotNowButton, useNotNow } from '../threads/NotNow';
import { summaryLine } from '../threads/decision';
import { timeAgo } from '../agents/logic';
import { errorText } from '../threads/parts';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Dialog, useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { RecheckLine, StaleChip, useRecheck } from '../threads/Recheck';
import { AskAgentDialog } from '../threads/AskAgent';
import { waitLabel } from '../inbox/logic';
import { proposalSentence } from './logic';
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
  /** Ask for changes (key C); false when this card can't (then C adds an item as usual). */
  ask?(): boolean;
  /** The version before or after the one on show (keys [ and ]). */
  version?(step: -1 | 1): void;
  /** Not now (key N on the decision page): out of Today until 09:00 tomorrow. */
  notNow?(): void;
}

export interface DecisionCardProps {
  entry: NeedsEntry;
  org: { name: string; color: string } | null;
  area: string | null;
  sender: { name: string; source: string; at: number } | null;
  now: number;
  agentName: (id: string) => string;
  onOpen: () => void;
  onSkip: () => void;
  /** After the window: the card's one-line done row. */
  onDone: (label: string) => void;
  /** Phone: the card swipes (right approves, left skips) and a tap opens it. */
  swipe?: boolean;
}

const TYPE_ICON: Record<string, LucideIcon> = {
  reply: Reply,
  no_reply: CircleCheck,
  make_it_work: ListChecks,
  handover: Forward,
  snooze: CalendarClock,
  nudge: MessageSquareReply,
  ignore: Ban,
};
const DONE_WORD: Record<string, string> = {
  reply: 'Sent',
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
    const band = bandOf(t, props.now);
    const inner = useRef<DecisionCardHandle>(null);
    useImperativeHandle(ref, () => ({
      approve: () => inner.current?.approve(),
      edit: () => inner.current?.edit(),
      reject: () => inner.current?.reject(),
      ask: () => inner.current?.ask?.() ?? false,
      version: (step) => inner.current?.version?.(step),
    }));
    // Not now (slice 3): out of Today until 09:00 tomorrow, while this decision waits.
    const nn = useNotNow(
      entry.wid,
      entry.thread!,
      askOf(entry.thread!, entry.plan, entry.proposals ?? []),
    );
    const notNow = <NotNowButton nn={nn} />;
    const nnError = nn.error ? (
      <p role="alert" className="mt-3 text-14 text-sendback">
        {nn.error}
      </p>
    ) : null;
    // A plan (item qwFAWxZM5xkcE7PPjAzi): the card shows the step that waits for the member.
    const planStep = (entry.proposals ?? []).find((p) => p.data.planId);
    const scheduleProposal = (entry.proposals ?? []).find((p) => p.data.type === 'schedule');
    const card = entry.plan
      ? shell(
          band,
          <>
            <CardHead props={props} />
            <PlanDecision ref={inner} props={props} plan={entry.plan} extra={notNow} />
            {nnError}
          </>,
          t.title,
        )
      : planStep
        ? shell(
            band,
            <>
              <CardHead props={props} />
              <div
                data-plan-card=""
                className="mt-3 rounded-card border border-agent/25 bg-agent-soft p-3.5 sm:p-4"
              >
                <p className="text-14 text-ink">
                  {props.agentName(planStep.data.proposedBy)} proposes a plan: steps that run in
                  order, each after your approval.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="approve"
                    onClick={props.onOpen}
                    leading={<Icon icon={ListChecks} size={16} />}
                  >
                    Open plan
                  </Button>
                  {notNow}
                </div>
              </div>
              {nnError}
            </>,
            t.title,
          )
        : t.state === 'needsYou'
          ? shell(
              band,
              <>
                <CardHead props={props} />
                <QuestionPanel
                  wid={entry.wid}
                  thread={entry.thread!}
                  agentName={props.agentName}
                  onDone={props.onDone}
                  onSkip={props.onSkip}
                  extra={notNow}
                />
                {nnError}
              </>,
              t.title,
            )
          : shell(
              band,
              <>
                <CardHead props={props} />
                {scheduleProposal ? (
                  // A schedule proposal (scheduled tasks, slices 5-6): its own card, also when
                  // another proposal waits next to it (that one shows once this is decided).
                  <SchedulePanel
                    ref={inner}
                    wid={entry.wid}
                    thread={entry.thread!}
                    outcome={scheduleProposal}
                    now={props.now}
                    agentName={props.agentName}
                    onDone={props.onDone}
                    extra={notNow}
                    othersPending={(entry.proposals?.length ?? 0) > 1}
                  />
                ) : (
                  <ProposalPanel
                    ref={inner}
                    wid={entry.wid}
                    thread={entry.thread!}
                    proposals={entry.proposals ?? []}
                    sender={props.sender}
                    now={props.now}
                    agentName={props.agentName}
                    onDone={props.onDone}
                    onOpen={props.onOpen}
                    onSkip={props.onSkip}
                    extra={notNow}
                  />
                )}
                {nnError}
              </>,
              t.title,
            );
    if (!props.swipe) return card;
    return (
      <SwipeCard
        canApprove={t.state !== 'needsYou'}
        onApprove={() => inner.current?.approve()}
        onSkip={props.onSkip}
        onOpen={props.onOpen}
      >
        {card}
      </SwipeCard>
    );
  },
);

/**
 * The phone's swipeable decision card (design 2.7): right approves (the Undo then shows on its
 * button, the card stays), left skips, a tap on the card opens the decision view. The buttons
 * do the same, so nothing depends on the gesture. The card never flies away; under reduced
 * motion it does not spring either.
 */
function SwipeCard({
  canApprove,
  onApprove,
  onSkip,
  onOpen,
  children,
}: {
  canApprove: boolean;
  onApprove: () => void;
  onSkip: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const dragged = useRef(false);
  const [hint, setHint] = useState<'approve' | 'skip' | null>(null);
  return (
    <div className="relative" data-swipe-card="">
      {hint ? (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center rounded-panel px-5 text-14 font-semibold',
            hint === 'skip'
              ? 'justify-end bg-canvas text-text-2'
              : 'justify-start bg-approve-bg text-approve-text',
          )}
        >
          {hint === 'skip' ? 'Skip' : 'Approve'}
        </div>
      ) : null}
      <motion.div
        drag="x"
        dragDirectionLock
        dragSnapToOrigin
        dragElastic={reduced ? 0.15 : 0.5}
        dragConstraints={{ left: 0, right: 0 }}
        dragTransition={reduced ? { bounceStiffness: 2000, bounceDamping: 100 } : undefined}
        onPointerDown={() => {
          dragged.current = false;
        }}
        onDragStart={() => {
          dragged.current = true;
        }}
        onDrag={(_, info) => setHint(info.offset.x < 0 ? 'skip' : canApprove ? 'approve' : null)}
        onDragEnd={(_, info) => {
          setHint(null);
          const a = swipeAction(info.offset.x);
          if (a === 'approve' && canApprove) onApprove();
          else if (a === 'iterate') onSkip();
        }}
        onClickCapture={(e) => {
          // The click that ends a swipe does nothing; a tap on the card (not a control) opens it.
          if (dragged.current) {
            e.stopPropagation();
            e.preventDefault();
            return;
          }
          const el = e.target as HTMLElement;
          if (
            !el.closest('button, a, input, textarea, select, label, [role="menu"], [role="dialog"]')
          )
            onOpen();
        }}
        className="relative"
      >
        {children}
      </motion.div>
    </div>
  );
}

/** Header shared by both cards: sender, organization, area, age, rank, the title. */
function CardHead({ props, label }: { props: DecisionCardProps; label?: string }) {
  const { entry, org, area, sender, now, onOpen } = props;
  const t = entry.thread!.data;
  const band = bandOf(t, now);
  const rank = rankText(t, band, now);
  const age = waitLabel(sender?.at ?? entry.since, now);
  const line = summaryLine(t);
  return (
    <>
      <div className="flex items-start gap-3 max-sm:flex-wrap max-sm:gap-y-2">
        <SenderAvatar name={sender?.name ?? t.title} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-14">
            <span className="font-semibold text-ink">{sender?.name ?? 'Inbox'}</span>
            <span className="text-13 text-text-2">
              {sender?.source ? `${sender.source} · ` : ''}
              {age === 'just now' ? age : `${age} ago`}
            </span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {org ? <OrgChip name={org.name} color={org.color} /> : null}
            {entry.label ? (
              <LabelBadge label={entry.label.label} suggested={entry.label.suggested} />
            ) : area ? (
              <Chip>{area}</Chip>
            ) : null}
          </div>
        </div>
        {rank ? (
          <span className="max-sm:order-last max-sm:basis-full max-sm:pl-[3.25rem]">
            <RankChip text={rank} band={band} />
          </span>
        ) : null}
      </div>
      {line ? (
        <>
          {/* With a summary (slice 3): the thread's title is the small line, the ask the big one. */}
          <p className="mt-3 text-13 text-text-2 [overflow-wrap:anywhere]">
            {t.title || 'Untitled thread'}
          </p>
          <h2 className="mt-0.5 text-18 font-semibold leading-snug text-ink sm:text-20">
            <button
              type="button"
              data-headline=""
              onClick={onOpen}
              className="text-left [overflow-wrap:anywhere] hov:underline foc:outline-2 foc:outline-offset-2 foc:outline-focus"
            >
              {line}
            </button>
          </h2>
          <SummaryTop props={props} />
        </>
      ) : (
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
      )}
    </>
  );
}

/**
 * Under the summary's top line on the card (slice 3, design 3.4): the one-line answer and
 * "<agent> recommends Approve · confidence high · updated 3 min ago". Nothing without a summary:
 * the card's own proposal line stays the fallback.
 */
function SummaryTop({ props }: { props: DecisionCardProps }) {
  const t = props.entry.thread!.data;
  const s = t.summary;
  const line = summaryLine(t);
  if (!s || !line) return null;
  const stale = s.at.toMillis() < t.updatedAt.toMillis();
  const agent = props.agentName(t.fetchedBy);
  return (
    <div data-summary-top="" className="mt-1">
      {s.answer ? (
        <p data-answer="" className="text-14 text-ink [overflow-wrap:anywhere]">
          {s.answer}
        </p>
      ) : null}
      <p data-recommends="" className="mt-1 text-13 text-text-2 [overflow-wrap:anywhere]">
        {s.recAction ? (
          <>
            {agent} recommends{' '}
            <strong className="font-semibold text-approve-text">{s.recAction}</strong>
            {' · '}
          </>
        ) : null}
        {s.confidence ? `confidence ${s.confidence} · ` : null}
        <span data-updated="">updated {timeAgo(new Date(s.at.toMillis()), props.now)}</span>
        {stale ? (
          <span data-summary-stale="" className="font-medium text-gate-text">
            {' · may be out of date'}
          </span>
        ) : null}
      </p>
    </div>
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

/**
 * Today's card for a plan (item qwFAWxZM5xkcE7PPjAzi, slice 5): the plan's progress and only the
 * step that waits for the member. A proposed plan offers Approve plan (its agent steps); an
 * approval step at its turn, Approve and Not approved; an agent step not approved yet, the usual
 * proposal (Approve step, Edit, Ask for changes); a blocked plan, Retry, Skip and Stop plan.
 * Keys A, E, C and [ ] act on what is shown, as on any card; Open plan opens the thread page.
 */
const PlanDecision = forwardRef<
  DecisionCardHandle,
  { props: DecisionCardProps; plan: Row<InboxPlan>; extra?: ReactNode }
>(function PlanDecision({ props, plan, extra }, ref) {
  const { entry, agentName } = props;
  const thread = entry.thread!;
  const { session } = useReady();
  const outs = useThreadOutcomes(entry.wid, thread.id, session.me.uid);
  // While Today redraws (the listener starts again), keep the steps last seen: no flash.
  const [kept, setKept] = useState<Row<InboxOutcome>[]>([]);
  if (outs.state === 'ready' && outs.data !== kept) setKept(outs.data);
  const rows = outs.state === 'ready' ? outs.data : kept;
  const pl = planInputOf(plan, rows);
  const loaded = plan.data.steps.every((id) => pl.outcomes[id]);
  const view = planView(pl.plan, pl.outcomes);
  const main = loaded ? planMain(pl) : null;
  const acts = usePlanActions(entry.wid, thread, pl, props.onDone);
  const inner = useRef<DecisionCardHandle>(null);
  const at = main && main.kind !== 'approvePlan' ? view.steps[main.index] : undefined;
  const atRow = at ? rows.find((r) => r.id === at.outcomeId) : undefined;
  // Ask for changes on a gate (slice 6): the plan goes back to an earlier step, with the text.
  const back = main?.kind === 'step' && main.gate ? sendBackChoices(pl, main.index) : null;
  const [asking, setAsking] = useState(false);
  useImperativeHandle(ref, () => ({
    approve: () => {
      if (!main) return;
      if (main.kind === 'approvePlan') acts.approveAll();
      else if (main.kind === 'retry') acts.retry();
      else if (main.gate && at) acts.gate(at, true, thread.data.summary?.version);
      else inner.current?.approve();
    },
    edit: () => inner.current?.edit(),
    reject: () => {
      if (main?.kind === 'step' && main.gate && at) acts.gate(at, false);
      else inner.current?.reject();
    },
    ask: () => {
      if (main?.kind === 'step' && main.gate && back?.target !== null && back) {
        setAsking(true);
        return true;
      }
      return inner.current?.ask?.() ?? false;
    },
    version: (step) => inner.current?.version?.(step),
  }));
  const busy = !!acts.counting;
  const open = (
    <Button
      variant="secondary"
      onClick={props.onOpen}
      leading={<Icon icon={ListChecks} size={15} />}
    >
      Open plan
    </Button>
  );
  const skip = (
    <Button
      variant="ghost"
      className="ml-auto max-sm:hidden"
      disabled={busy}
      onClick={props.onSkip}
    >
      Skip
      <Key>S</Key>
    </Button>
  );
  const title = (i: number) => {
    const s = view.steps[i]!;
    return stepTitle(s.type, pl.outcomes[s.outcomeId]?.fields ?? {});
  };
  return (
    <div data-plan-card="" data-plan={plan.id} data-plan-main={main?.kind ?? 'none'}>
      <div className="mt-3 flex items-center gap-2">
        <Icon icon={ListChecks} size={16} className="text-agent" />
        <span className="font-mono text-12 font-semibold uppercase tracking-[0.08em] text-agent">
          Plan · {view.progress}
        </span>
        <span className="ml-auto text-12 text-text-2">
          {view.through} of {view.total} done
        </span>
      </div>
      <div aria-hidden className="mt-2 flex gap-1">
        {view.steps.map((s) => (
          <span key={s.outcomeId} className={cn('h-1.5 flex-1 rounded-full', PLAN_BAR[s.ui])} />
        ))}
      </div>
      {!loaded ? (
        <p className="mt-3 text-14 text-text-2">Loading the plan…</p>
      ) : main?.kind === 'step' && !main.gate && atRow ? (
        <ProposalPanel
          ref={inner}
          wid={entry.wid}
          thread={thread}
          proposals={[atRow]}
          sender={props.sender}
          now={props.now}
          agentName={agentName}
          onDone={props.onDone}
          onOpen={props.onOpen}
          onSkip={props.onSkip}
          plan={pl}
          extra={extra}
        />
      ) : (
        <div className="mt-3 rounded-card border border-agent/25 bg-agent-soft p-3.5 sm:p-4">
          {main?.kind === 'approvePlan' ? (
            <>
              <p className="text-14 text-ink">
                {agentName(plan.data.proposedBy)} proposes {view.total}{' '}
                {view.total === 1 ? 'step' : 'steps'} that run in order
                {plan.data.note ? `: ${plan.data.note}` : '.'}
              </p>
              <ol aria-label="Steps" className="mt-2 flex flex-col gap-1">
                {view.steps.map((s) => (
                  <li
                    key={s.outcomeId}
                    data-step={s.number}
                    className="flex items-center gap-2 text-14"
                  >
                    <span className="w-4 shrink-0 text-right text-12 font-semibold text-text-2">
                      {s.number}
                    </span>
                    <Icon
                      icon={s.kind === 'human' ? User : Zap}
                      size={13}
                      className={s.kind === 'human' ? 'text-gate-text' : 'text-agent'}
                    />
                    <span className="min-w-0 truncate text-ink">{title(s.index)}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-13 text-text-2">
                Approve plan approves the agent steps; your approval steps still wait for you.
              </p>
            </>
          ) : main?.kind === 'step' && at ? (
            <>
              <p className="text-13 font-medium text-gate-text">
                Step {at.number} of {view.total} · Your approval
              </p>
              <h3 className="mt-1 text-15 font-semibold text-ink [overflow-wrap:anywhere]">
                {title(at.index)}
              </h3>
              {typeof pl.outcomes[at.outcomeId]?.fields.detail === 'string' ? (
                <p className="mt-1 whitespace-pre-wrap text-14 text-text-2 [overflow-wrap:anywhere]">
                  {String(pl.outcomes[at.outcomeId]!.fields.detail)}
                </p>
              ) : null}
            </>
          ) : main?.kind === 'retry' && at ? (
            <>
              <p className="text-13 font-medium text-sendback">
                Step {at.number} of {view.total} failed
              </p>
              <h3 className="mt-1 text-15 font-semibold text-ink [overflow-wrap:anywhere]">
                {title(at.index)}
              </h3>
              {atRow?.data.result?.error ? (
                <p className="mt-1 text-14 text-text-2">{atRow.data.result.error}</p>
              ) : null}
            </>
          ) : (
            <p className="text-14 text-text-2">Nothing in this plan waits for you right now.</p>
          )}
        </div>
      )}
      {acts.error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {acts.error}
        </p>
      ) : null}
      {loaded && !(main?.kind === 'step' && !main.gate && atRow) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {acts.counting ? (
            <UndoButton countdown={acts.counting} variant="approve" />
          ) : main?.kind === 'approvePlan' ? (
            <Button
              variant="approve"
              data-approve-plan=""
              onClick={acts.approveAll}
              leading={<Icon icon={Check} size={16} />}
            >
              Approve plan
              <Key>A</Key>
            </Button>
          ) : main?.kind === 'step' && at ? (
            <>
              <Button
                variant="approve"
                data-gate-approve=""
                onClick={() => acts.gate(at, true, thread.data.summary?.version)}
                leading={<Icon icon={Check} size={16} />}
              >
                Approve
                <Key>A</Key>
              </Button>
              {back && back.target !== null ? (
                <Button
                  variant="secondary"
                  data-gate-ask-open=""
                  aria-expanded={asking}
                  onClick={() => setAsking(!asking)}
                >
                  Ask for changes
                  <Key>C</Key>
                </Button>
              ) : null}
              <ActionMenu
                label="More decisions"
                actions={[
                  {
                    id: 'not-approved',
                    label: 'Not approved: stop the plan',
                    tone: 'danger',
                    onSelect: () => acts.gate(at, false),
                  },
                ]}
                trigger={
                  <Button variant="ghost" data-more-decisions="" aria-label="More decisions">
                    <Icon icon={MoreHorizontal} size={18} />
                  </Button>
                }
              />
            </>
          ) : main?.kind === 'retry' ? (
            <>
              <Button variant="approve" data-retry="" onClick={acts.retry}>
                {at?.outcome?.state === 'failed' ? 'Retry' : 'Go on'}
                <Key>A</Key>
              </Button>
              {at?.outcome?.state === 'failed' ? (
                <Button variant="secondary" data-skip="" onClick={acts.skip}>
                  Skip step
                </Button>
              ) : null}
              <Button variant="sendback" data-stop="" onClick={acts.stop}>
                Stop plan
              </Button>
            </>
          ) : null}
          {acts.counting ? null : extra}
          {open}
          {skip}
        </div>
      ) : null}
      {asking && back && back.target !== null && !acts.counting ? (
        <GateAsk
          choices={back.choices}
          target={back.target}
          sentBefore={plan.data.sentBack?.n ?? 0}
          agent={agentName(thread.data.fetchedBy)}
          onCancel={() => setAsking(false)}
          onSend={(reason, to) => {
            setAsking(false);
            acts.sendBack(reason, to);
          }}
        />
      ) : null}
    </div>
  );
});

export interface ProposalPanelProps {
  wid: string;
  thread: Row<InboxThread>;
  /** The thread's open proposals, oldest first. */
  proposals: Row<InboxOutcome>[];
  sender: { name: string; source: string; at: number } | null;
  now: number;
  agentName: (id: string) => string;
  onDone: (label: string) => void;
  /** Open thread (in the Other menu); left out on the thread page itself. */
  onOpen?: () => void;
  /** Skip (Today only). */
  onSkip?: () => void;
  /** Under the proposal block: the thread page's "When you approve…" preview. */
  after?: (shown: Row<InboxOutcome>) => ReactNode;
  /** Phone bottom sheet, collapsed: no reason. */
  compact?: boolean;
  /** A narrow column (the thread page's panel): Other is an icon. */
  narrow?: boolean;
  /** Which proposal is on show (the panel's checks and confidence follow it). */
  onShown?: (id: string) => void;
  /**
   * A step of a plan (item qwFAWxZM5xkcE7PPjAzi): approving it needs the plan, Approve reads
   * "Approve step", and Reject becomes Remove step (onRemove); thread actions live on the plan.
   */
  plan?: PlanInput;
  onRemove?: () => void;
  /**
   * Re-check (item bmNoIvvqKCdAorLSShE9): the "Checking again…" strip, the result line and the
   * "May be out of date" chip; off where the plan panel shows them for the whole plan.
   */
  recheckUi?: boolean;
  /** The thread page: E toggles Everything there, so Edit shows no key hint. */
  noEditKey?: boolean;
  /** One more button in the row, before Other (Not now, slice 3). */
  extra?: ReactNode;
}

/**
 * The proposal block and its buttons: shared by the Today card and the thread page's agent panel
 * (design 2.2 and 2.3). Shows one open proposal at a time ("1 of N" through Other).
 */
export const ProposalPanel = forwardRef<DecisionCardHandle, ProposalPanelProps>(
  function ProposalPanel(props, ref) {
    const { wid, thread, proposals, now, agentName, onSkip, onDone, onOpen, sender } = props;
    const { after, compact, onShown, narrow, plan: inPlan, onRemove } = props;
    const recheckUi = props.recheckUi ?? true;
    const { session, actionContext, run } = useReady();
    const toast = useToast();
    const t = thread.data;
    const [shownId, setShownId] = useState<string | null>(null);
    const shown: Row<InboxOutcome> | undefined =
      proposals.find((p) => p.id === shownId) ?? proposals[0];
    // A retired type (bookings, slice 5): shown read-only, never approved or edited.
    const retired = !!shown && isRetiredOutcome(shown.data.type);
    const key = shown ? `io:${wid}:${shown.id}` : `io:${wid}:none`;
    const counting = useCountdown(key);
    const threadCounting = useCountdown(`it:${wid}:${thread.id}`);
    const pending = counting ?? threadCounting;
    // Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): the versions, the one on show, its draft.
    const versions = shown?.data.versions ?? [];
    const nv = shown ? versionCount(shown.data) : 1;
    const oKey = shown ? `${wid}:${shown.id}` : '';
    const [picked, setPicked] = useState<number | undefined>(() =>
      shown ? getShown(oKey) : undefined,
    );
    const [pickedFor, setPickedFor] = useState(oKey);
    const viewN = Math.min(Math.max(1, picked ?? nv), nv);
    const view = versions.length ? versions[viewN - 1] : undefined;
    const viewFields = useMemo(() => view?.fields ?? shown?.data.fields ?? {}, [view, shown]);
    const eKey = shown ? editKey(wid, shown.id, viewN) : '';
    const fresh = () => (shown ? formValues(shown.data.type, viewFields) : {});
    const [editing, setEditing] = useState(() => getEdit(eKey)?.editing ?? false);
    const [values, setValues] = useState<Record<string, string | boolean>>(
      () => getEdit(eKey)?.values ?? fresh(),
    );
    const [valuesFor, setValuesFor] = useState(eKey);
    const [asking, setAsking] = useState(() => !!getAsk(oKey));
    const [askChips, setAskChips] = useState<string[]>(() => getAsk(oKey)?.chips ?? []);
    const [askText, setAskText] = useState(() => getAsk(oKey)?.text ?? '');
    const [revBusy, setRevBusy] = useState(false);
    const [showDiff, setShowDiff] = useState(true);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const [moreReason, setMoreReason] = useState(false);
    const rc = useRecheck(wid, thread, now, setError);
    // Ask the agent (item w6O2KOw4ys70TQv9I1xD): from the Other menu where no box is on show.
    const [askOpen, setAskOpen] = useState(false);
    useEffect(() => {
      if (shown) onShown?.(shown.id);
    }, [shown, onShown]);
    if (shown && pickedFor !== oKey) {
      setPickedFor(oKey);
      setPicked(getShown(oKey));
      setAsking(!!getAsk(oKey));
      setAskChips(getAsk(oKey)?.chips ?? []);
      setAskText(getAsk(oKey)?.text ?? '');
    }
    if (shown && valuesFor !== eKey) {
      // Another proposal or version on show: its own draft, or its text as the agent wrote it.
      setValuesFor(eKey);
      setValues(getEdit(eKey)?.values ?? fresh());
      setEditing(getEdit(eKey)?.editing ?? false);
      setNote(null);
    }
    // The draft outlives a remount (the phone sheet, the panel layouts): Send sends what is shown.
    useEffect(() => {
      if (!eKey || valuesFor !== eKey || !shown) return;
      const same = sameFields(editedFields(shown.data.type, values), viewFields);
      setEdit(eKey, !editing && same ? null : { editing, values });
    }, [eKey, valuesFor, editing, values, shown, viewFields]);
    useEffect(() => {
      if (!oKey) return;
      setAsk(oKey, asking ? { chips: askChips, text: askText } : null);
    }, [oKey, asking, askChips, askText]);

    const type = shown ? outcomeType(shown.data.type) : null;
    const label = type?.label ?? shown?.data.type ?? '';
    const edited = shown
      ? editedFields(shown.data.type, values)
      : ({} as Record<string, string | boolean>);
    const dirty = !!shown && !sameFields(edited, viewFields);
    const current = dirty ? edited : viewFields;
    const revising = shown?.data.state === 'revising';
    const revisable = !!shown && REVISABLE_TYPES.includes(shown.data.type);
    const full = nv >= INBOX_LIMITS.versions;
    const goVersion = (n: number) => {
      if (!shown || n < 1 || n > nv) return;
      setPicked(n === nv ? undefined : n);
      setShown(oKey, n === nv ? null : n);
    };
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
              if (shown) forgetOutcome(wid, shown.id);
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
      if (!ctx || !shown || pending || retired) return;
      setError(null);
      let plan;
      try {
        // Exactly what is on screen at the press: the version shown, with the edit if any.
        plan = approveOutcome(ctx, {
          outcomeId: shown.id,
          outcome: shown.data,
          thread: { ...t },
          ...(versions.length ? { version: viewN } : {}),
          ...(dirty ? { fields: edited } : {}),
          // A single outcome with nothing else to decide: the thread waits on the agent.
          ...(inPlan ? { plan: inPlan } : { othersPending: proposals.length > 1 }),
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

    async function askAgent() {
      const ctx = actionContext(wid);
      if (!ctx || !shown || pending || revBusy) return;
      setError(null);
      let plan;
      try {
        plan = requestRevision(ctx, {
          outcomeId: shown.id,
          outcome: shown.data,
          thread: { ...t },
          chips: askChips,
          instruction: askText,
        });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      setRevBusy(true);
      try {
        await run(plan);
        setAsking(false);
        setAskChips([]);
        setAskText('');
        goVersion(nv);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setRevBusy(false);
      }
    }

    async function cancelAsk() {
      const ctx = actionContext(wid);
      if (!ctx || !shown || pending || revBusy) return;
      setError(null);
      setRevBusy(true);
      try {
        await run(
          cancelRevision(ctx, { outcomeId: shown.id, outcome: shown.data, thread: { ...t } }),
        );
      } catch (e) {
        setError(errorText(e));
      } finally {
        setRevBusy(false);
      }
    }

    useImperativeHandle(ref, () => ({
      approve,
      edit: () => {
        if (!pending && shown) setEditing((v) => !v);
      },
      reject: () => {
        if (!pending && shown && !revising) {
          if (inPlan) onRemove?.();
          else setRejecting(true);
        }
      },
      ask: () => {
        if (pending || !shown || !revisable || revising || full) return false;
        setAsking(true);
        return true;
      },
      version: (step) => goVersion(viewN + step),
    }));

    if (!shown) return null;
    const others = proposals.filter((p) => p.id !== shown.id);
    const reasonText = view ? view.note : shown.data.note;
    const confidence = view ? view.confidence : shown.data.confidence;
    const prevFields = viewN > 1 ? versions[viewN - 2]?.fields : undefined;
    const asked = view?.asked && viewN > 1 ? view.asked : null;
    // A version the agent wrote on a re-check (no ask): its changes, said so.
    const rechecked = !!view && viewN > 1 && !view.asked;
    const approveLabel = `${inPlan ? 'Approve step' : (type?.approve ?? 'Approve')}${nv > 1 || revising ? ` v${viewN}` : ''}`;
    const longReason = reasonText.length > 180;
    const TypeIcon = TYPE_ICON[shown.data.type] ?? ListChecks;
    const band = bandOf(t, now);
    const recheckItem = rc.can
      ? [
          {
            id: 'recheck',
            label: 'Re-check',
            icon: RefreshCw,
            onSelect: () => rc.request('menu'),
          },
        ]
      : [];
    const askItem = narrow
      ? []
      : [
          {
            id: 'ask',
            label: 'Ask the agent…',
            icon: MessageSquare,
            onSelect: () => setAskOpen(true),
          },
        ];
    const planMenu = [
      ...recheckItem,
      ...askItem,
      ...(onRemove && !revising
        ? [
            {
              id: 'remove',
              label: 'Remove step',
              icon: X,
              tone: 'danger' as const,
              onSelect: onRemove,
            },
          ]
        : []),
    ];
    const menu = inPlan
      ? planMenu
      : [
          ...others.map((p) => ({
            id: `show-${p.id}`,
            label: `Show: ${outcomeType(p.data.type)?.label ?? p.data.type}`,
            icon: ArrowRight,
            onSelect: () => setShownId(p.id),
          })),
          // While the agent revises, Cancel the request first (a rejection would race its v2).
          ...(revising
            ? []
            : [
                {
                  id: 'reject',
                  label: 'Reject proposal',
                  icon: X,
                  tone: 'danger' as const,
                  onSelect: () => setRejecting(true),
                },
              ]),
          ...recheckItem,
          ...askItem,
          { id: 'ignore', label: 'Ignore thread', icon: Ban, onSelect: () => threadAct('ignore') },
          {
            id: 'close',
            label: 'Mark done',
            icon: CircleCheck,
            onSelect: () => threadAct('close'),
          },
          ...(onOpen
            ? [{ id: 'open', label: 'Open thread', icon: ExternalLink, onSelect: onOpen }]
            : []),
          ...(onSkip
            ? [{ id: 'skip', label: 'Skip for now', icon: SkipForward, onSelect: onSkip }]
            : []),
        ];
    void band;

    return (
      <div data-outcome={shown.id} data-outcome-state={shown.data.state}>
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
            <span className="ml-auto flex items-center gap-2">
              <ConfidenceMeter value={confidence ?? undefined} />
              {nv > 1 ? (
                <VersionSwitcher n={viewN} of={nv} onGo={goVersion} />
              ) : revising ? (
                <span className="text-13 font-medium tabular-nums text-text-2">v1</span>
              ) : null}
            </span>
          </div>
          {revising && shown.data.revise ? (
            <RevisingStrip
              agent={agentName(shown.data.proposedBy)}
              asked={shown.data.revise}
              wid={wid}
              agentId={shown.data.proposedBy}
            />
          ) : null}
          {recheckUi ? (
            <RecheckLine
              wid={wid}
              thread={thread}
              now={now}
              agent={agentName(t.fetchedBy)}
              since={shown.data.createdAt?.toMillis()}
            />
          ) : null}
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
              className={cn(
                'mt-2 text-15 leading-relaxed text-ink [overflow-wrap:anywhere]',
                revising && 'opacity-60',
              )}
            >
              {prevFields && showDiff && !dirty ? (
                <DiffText
                  parts={wordDiff(
                    proposalSentence(shown.data.type, prevFields),
                    proposalSentence(shown.data.type, viewFields),
                  )}
                />
              ) : (
                proposalSentence(shown.data.type, current)
              )}
            </p>
          )}
          {asked || rechecked ? (
            <div className="mt-2.5 flex items-start gap-2 text-13 text-text-2">
              <Icon icon={Sparkles} size={14} className="mt-0.5 shrink-0 text-agent" />
              {asked ? (
                <p data-asked="" className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  You asked: <span className="italic">{askedText(asked)}</span>
                </p>
              ) : (
                <p data-asked="recheck" className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  After a re-check
                </p>
              )}
              {!editing && !dirty ? (
                <button
                  type="button"
                  aria-pressed={!showDiff}
                  onClick={() => setShowDiff((v) => !v)}
                  className="shrink-0 text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus"
                >
                  {showDiff ? 'Hide changes' : 'Show changes'}
                </button>
              ) : null}
            </div>
          ) : null}
          {note ? <p className="mt-2 text-13 font-medium text-gate-text">{note}</p> : null}
          {reasonText && !compact ? (
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
          {recheckUi && !revising && !compact ? (
            <StaleChip outcome={shown} thread={thread} now={now} rc={rc} />
          ) : null}
          {retired ? (
            <p data-retired="" className="mt-2 text-14 text-text-2">
              Bookings were removed with Calendar: this proposal can only be rejected.
            </p>
          ) : null}
        </div>
        {after && !compact ? after(shown) : null}
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
            <Button
              variant="approve"
              className="max-sm:flex-1"
              disabled={retired}
              onClick={approve}
              leading={<Icon icon={Check} size={16} />}
            >
              {approveLabel}
              <Key>A</Key>
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={!!pending || retired}
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
            <span className={editing ? undefined : 'max-sm:sr-only'}>
              {editing ? 'Cancel edit' : 'Edit'}
            </span>
            {editing || props.noEditKey ? null : <Key>E</Key>}
          </Button>
          {revisable && revising ? (
            <Button
              variant="secondary"
              disabled={!!pending}
              loading={revBusy}
              onClick={() => void cancelAsk()}
              aria-label="Revising, cancel the request"
              leading={<Icon icon={Sparkles} size={15} className="text-agent" />}
            >
              <span className="text-agent">Revising… · Cancel</span>
            </Button>
          ) : revisable ? (
            <Button
              variant="secondary"
              disabled={!!pending || full}
              aria-expanded={asking}
              data-ask-changes=""
              onClick={() => setAsking((v) => !v)}
              leading={<Icon icon={Sparkles} size={15} className="text-agent" />}
            >
              <span className={narrow ? 'hidden' : 'max-sm:hidden'}>Ask for changes</span>
              <span className={narrow ? '' : 'sm:hidden'}>Changes</span>
              <Key>C</Key>
            </Button>
          ) : null}
          {pending ? null : props.extra}
          {rc.counting?.tag === 'menu' ? (
            <UndoButton countdown={rc.counting} variant="secondary" />
          ) : menu.length ? (
            <ActionMenu
              label="Other actions"
              actions={menu}
              trigger={
                <Button variant="ghost" disabled={!!pending} aria-label="Other actions">
                  <span className="inline-flex items-center gap-1">
                    <span className={narrow ? 'hidden' : 'max-sm:hidden'}>Other</span>
                    <Icon
                      icon={ChevronDown}
                      size={15}
                      className={narrow ? 'hidden' : 'max-sm:hidden'}
                    />
                    <Icon icon={MoreHorizontal} size={18} className={narrow ? '' : 'sm:hidden'} />
                  </span>
                </Button>
              }
            />
          ) : null}
          {onSkip ? (
            <Button
              variant="ghost"
              className="ml-auto max-sm:hidden"
              disabled={!!pending}
              onClick={onSkip}
            >
              Skip
              <Key>S</Key>
            </Button>
          ) : null}
        </div>
        {revisable && full && !revising ? (
          <p className="mt-2 text-13 text-text-2">
            {nv} versions: edit it yourself or pick another outcome.
          </p>
        ) : null}
        {revisable && revising ? (
          <p className="mt-2 text-13 text-text-2">
            You can still send v{viewN}, or edit it; the agent’s v{nv + 1} then is refused.
          </p>
        ) : null}
        {asking && revisable && !revising && !pending ? (
          <AskBox
            chips={askChips}
            text={askText}
            next={nv + 1}
            busy={revBusy}
            onChips={setAskChips}
            onText={setAskText}
            onCancel={() => {
              setAsking(false);
              setAskChips([]);
              setAskText('');
            }}
            onAsk={() => void askAgent()}
          />
        ) : null}
        <AskAgentDialog
          open={askOpen}
          onOpenChange={setAskOpen}
          wid={wid}
          thread={thread}
          now={now}
          agent={agentName(t.fetchedBy)}
        />
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
      </div>
    );
  },
);

/** A question from the agent: up to 4 answer chips, or a written answer. */
export function QuestionPanel({
  wid,
  thread,
  agentName,
  onDone,
  onSkip,
  bare,
  extra,
}: {
  wid: string;
  thread: Row<InboxThread>;
  agentName: (id: string) => string;
  onDone: (label: string) => void;
  onSkip?: () => void;
  /** Not now (slice 3), beside Skip. */
  extra?: ReactNode;
  /** The decision page's top card already shows who asks and the question. */
  bare?: boolean;
}) {
  const { actionContext, run } = useReady();
  const t: InboxThread = thread.data;
  const q = t.question;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(text: string) {
    const ctx = actionContext(wid);
    if (!ctx || !text.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      await run(answerQuestion(ctx, { threadId: thread.id, thread: { ...t }, answer: text }));
      onDone(`Answered · ${t.title || 'thread'}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div
        data-question=""
        className={
          bare ? 'mt-1' : 'mt-3 rounded-card border border-gate/50 bg-gate-bg p-3.5 sm:p-4'
        }
      >
        {bare ? null : (
          <>
            <p className="font-mono text-12 font-semibold uppercase tracking-[0.08em] text-gate-text">
              {q ? `${agentName(q.by)} asks` : 'Question'}
            </p>
            <p className="mt-1.5 whitespace-pre-wrap text-15 leading-relaxed text-ink [overflow-wrap:anywhere]">
              {q?.text}
            </p>
          </>
        )}
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
      {onSkip || extra ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {extra ? <span className="mr-auto">{extra}</span> : null}
          {onSkip ? (
            <Button variant="ghost" onClick={onSkip}>
              Skip
              <Key>S</Key>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
