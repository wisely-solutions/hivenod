/**
 * Scheduled tasks, slice 5: the proposal card of an agent's schedule on the decision page (design
 * 9.2, propose.png). The rule in words with its zone, the next 3 runs (computed here, never read),
 * each run's thread, the plan of each run, what happens when a run can't happen, and Set up
 * schedule / Ask for changes / Not now. Approving goes through approveOutcome with the schedule
 * doc, which activates it in the same batch (the web, Telegram and the rules: one action).
 * Reads: the proposed schedule (one doc), the subject it is filed under, and for a change the
 * active schedule it replaces.
 */
import {
  approveOutcome,
  cancelRevision,
  inboxPaths,
  inboxSubjectSchema,
  INBOX_LIMITS,
  rejectOutcome,
  requestRevision,
  scheduleSchema,
  schedulePaths,
  versionCount,
  type ActionPlan,
  type InboxOutcome,
  type InboxThread,
} from '@hive/shared';
import { Check } from 'lucide-react';
import { forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { useLiveDoc, type Row } from '../lib/live';
import { stash } from '../lib/pendingDecisions';
import type { DecisionCardHandle } from '../today/DecisionCard';
import { AskBox, RevisingStrip } from '../today/Revise';
import { Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { errorText } from './parts';
import { scheduleCard } from './schedule';

export interface SchedulePanelProps {
  wid: string;
  thread: Row<InboxThread>;
  /** The `schedule` outcome. */
  outcome: Row<InboxOutcome>;
  now: number;
  agentName: (id: string) => string;
  onDone: (label: string) => void;
  /** Not now, next to the buttons. */
  extra?: ReactNode;
}

const H = 'font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3';

export const SchedulePanel = forwardRef<DecisionCardHandle, SchedulePanelProps>(
  function SchedulePanel(props, ref) {
    const { wid, thread, outcome: o, now, agentName, onDone } = props;
    const { session, actionContext, run } = useReady();
    const toast = useToast();
    const sid = typeof o.data.fields.scheduleId === 'string' ? o.data.fields.scheduleId : '';
    const live = useLiveDoc(sid ? schedulePaths.schedule(wid, sid) : null, scheduleSchema);
    const sch = live.state === 'ready' ? live.data : null;
    const replacedLive = useLiveDoc(
      sch?.replaces ? schedulePaths.schedule(wid, sch.replaces) : null,
      scheduleSchema,
    );
    const subjectLive = useLiveDoc(
      sch?.subjectId ? inboxPaths.subject(wid, sch.subjectId) : null,
      inboxSubjectSchema,
    );
    const key = `io:${wid}:${o.id}`;
    const counting = useCountdown(key);
    const [asking, setAsking] = useState(false);
    const [askText, setAskText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const agent = agentName(sch?.agentUid ?? o.data.proposedBy);
    const revising = o.data.state === 'revising';
    const nv = versionCount(o.data);

    function count(plan: Pick<ActionPlan, 'ops'>, announce: string, done: string) {
      const forget = stash(session.me.uid, wid, [plan.ops], `Saved: ${done}`);
      toast.push({
        message: announce,
        duration: 5000,
        countdown: { key, tag: 'approve', announce: `${announce}. Undo available for 5 seconds` },
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
      if (!ctx || !sch || counting) return;
      if (sch.replaces && replacedLive.state !== 'ready') return;
      setError(null);
      let plan;
      try {
        plan = approveOutcome(ctx, {
          outcomeId: o.id,
          outcome: o.data,
          thread: { ...thread.data },
          schedule: {
            id: sid,
            data: sch,
            replaced:
              replacedLive.state === 'ready' && replacedLive.data
                ? { version: replacedLive.data.version }
                : null,
          },
          ...(o.data.versions?.length ? { version: nv } : {}),
          othersPending: false,
        });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      count(plan, 'Schedule set up', `Schedule set up · ${sch.title}`);
    }

    function reject() {
      const ctx = actionContext(wid);
      if (!ctx || counting || revising) return;
      setError(null);
      let plan;
      try {
        plan = rejectOutcome(ctx, {
          outcomeId: o.id,
          outcome: o.data,
          thread: { ...thread.data },
          othersPending: false,
        });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      count(plan, 'Rejected', `Rejected · ${sch?.title ?? 'schedule'}`);
    }

    async function act(build: () => ActionPlan, after?: () => void) {
      if (busy) return;
      setError(null);
      setBusy(true);
      try {
        await run(build());
        after?.();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    }
    const askAgent = () => {
      const ctx = actionContext(wid);
      if (!ctx) return;
      void act(
        () =>
          requestRevision(ctx, {
            outcomeId: o.id,
            outcome: o.data,
            thread: { ...thread.data },
            instruction: askText,
          }),
        () => {
          setAsking(false);
          setAskText('');
        },
      );
    };
    const cancelAsk = () => {
      const ctx = actionContext(wid);
      if (!ctx) return;
      void act(() =>
        cancelRevision(ctx, { outcomeId: o.id, outcome: o.data, thread: { ...thread.data } }),
      );
    };
    const canAsk = !revising && nv < INBOX_LIMITS.versions;

    useImperativeHandle(ref, () => ({
      approve,
      edit: () => undefined,
      reject,
      ask: () => {
        if (!canAsk || counting) return false;
        setAsking(true);
        return true;
      },
    }));

    if (!sch) {
      return (
        <p data-schedule-loading="" className="mt-3 text-14 text-text-2">
          {live.state === 'loading'
            ? 'Loading the schedule…'
            : 'This schedule is no longer waiting for your approval.'}
        </p>
      );
    }
    const c = scheduleCard(sch, now);
    const subject = subjectLive.state === 'ready' ? subjectLive.data?.name : null;
    return (
      <div data-schedule-card={sid}>
        <p data-schedule-sentence="" className="mt-1 text-15 text-ink [overflow-wrap:anywhere]">
          {c.sentence}
        </p>
        {o.data.note ? (
          <p className="mt-1 text-14 text-text-2 [overflow-wrap:anywhere]">
            {agent}: {o.data.note}
            {o.data.confidence ? ` · confidence ${o.data.confidence}` : ''}
          </p>
        ) : null}
        <div className="mt-3 grid gap-4 rounded-card border border-line bg-surface p-3.5 sm:grid-cols-2 sm:p-4">
          <div className="min-w-0">
            <p className={H}>Next runs</p>
            {c.runs.length ? (
              <ul data-schedule-runs="" className="mt-1.5 flex flex-col gap-0.5 text-14 text-ink">
                {c.runs.map((r) => (
                  <li key={r} className="tabular-nums">
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-14 text-text-2">No run left: its time has passed.</p>
            )}
            <p className={`${H} mt-3`}>Each run</p>
            <p
              data-schedule-run-title=""
              className="mt-1.5 text-14 text-ink [overflow-wrap:anywhere]"
            >
              New thread “{c.runTitle}”{subject ? ` in ${subject}` : ''}
            </p>
          </div>
          <div className="min-w-0">
            <p className={H}>Plan each run</p>
            <ol data-schedule-plan="" className="mt-1.5 flex flex-col gap-1 text-14 text-ink">
              {c.steps.map((s, i) => (
                <li key={i} className="flex items-baseline gap-1.5 [overflow-wrap:anywhere]">
                  <span className="shrink-0 tabular-nums text-text-2">{i + 1}.</span>
                  <span className="min-w-0">
                    {s.title}{' '}
                    <Pill tone={s.who === 'you' ? 'gate' : 'agent'} className="align-middle">
                      {s.who === 'you' ? 'You' : agent}
                    </Pill>
                  </span>
                </li>
              ))}
            </ol>
            <p className={`${H} mt-3`}>If a run can’t happen</p>
            <p data-schedule-cant-run="" className="mt-1.5 text-13 text-text-2">
              {c.cantRun}
            </p>
          </div>
        </div>
        {revising && o.data.revise ? (
          <RevisingStrip
            agent={agent}
            asked={{ chips: o.data.revise.chips, instruction: o.data.revise.instruction }}
            wid={wid}
            agentId={o.data.proposedBy}
          />
        ) : null}
        {asking ? (
          <AskBox
            chips={[]}
            text={askText}
            next={nv + 1}
            busy={busy}
            noChips
            placeholder="At 08:30, and on a weekend move it to Monday"
            onChips={() => undefined}
            onText={setAskText}
            onCancel={() => setAsking(false)}
            onAsk={askAgent}
          />
        ) : null}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {counting ? (
            <UndoButton countdown={counting} variant="approve" />
          ) : (
            <>
              <Button
                variant="approve"
                data-schedule-approve=""
                className="max-sm:w-full"
                onClick={approve}
                leading={<Icon icon={Check} size={16} />}
              >
                Set up schedule
              </Button>
              {revising ? (
                <Button
                  variant="secondary"
                  data-schedule-cancel-ask=""
                  className="max-sm:w-full"
                  loading={busy}
                  onClick={cancelAsk}
                >
                  Cancel the request
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  data-schedule-ask=""
                  aria-expanded={asking}
                  disabled={!canAsk}
                  className="max-sm:w-full"
                  onClick={() => setAsking(!asking)}
                >
                  Ask for changes
                </Button>
              )}
              {props.extra}
              <ActionMenu
                label="More decisions"
                actions={[
                  {
                    id: 'reject-schedule',
                    label: 'Reject: don’t schedule it',
                    tone: 'danger',
                    onSelect: reject,
                  },
                ]}
                trigger={
                  <Button
                    variant="ghost"
                    data-more-decisions=""
                    aria-label="More decisions"
                    className="min-h-11 px-3 max-sm:w-full"
                  >
                    More
                  </Button>
                }
              />
            </>
          )}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-14 text-sendback">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
