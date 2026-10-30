/**
 * The Inbox's Waiting view (item "Inbox: Waiting view with bulk Re-check"): the member's threads
 * waiting on them, a third party, an item, a date or the agent, with a checkbox per row,
 * "Re-check N" for the selection and "Re-check all N". Each thread gets the existing Re-check
 * (requestRecheck, the agent's `recheck` inbox event), one write per thread, after one 5 s Undo;
 * a thread whose re-check still waits for its agent is not asked twice. Rows say "re-checking…"
 * until the summary moves to a new version, then "updated just now · vN". No polling: the rows
 * follow the Inbox list's thread listener.
 */
import { requestRecheck, type ActionPlan } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { Check, Clock, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNow } from '../activity/data';
import { useReady } from '../auth/context';
import { waitLabel } from '../inbox/logic';
import { stash } from '../lib/pendingDecisions';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { recheckTargets, rowKey, rowStatus, type RowStatus } from './bulkRecheck';
import { summaryLine } from './decision';
import type { ThreadRow } from './logic';
import { errorText, StateChip } from './parts';

const BULK_KEY = 'rk:bulk';

export function WaitingView({
  threads,
  subjectName,
  org,
}: {
  /** The member's waiting threads (waitingThreads), in the scope on show. */
  threads: readonly ThreadRow[];
  subjectName: (t: ThreadRow) => string | null;
  /** The organization's name and colour, when the list spans several. */
  org: (wid: string) => { name: string; color: string } | null;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const counting = useCountdown(BULK_KEY);
  // A local clock only (no reads): "re-checking…" lapses after the agent answered.
  const now = useNow(30_000);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const keys = useMemo(() => new Set(threads.map(rowKey)), [threads]);
  // A thread that left the view drops out of the selection.
  const selected = useMemo(() => new Set([...picked].filter((k) => keys.has(k))), [picked, keys]);
  const forSelected = recheckTargets(threads, selected, now);
  const forAll = recheckTargets(threads, 'all', now);
  const allPicked = threads.length > 0 && selected.size === threads.length;

  function toggle(k: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }

  function recheck(targets: ThreadRow[], tag: 'selected' | 'all') {
    if (!targets.length || counting) return;
    setError(null);
    const plans: Array<{ wid: string; plan: ActionPlan }> = [];
    for (const t of targets) {
      const ctx = actionContext(t.wid);
      if (!ctx) continue;
      try {
        plans.push({
          wid: t.wid,
          plan: requestRecheck(ctx, { threadId: t.id, thread: { ...t.data }, nowMs: now }),
        });
      } catch {
        /* moved on since (no longer waiting, or already asked): skipped */
      }
    }
    if (!plans.length) return;
    // Kept across a reload until written, one entry per organization.
    const forgets = [...new Set(plans.map((p) => p.wid))].map((wid) =>
      stash(
        session.me.uid,
        wid,
        plans.filter((p) => p.wid === wid).map((p) => p.plan.ops),
        'Saved: Re-check asked',
      ),
    );
    const forget = () => forgets.forEach((f) => f());
    const n = plans.length;
    toast.push({
      message: `Re-check asked for ${n} thread${n === 1 ? '' : 's'}`,
      duration: 5000,
      countdown: {
        key: BULK_KEY,
        tag,
        announce: `Re-check asked for ${n} thread${n === 1 ? '' : 's'}. Undo available for 5 seconds`,
      },
      onUndo: forget,
      onCommit: () => {
        setPicked(new Set());
        // One write per thread: a refused one does not hold up the others.
        void Promise.allSettled(plans.map((p) => run(p.plan))).then((res) => {
          forget();
          const failed = res.filter((r) => r.status === 'rejected');
          if (failed.length)
            setError(
              `${failed.length} of ${n} could not be asked: ${errorText((failed[0] as PromiseRejectedResult).reason)}`,
            );
        });
      },
    });
  }

  if (!threads.length)
    return (
      <p
        data-waiting-empty=""
        className="rounded-card border border-dashed border-line-strong px-4 py-8 text-center text-14 text-text-2"
      >
        Nothing is waiting.
      </p>
    );

  return (
    <section data-group="waiting-view" aria-label="Waiting">
      <div
        data-bulk-bar=""
        className="sticky top-0 z-[2] mb-2 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3.5 py-2"
      >
        <label className="mr-auto flex min-h-11 cursor-pointer items-center gap-3 text-14 font-semibold text-ink">
          <input
            type="checkbox"
            data-select-all=""
            className="size-5 accent-[var(--color-agent)]"
            checked={allPicked}
            ref={(el) => {
              if (el) el.indeterminate = selected.size > 0 && !allPicked;
            }}
            onChange={() => setPicked(allPicked ? new Set() : new Set(keys))}
            aria-label="Select all waiting threads"
          />
          <span aria-live="polite">{selected.size ? `${selected.size} selected` : 'Select'}</span>
        </label>
        {counting ? (
          <UndoButton
            countdown={counting}
            variant={counting.tag === 'selected' ? 'primary' : 'secondary'}
          />
        ) : (
          <>
            {selected.size ? (
              <Button
                variant="primary"
                data-recheck-selected=""
                disabled={forSelected.length === 0}
                onClick={() => recheck(forSelected, 'selected')}
                leading={<Icon icon={RefreshCw} size={15} />}
              >
                Re-check {forSelected.length}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              data-recheck-all=""
              disabled={forAll.length === 0}
              onClick={() => recheck(forAll, 'all')}
              leading={<Icon icon={RefreshCw} size={15} className="text-agent" />}
            >
              Re-check all {forAll.length}
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-14 text-sendback">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2" aria-label="Waiting threads">
        {threads.map((t) => {
          const k = rowKey(t);
          const o = org(t.wid);
          const subject = subjectName(t);
          const line = summaryLine(t.data);
          const title = t.data.title || 'Untitled thread';
          return (
            <li
              key={k}
              data-thread={t.id}
              className="relative flex items-center gap-x-3 gap-y-1.5 rounded-card border border-line bg-surface px-3.5 py-2.5 transition-colors hov:bg-canvas max-sm:flex-wrap"
            >
              <input
                type="checkbox"
                data-select=""
                className="relative z-[1] size-5 shrink-0 accent-[var(--color-agent)]"
                checked={selected.has(k)}
                onChange={() => toggle(k)}
                aria-label={`Select ${title}`}
              />
              {o ? (
                <span
                  aria-hidden
                  title={o.name}
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: o.color }}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-15 font-semibold text-ink">
                  <Link
                    to="/inbox/$wid/t/$tid"
                    params={{ wid: t.wid, tid: t.id }}
                    className="rounded-sm after:absolute after:inset-0 after:content-[''] foc:outline-2 foc:outline-focus"
                  >
                    {title}
                  </Link>
                  {o ? <span className="sr-only"> · {o.name}</span> : null}
                </h3>
                <p className="truncate text-13 text-text-2">
                  {[subject, line].filter(Boolean).join(' · ') || ' '}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 max-sm:basis-full max-sm:pl-8">
                <StateChip state={t.data.state} waiting={t.data.waiting} />
                <StatusText status={rowStatus(t.data, now)} now={now} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "re-checking…", "updated just now · v4", "checked 5 min ago · still good", "updated 2 d ago". */
function StatusText({ status, now }: { status: RowStatus; now: number }) {
  const ago = (at: number) => {
    const l = waitLabel(at, now);
    return l === 'just now' ? l : `${l} ago`;
  };
  const base = 'flex w-44 items-center gap-1.5 text-13 max-sm:w-auto';
  switch (status.kind) {
    case 'rechecking':
      return (
        <span
          data-row-status="rechecking"
          role="status"
          className={cn(base, 'font-semibold text-agent')}
        >
          <Icon icon={Loader2} size={14} className="shrink-0 motion-safe:animate-spin" />
          re-checking…
        </span>
      );
    case 'updated':
      return (
        <span data-row-status="updated" className={cn(base, 'font-semibold text-approve-text')}>
          <Icon icon={Check} size={14} className="shrink-0" />
          updated {ago(status.at)} · v{status.version}
        </span>
      );
    case 'checked':
      return (
        <span data-row-status="checked" className={cn(base, 'text-text-2')}>
          <Icon icon={Check} size={14} className="shrink-0 text-approve-text" />
          checked {ago(status.at)}
          {status.result === 'still_good' ? ' · still good' : ''}
        </span>
      );
    case 'idle':
      return (
        <span data-row-status="idle" className={cn(base, 'text-text-2')}>
          {status.at !== null ? (
            <>
              <Icon icon={Clock} size={14} className="shrink-0" />
              updated {ago(status.at)}
            </>
          ) : null}
        </span>
      );
  }
}
