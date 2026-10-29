/**
 * Re-check (item bmNoIvvqKCdAorLSShE9): the member asks the thread's home agent to check it again.
 * The request counts down on the pressed button with Undo (5 s) before it is written; while the
 * agent works a "Checking again…" strip sits on the proposal; then a result line ("Checked again
 * 16:40 · still good"). A proposal that may be out of date (slot passed, a newer message, older
 * than 24 h; packages/shared/src/stale.ts) shows a chip with the reason and Re-check next to it.
 */
import {
  agentSchema,
  cliSupports,
  minVersionFor,
  paths,
  recheckPending,
  requestRecheck,
  staleReason,
  staleText,
  type InboxOutcome,
  type InboxThread,
} from '@hive/shared';
import { Check, Clock, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { useLiveDoc, type Row } from '../lib/live';
import { stash } from '../lib/pendingDecisions';
import { hhmm } from '../today/logic';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { useCountdown, useToast, type Countdown } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { errorText } from './parts';

export interface RecheckState {
  /** The request is counting down (Undo on the button that was pressed). */
  counting: Countdown | undefined;
  /** The agent is checking again. */
  pending: boolean;
  /** Re-check may be asked now (the thread has something open, nothing pending). */
  can: boolean;
  /** Starts the countdown; `tag` says which button shows the Undo. */
  request: (tag?: string) => void;
}

/** The countdown key of a thread's re-check request. */
export const recheckKey = (wid: string, tid: string) => `rk:${wid}:${tid}`;

export function useRecheck(
  wid: string,
  thread: Row<InboxThread>,
  now: number,
  onError?: (msg: string) => void,
): RecheckState {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const key = recheckKey(wid, thread.id);
  const counting = useCountdown(key);
  const t = thread.data;
  const pending = recheckPending(t, now);
  const can = (t.state === 'yourCall' || t.state === 'waiting') && !pending && !counting;
  function request(tag = 'recheck') {
    const ctx = actionContext(wid);
    if (!ctx || !can) return;
    let plan;
    try {
      plan = requestRecheck(ctx, { threadId: thread.id, thread: { ...t }, nowMs: now });
    } catch (e) {
      onError?.(errorText(e));
      return;
    }
    const forget = stash(session.me.uid, wid, [plan.ops], 'Saved: Re-check asked');
    const p = plan;
    toast.push({
      message: 'Re-check asked',
      duration: 5000,
      countdown: { key, tag, announce: 'Re-check asked. Undo available for 5 seconds' },
      onUndo: forget,
      onCommit: () => {
        run(p).then(
          () => forget(),
          (e: unknown) => {
            forget();
            onError?.(errorText(e));
          },
        );
      },
    });
  }
  return { counting, pending, can, request };
}

/** The Re-check button, which turns into Undo while its request counts down. */
export function RecheckButton({
  rc,
  tag = 'recheck',
  label = 'Re-check',
  className,
  variant = 'secondary',
}: {
  rc: RecheckState;
  tag?: string;
  label?: string;
  className?: string;
  variant?: 'secondary' | 'ghost';
}) {
  if (rc.counting?.tag === tag)
    return <UndoButton countdown={rc.counting} variant={variant} className={className} />;
  return (
    <Button
      variant={variant}
      data-recheck=""
      className={className}
      disabled={!rc.can}
      onClick={() => rc.request(tag)}
      leading={<Icon icon={RefreshCw} size={15} className="text-agent" />}
    >
      {label}
    </Button>
  );
}

/** "Checking again…" while pending, else the last answer, if it is about what is on show. */
export function RecheckLine({
  wid,
  thread,
  now,
  agent,
  since,
}: {
  wid: string;
  thread: Row<InboxThread>;
  now: number;
  agent: string;
  /** Hide an answer older than this (ms): it was about an earlier proposal. */
  since?: number;
}) {
  const r = thread.data.recheck;
  const pending = recheckPending(thread.data, now);
  const home = useLiveDoc(pending ? paths.agent(wid, thread.data.fetchedBy) : null, agentSchema);
  const have = home.state === 'ready' ? home.data?.cliVersion : undefined;
  const old =
    pending && home.state === 'ready' && !!home.data && cliSupports('recheck', have) === 'old';
  if (pending)
    return (
      <div className="mt-3">
        <p
          data-rechecking=""
          role="status"
          className="flex items-start gap-2 rounded-btn border border-dashed border-agent/50 bg-surface px-3 py-2 text-13 text-agent [overflow-wrap:anywhere]"
        >
          <Icon icon={Loader2} size={15} className="mt-0.5 shrink-0 motion-safe:animate-spin" />
          <span className="min-w-0">
            <span className="font-semibold">Checking again…</span> {agent} re-reads the thread, your
            calendar and what changed.
          </span>
        </p>
        {old ? (
          <p
            data-cli-old=""
            className="mt-2 flex items-start gap-2 rounded-btn border border-gate bg-gate-bg px-3 py-2 text-13 text-gate-text [overflow-wrap:anywhere]"
          >
            <Icon icon={TriangleAlert} size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              {agent} needs a Hivenod update to do this (it runs {have}; this needs{' '}
              {minVersionFor('recheck')}). Ask its owner to run <code>hivenod update</code> and
              restart the session.
            </span>
          </p>
        ) : null}
      </div>
    );
  if (!r || r.state !== 'done' || !r.at || !r.result) return null;
  const at = r.at.toMillis();
  if (since !== undefined && at < since) return null;
  const what =
    r.result === 'still_good'
      ? 'still good'
      : r.result === 'revised'
        ? 'new version below'
        : `${agent} asked you`;
  return (
    <p
      data-recheck-result={r.result}
      className="mt-2.5 flex items-start gap-2 text-13 text-text-2 [overflow-wrap:anywhere]"
    >
      <Icon icon={Check} size={14} className="mt-0.5 shrink-0 text-approve-text" />
      <span className="min-w-0">
        <span className="font-medium text-ink">
          Checked again {hhmm(new Date(at))} · {what}
        </span>
        {r.note ? <span> · {r.note}</span> : null}
      </span>
    </p>
  );
}

/** "May be out of date" with its reason (hover, or tap to show it) and Re-check next to it. */
export function StaleChip({
  outcome,
  thread,
  now,
  rc,
}: {
  outcome: Row<InboxOutcome>;
  thread: Row<InboxThread>;
  now: number;
  rc: RecheckState;
}) {
  const [open, setOpen] = useState(false);
  if (rc.pending) return null;
  const reason = staleReason(outcome.data, thread.data, now);
  if (!reason) return null;
  const why = staleText(reason, outcome.data, now);
  return (
    <div data-stale={reason} className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        title={why}
        aria-expanded={open}
        data-stale-chip=""
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-gate bg-gate-bg px-2.5 text-13 font-medium text-gate-text foc:outline-2 foc:outline-focus"
      >
        <Icon icon={Clock} size={14} />
        May be out of date
        <span className="sr-only">: {why}</span>
      </button>
      <RecheckButton rc={rc} tag="stale" className="min-h-8" />
      {open ? (
        <p data-stale-why="" aria-hidden className="basis-full text-13 text-gate-text">
          {why}
        </p>
      ) : null}
    </div>
  );
}
