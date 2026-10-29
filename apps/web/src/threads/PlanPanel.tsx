/**
 * A plan on the thread page (item qwFAWxZM5xkcE7PPjAzi, slice 4; design: thread-1440.png,
 * phone-390.png, states.png): the agent's ordered steps as a numbered checklist with a kind icon
 * (agent action or your approval) and a state per step, one step open at a time. The member
 * approves the whole plan or one step (with Edit and Ask for changes, as a single proposal),
 * decides an approval step at its turn, moves, removes or adds steps that have not started,
 * retries, skips or stops a blocked plan, or rejects it. Every decision counts down with Undo.
 * On a phone it sits in the bottom sheet with one main button.
 */
import {
  agentSchema,
  approveOutcome,
  approvePlan,
  cliSupports,
  editPlan,
  minVersionFor,
  outcomeType,
  paths,
  planView,
  rejectOutcome,
  rejectPlan,
  retryPlanStep,
  skipPlanStep,
  stopPlan,
  type ActionPlan,
  type InboxOutcome,
  type InboxPlan,
  type InboxThread,
  type PlanEdit,
  type PlanStepView,
} from '@hive/shared';
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  MoreHorizontal,
  Plus,
  Trash2,
  TriangleAlert,
  User,
  X,
  Zap,
} from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useReady } from '../auth/context';
import { stash } from '../lib/pendingDecisions';
import { useLiveDoc, type Row } from '../lib/live';
import { ProposalPanel } from '../today/DecisionCard';
import { ConfidenceMeter } from '../today/parts';
import { Pill, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { ActionMenu, type MenuAction } from '../ui/menu';
import { Dialog, useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { FieldView } from './OutcomeCard';
import { errorText } from './parts';
import {
  firstFree,
  planInputOf,
  planLive,
  planMain,
  planSummary,
  STEP_UI_TEXT,
  stepTitle,
} from './plan';

const PILL: Record<PlanStepView['ui'], Tone> = {
  proposed: 'neutral',
  revising: 'agent',
  approved: 'approve',
  running: 'agent',
  done: 'approve',
  waitingForYou: 'gate',
  blocked: 'sendback',
  skipped: 'neutral',
  stopped: 'neutral',
};
const CIRCLE: Record<PlanStepView['ui'], string> = {
  proposed: 'border-line-strong text-text-2',
  revising: 'border-dashed border-agent text-agent',
  approved: 'border-approve text-approve-text',
  running: 'border-agent text-agent',
  done: 'border-approve-solid bg-approve-solid text-on-solid',
  waitingForYou: 'border-gate bg-gate text-on-gate',
  blocked: 'border-sendback text-sendback',
  skipped: 'border-line text-text-3 line-through',
  stopped: 'border-line text-text-3',
};
const BAR: Record<PlanStepView['ui'], string> = {
  proposed: 'bg-line',
  revising: 'bg-agent/40',
  approved: 'border border-approve bg-transparent',
  running: 'bg-agent',
  done: 'bg-approve-solid',
  waitingForYou: 'bg-gate',
  blocked: 'bg-sendback',
  skipped: 'bg-line',
  stopped: 'bg-line',
};

export interface PlanPanelProps {
  wid: string;
  thread: Row<InboxThread>;
  plan: Row<InboxPlan>;
  /** The thread's outcomes: the plan's steps are among them. */
  outcomes: readonly Row<InboxOutcome>[];
  sender: { name: string; source: string; at: number } | null;
  now: number;
  busy: ReadonlyArray<{ start: Date; end: Date }>;
  agentName: (id: string) => string;
  /** Phone: the panel is in the bottom sheet, with one main button at its foot. */
  sheet?: boolean;
}

export function PlanPanel(props: PlanPanelProps) {
  const { wid, thread, plan, outcomes, agentName, sheet } = props;
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const pl = planInputOf(plan, outcomes);
  const view = planView(pl.plan, pl.outcomes);
  const live = planLive(plan.data.state);
  const main = planMain(pl);
  const free = firstFree(pl);
  const key = `ip:${wid}:${plan.id}`;
  const counting = useCountdown(key);
  const agent = agentName(plan.data.proposedBy);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const defaultOpen =
    main?.kind === 'step'
      ? main.outcomeId
      : (view.steps.find(
          (s) => s.ui === 'blocked' || s.ui === 'revising' || s.ui === 'waitingForYou',
        )?.outcomeId ??
        view.steps.find((s) => s.ui === 'proposed')?.outcomeId ??
        null);
  const shownId = openId === '' ? null : (openId ?? defaultOpen);
  // An old CLI sends every approved step at once: say so before the member approves.
  const home = useLiveDoc(paths.agent(wid, thread.data.fetchedBy), agentSchema);
  const have = home.state === 'ready' ? home.data?.cliVersion : undefined;
  const old = home.state === 'ready' && !!home.data && cliSupports('plan', have) === 'old';

  /** Counts down with Undo, then writes (the plan's decisions share one countdown). */
  function commit(make: () => Pick<ActionPlan, 'ops'>, message: string, done: string) {
    const ctx = actionContext(wid);
    if (!ctx || counting) return;
    setError(null);
    let p: Pick<ActionPlan, 'ops'>;
    try {
      p = make();
    } catch (e) {
      setError(errorText(e));
      return;
    }
    const forget = stash(session.me.uid, wid, [p.ops], `Saved: ${done}`);
    toast.push({
      message,
      undoLabel: 'Undo',
      duration: 5000,
      countdown: { key, tag: message, announce: `${message}. Undo available for 5 seconds` },
      onUndo: forget,
      onCommit: () => {
        run(p).then(
          () => forget(),
          (e: unknown) => {
            forget();
            setError(errorText(e));
          },
        );
      },
    });
  }
  const ctx = () => {
    const c = actionContext(wid);
    if (!c) throw new Error('Not signed in.');
    return c;
  };
  const th = () => ({ ...thread.data });
  const edit = (e: PlanEdit, message: string) =>
    commit(() => editPlan(ctx(), { ...pl, thread: th(), edit: e }), message, `Plan · ${message}`);
  const approveAll = () =>
    commit(() => approvePlan(ctx(), { ...pl, thread: th() }), 'Plan approved', 'Plan approved');
  const rejectAll = () =>
    commit(() => rejectPlan(ctx(), { ...pl, thread: th() }), 'Plan rejected', 'Plan rejected');
  const gate = (s: PlanStepView, yes: boolean) =>
    commit(
      () =>
        yes
          ? approveOutcome(ctx(), {
              outcomeId: s.outcomeId,
              outcome: pl.outcomes[s.outcomeId]!,
              thread: th(),
              plan: pl,
            })
          : rejectOutcome(ctx(), {
              outcomeId: s.outcomeId,
              outcome: pl.outcomes[s.outcomeId]!,
              thread: th(),
              othersPending: false,
              plan: pl,
            }),
      yes ? `Step ${s.number} approved` : `Step ${s.number} not approved: the plan stops`,
      yes ? `Approved step ${s.number}` : `Not approved: step ${s.number}`,
    );
  const retry = () =>
    commit(() => retryPlanStep(ctx(), { ...pl, thread: th() }), 'Retrying', 'Retry');
  const skip = () =>
    commit(() => skipPlanStep(ctx(), { ...pl, thread: th() }), 'Step skipped', 'Skipped a step');
  const stop = () =>
    commit(() => stopPlan(ctx(), { ...pl, thread: th() }), 'Plan stopped', 'Plan stopped');

  const movable = (i: number) => live && i >= free;
  const stepMenu = (s: PlanStepView): MenuAction[] => {
    if (!movable(s.index)) return [];
    const n = view.total;
    return [
      ...(s.index > free
        ? [
            {
              id: 'up',
              label: 'Move up',
              icon: ArrowUp,
              onSelect: () => edit({ op: 'move', from: s.index, to: s.index - 1 }, 'Step moved'),
            },
          ]
        : []),
      ...(s.index < n - 1
        ? [
            {
              id: 'down',
              label: 'Move down',
              icon: ArrowDown,
              onSelect: () => edit({ op: 'move', from: s.index, to: s.index + 1 }, 'Step moved'),
            },
          ]
        : []),
      ...(n < 8
        ? [
            {
              id: 'before',
              label: 'Add my approval before',
              icon: User,
              onSelect: () => setAdding(s.index),
            },
            {
              id: 'after',
              label: 'Add my approval after',
              icon: User,
              onSelect: () => setAdding(s.index + 1),
            },
          ]
        : []),
      ...(n > 1
        ? [
            {
              id: 'remove',
              label: 'Remove step',
              icon: Trash2,
              tone: 'danger' as const,
              onSelect: () => edit({ op: 'remove', index: s.index }, 'Step removed'),
            },
          ]
        : []),
    ];
  };

  const onDrop = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = drag;
    setDrag(null);
    if (from === null || from === to || !movable(from) || !movable(to)) return;
    edit({ op: 'move', from, to }, 'Step moved');
  };

  const mainButton =
    main?.kind === 'approvePlan' ? (
      counting ? (
        <UndoButton countdown={counting} variant="approve" />
      ) : (
        <Button
          variant="approve"
          data-approve-plan=""
          className={sheet ? 'w-full' : undefined}
          onClick={approveAll}
          leading={<Icon icon={Check} size={16} />}
        >
          Approve plan
        </Button>
      )
    ) : null;

  const body = (s: PlanStepView) => {
    const row = outcomes.find((o) => o.id === s.outcomeId);
    if (!row) return null;
    const o = row.data;
    const t = outcomeType(o.type);
    if (s.kind === 'agent' && (o.state === 'proposed' || o.state === 'revising') && live)
      return (
        <ProposalPanel
          wid={wid}
          thread={thread}
          proposals={[row]}
          sender={props.sender}
          now={props.now}
          busy={props.busy}
          agentName={agentName}
          onDone={() => setOpenId('')}
          narrow
          plan={pl}
          onRemove={
            movable(s.index) && view.total > 1
              ? () => edit({ op: 'remove', index: s.index }, 'Step removed')
              : undefined
          }
        />
      );
    return (
      <div className="mt-2 rounded-card border border-line bg-surface-2 p-3.5">
        <div className="flex flex-col gap-2.5">
          {Object.entries(t?.fields ?? {}).map(([k, f]) => (
            <FieldView
              key={k}
              name={k}
              field={f}
              value={o.fields[k]}
              editing={false}
              onChange={() => undefined}
            />
          ))}
        </div>
        {o.state === 'failed' ? (
          <p className="mt-3 text-14 text-sendback">
            Failed{o.result?.error ? `: ${o.result.error}` : ''}
          </p>
        ) : null}
        {o.state === 'running' && o.result?.itemId ? (
          <p data-running-item="" className="mt-3 text-14 text-text-2">
            Item {o.result.itemId} is being built; the plan goes on when it is Done.
          </p>
        ) : null}
        {o.state === 'done' && o.result?.permalink ? (
          <a
            href={o.result.permalink}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-14 font-medium text-agent hov:underline"
          >
            Open the result
          </a>
        ) : null}
        {s.kind === 'human' && o.state === 'proposed' && live ? (
          s.atCursor ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {counting ? (
                <UndoButton countdown={counting} variant="approve" />
              ) : (
                <>
                  <Button
                    variant="approve"
                    data-gate-approve=""
                    onClick={() => gate(s, true)}
                    leading={<Icon icon={Check} size={16} />}
                  >
                    Approve
                  </Button>
                  <Button variant="sendback" data-gate-reject="" onClick={() => gate(s, false)}>
                    Not approved
                  </Button>
                </>
              )}
            </div>
          ) : (
            <p className="mt-3 text-13 text-text-2">
              Waits for you when step {s.number} is reached; the steps after it run only once you
              approve.
            </p>
          )
        ) : null}
        {o.state === 'failed' && plan.data.state === 'blocked' ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {counting ? (
              <UndoButton countdown={counting} variant="approve" />
            ) : (
              <>
                <Button variant="approve" data-retry="" onClick={retry}>
                  Retry
                </Button>
                <Button variant="secondary" data-skip="" onClick={skip}>
                  Skip
                </Button>
                <Button variant="sendback" data-stop="" onClick={stop}>
                  Stop plan
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section
      aria-label="Plan"
      data-plan={plan.id}
      data-plan-state={plan.data.state}
      className="px-4 py-4 sm:px-5"
    >
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-15 font-semibold text-ink">
          {plan.data.state === 'proposed' ? `${agent} proposes a plan` : `${agent}’s plan`}
        </h2>
        {sheet ? (
          <span className="text-13 text-text-2">
            {view.through} of {view.total} done
          </span>
        ) : (
          <ConfidenceMeter value={plan.data.confidence ?? undefined} />
        )}
      </div>
      {plan.data.note && !sheet ? (
        <p className="mt-1.5 text-14 text-text-2 [overflow-wrap:anywhere]">{plan.data.note}</p>
      ) : null}
      {!sheet ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
            Plan · {view.total} {view.total === 1 ? 'step' : 'steps'}
          </p>
          <p data-plan-progress="" className="text-13 text-text-2">
            {live ? planSummary(pl) || view.progress : view.progress}
          </p>
          <span className="ml-auto">{mainButton}</span>
        </div>
      ) : null}
      <div aria-hidden className="mt-3 flex gap-1">
        {view.steps.map((s) => (
          <span key={s.outcomeId} className={cn('h-1.5 flex-1 rounded-full', BAR[s.ui])} />
        ))}
      </div>
      {plan.data.state === 'proposed' && !sheet ? (
        <p className="mt-2 text-13 text-text-2">
          Steps run in order. Approve plan approves the agent steps; your approval steps still wait
          for you when they are reached.
        </p>
      ) : null}
      {old && live ? (
        <p
          data-cli-old=""
          className="mt-3 flex items-start gap-2 rounded-btn border border-gate bg-gate-bg px-3 py-2 text-13 text-gate-text [overflow-wrap:anywhere]"
        >
          <Icon icon={TriangleAlert} size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            {agentName(thread.data.fetchedBy)} needs a Hivenod update to run plans step by step (it
            runs {have}; this needs {minVersionFor('plan')}). Ask its owner to run{' '}
            <code>hivenod update</code> and restart the session before you approve.
          </span>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {error}
        </p>
      ) : null}
      <ol aria-label="Steps" className="mt-3 flex flex-col">
        {view.steps.map((s) => {
          const row = outcomes.find((o) => o.id === s.outcomeId);
          const open = shownId === s.outcomeId;
          const menu = stepMenu(s);
          const title = stepTitle(s.type, row?.data.fields ?? {});
          return (
            <li
              key={s.outcomeId}
              data-step={s.number}
              data-step-ui={s.ui}
              data-outcome={s.outcomeId}
              className={cn('relative py-2', drag !== null && movable(s.index) && 'rounded-btn')}
              onDragOver={movable(s.index) && drag !== null ? (e) => e.preventDefault() : undefined}
              onDrop={movable(s.index) ? onDrop(s.index) : undefined}
            >
              <div className="flex items-center gap-2">
                {live && !sheet ? (
                  <span
                    aria-hidden
                    draggable={movable(s.index)}
                    onDragStart={() => setDrag(s.index)}
                    onDragEnd={() => setDrag(null)}
                    className={cn('text-text-3', movable(s.index) ? 'cursor-grab' : 'invisible')}
                  >
                    <Icon icon={GripVertical} size={15} />
                  </span>
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-full border-2 text-12 font-semibold',
                    CIRCLE[s.ui],
                  )}
                >
                  {s.ui === 'done' ? <Icon icon={Check} size={14} /> : s.number}
                </span>
                <span
                  aria-hidden
                  title={s.kind === 'human' ? 'Your approval' : 'Agent action'}
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-btn border',
                    s.kind === 'human'
                      ? 'border-gate/60 bg-gate-bg text-gate-text'
                      : 'border-agent/30 bg-agent-soft text-agent',
                  )}
                >
                  <Icon icon={s.kind === 'human' ? User : Zap} size={13} />
                </span>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`Step ${s.number}: ${title}, ${s.kind === 'human' ? 'your approval' : 'agent action'}, ${STEP_UI_TEXT[s.ui]}`}
                  title={title}
                  onClick={() => setOpenId(open ? '' : s.outcomeId)}
                  className="min-w-0 flex-1 truncate text-left text-14 font-semibold text-ink hov:underline foc:outline-2 foc:outline-focus"
                >
                  {title}
                </button>
                <Pill tone={PILL[s.ui]}>
                  {s.ui === 'waitingForYou' && sheet ? 'You' : STEP_UI_TEXT[s.ui]}
                </Pill>
                {menu.length ? (
                  <ActionMenu
                    label={`Step ${s.number} actions`}
                    actions={menu}
                    trigger={
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2"
                        disabled={!!counting}
                        aria-label={`Step ${s.number} actions`}
                      >
                        <Icon icon={MoreHorizontal} size={16} />
                      </Button>
                    }
                  />
                ) : (
                  <span className="w-9" aria-hidden />
                )}
              </div>
              {open ? <div className="pl-9 sm:pl-14">{body(s)}</div> : null}
            </li>
          );
        })}
      </ol>
      {live ? (
        <div
          className={cn(
            'mt-3 flex flex-wrap items-center gap-2',
            sheet && 'sticky bottom-0 -mx-4 border-t border-line bg-surface px-4 py-3',
          )}
        >
          {sheet ? (
            <>
              <span className="flex-1">
                {main?.kind === 'approvePlan' ? (
                  mainButton
                ) : main?.kind === 'step' ? (
                  counting ? (
                    <UndoButton countdown={counting} variant="approve" />
                  ) : main.gate ? (
                    <Button
                      variant="approve"
                      className="w-full"
                      onClick={() => gate(view.steps[main.index]!, true)}
                      leading={<Icon icon={Check} size={16} />}
                    >
                      Approve step {main.index + 1}
                    </Button>
                  ) : (
                    <Button
                      variant="approve"
                      className="w-full"
                      onClick={() => setOpenId(main.outcomeId)}
                    >
                      Review step {main.index + 1}
                    </Button>
                  )
                ) : main?.kind === 'retry' ? (
                  <Button variant="approve" className="w-full" onClick={retry}>
                    Retry step {main.index + 1}
                  </Button>
                ) : null}
              </span>
              <Button
                variant="secondary"
                aria-label="Reject plan"
                disabled={!!counting}
                onClick={rejectAll}
              >
                <Icon icon={X} size={16} />
              </Button>
              <ActionMenu
                label="Plan actions"
                actions={[
                  ...(view.total < 8
                    ? [
                        {
                          id: 'add',
                          label: 'Add an approval step',
                          icon: Plus,
                          onSelect: () => setAdding(view.total),
                        },
                      ]
                    : []),
                  ...(plan.data.state !== 'proposed'
                    ? [{ id: 'stop', label: 'Stop plan', icon: X, onSelect: stop }]
                    : []),
                ]}
                trigger={
                  <Button variant="secondary" aria-label="Plan actions" disabled={!!counting}>
                    <Icon icon={MoreHorizontal} size={16} />
                  </Button>
                }
              />
            </>
          ) : (
            <>
              {view.total < 8 ? (
                <Button
                  variant="secondary"
                  disabled={!!counting}
                  onClick={() => setAdding(view.total)}
                  leading={<Icon icon={Plus} size={15} />}
                >
                  Add an approval step
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="ml-auto text-sendback"
                disabled={!!counting}
                onClick={rejectAll}
              >
                Reject plan
              </Button>
            </>
          )}
        </div>
      ) : null}
      <AddApproval
        open={adding !== null}
        index={adding ?? 0}
        onClose={() => setAdding(null)}
        onAdd={(fields) => {
          const at = Math.max(adding ?? view.total, free);
          setAdding(null);
          edit({ op: 'add', index: at, fields }, 'Approval step added');
        }}
      />
    </section>
  );
}

function AddApproval({
  open,
  index,
  onClose,
  onAdd,
}: {
  open: boolean;
  index: number;
  onClose: () => void;
  onAdd: (fields: { what: string; detail?: string }) => void;
}) {
  const [what, setWhat] = useState('');
  const [detail, setDetail] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add an approval step"
      description={`Step ${index + 1} waits for you: the steps after it run only once you approve.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="approve"
            disabled={!what.trim()}
            onClick={() => {
              onAdd({ what: what.trim(), ...(detail.trim() ? { detail: detail.trim() } : {}) });
              setWhat('');
              setDetail('');
            }}
          >
            Add step
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="What you approve"
          name="what"
          value={what}
          maxLength={300}
          onChange={(e) => setWhat(e.target.value)}
        />
        <Textarea
          label="Detail (optional)"
          name="detail"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
      </div>
    </Dialog>
  );
}
