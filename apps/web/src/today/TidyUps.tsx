/**
 * The tidy-ups card at the end of the Today stack (item kt3E7u9EliL3q2veDDI0, design 2.1 and
 * 3.4): proposals that send nothing (no reply, ignore, snooze), proposed with high confidence.
 * Review lists them, each with "Keep for me" (it moves into the stack); Approve all approves them
 * in one batch with one Undo on the button, no toast.
 */
import { approveOutcome, outcomeType, type ActionPlan } from '@hive/shared';
import { Archive, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { stash } from '../lib/pendingDecisions';
import type { NeedsEntry } from '../needs/logic';
import { errorText } from '../threads/parts';
import { Button } from '../ui/button';
import { Toggle } from '../ui/form';
import { Icon } from '../ui/icon';
import { useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { proposalSentence, tidySummary } from './logic';

export const TIDY_KEY = 'today:tidy-ups';

export function TidyUps({
  entries,
  kept,
  onKeep,
  onDone,
}: {
  /** Every tidy-up, the kept ones included (they show in the list, switched on). */
  entries: NeedsEntry[];
  kept: ReadonlySet<string>;
  onKeep: (key: string, keep: boolean) => void;
  onDone: (keys: string[]) => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const counting = useCountdown(TIDY_KEY);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const batch = entries.filter((e) => !kept.has(e.key));
  const n = batch.length;
  if (entries.length === 0) return null;

  function approveAll() {
    if (counting || n === 0) return;
    setError(null);
    const plans: { wid: string; key: string; plan: Pick<ActionPlan, 'ops'> }[] = [];
    try {
      for (const e of batch) {
        const ctx = actionContext(e.wid);
        const o = e.proposals?.[0];
        if (!ctx || !o) continue;
        plans.push({
          wid: e.wid,
          key: e.key,
          plan: approveOutcome(ctx, {
            outcomeId: o.id,
            outcome: o.data,
            thread: { ...e.thread!.data },
          }),
        });
      }
    } catch (err) {
      setError(errorText(err));
      return;
    }
    const wids = [...new Set(plans.map((p) => p.wid))];
    const forgets = wids.map((w) =>
      stash(
        session.me.uid,
        w,
        plans.filter((p) => p.wid === w).map((p) => p.plan.ops),
        `Saved: ${plans.length} tidy-ups`,
      ),
    );
    const forget = () => forgets.forEach((f) => f());
    toast.push({
      message: `Approved ${plans.length}`,
      duration: 5000,
      countdown: {
        key: TIDY_KEY,
        tag: 'approve',
        announce: `${plans.length} tidy-ups approved. Undo available for 5 seconds`,
      },
      onUndo: forget,
      onCommit: () => {
        void (async () => {
          const done: string[] = [];
          try {
            for (const p of plans) {
              await run(p.plan);
              done.push(p.key);
            }
          } catch (err) {
            setError(errorText(err));
          } finally {
            forget();
            onDone(done);
          }
        })();
      },
    });
  }

  return (
    <section
      aria-label="Tidy-ups"
      data-tidy-ups=""
      className="mt-1 rounded-card border border-dashed border-line-strong/60 bg-surface-2 p-3.5 sm:p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon icon={Archive} size={18} className="shrink-0 text-text-2" />
        <p className="min-w-0 flex-1 text-14 text-text-2">
          <span className="font-semibold text-ink">
            {n} {n === 1 ? 'tidy-up' : 'tidy-ups'}
          </span>
          {n
            ? ` · ${tidySummary(batch.map((e) => ({ outcome: e.proposals![0]!.data, thread: e.thread!.data })))}`
            : ''}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            leading={<Icon icon={open ? ChevronUp : ChevronDown} size={15} />}
          >
            Review
          </Button>
          {counting ? (
            <UndoButton countdown={counting} variant="approve" />
          ) : (
            <Button
              variant="approve"
              disabled={n === 0}
              onClick={approveAll}
              leading={<Icon icon={Check} size={16} />}
            >
              Approve all {n}
            </Button>
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-14 text-sendback">
          {error}
        </p>
      ) : null}
      {open ? (
        <ul className="mt-3 flex flex-col divide-y divide-line border-t border-line">
          {entries.map((e) => {
            const o = e.proposals![0]!;
            const label = outcomeType(o.data.type)?.label ?? o.data.type;
            return (
              <li key={e.key} data-tidy={e.key} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-14 font-medium text-ink">
                    <span className="text-text-2">{label} · </span>
                    {e.thread!.data.title || 'Untitled thread'}
                  </p>
                  <p className="text-13 text-text-2">
                    {o.data.note || proposalSentence(o.data.type, o.data.fields)}
                  </p>
                </div>
                <Toggle
                  label="Keep for me"
                  checked={kept.has(e.key)}
                  disabled={!!counting}
                  onCheckedChange={(v) => onKeep(e.key, v)}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
