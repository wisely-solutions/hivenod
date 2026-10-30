/**
 * Scheduled tasks, slice 6: the pieces the Schedules page and Today share: the scheduler-offline
 * banner, a "can't run" card with Run now · Try later · Skip (decideRun), the Coming up panel, the
 * state pill of a run and the plan pills of a schedule.
 */
import { Link } from '@tanstack/react-router';
import {
  decideRun,
  laterChoices,
  parseLaterTime,
  type RunChoice,
} from '@hive/shared';
import { AlertTriangle, CalendarClock, ChevronRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useReady } from '../auth/context';
import { errorText } from '../threads/parts';
import type { ScheduleStepView } from '../threads/schedule';
import { agentColorIndex } from '../ui/avatar';
import { Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import { Popover, useToast } from '../ui/overlay';
import {
  cardTone,
  laterWords,
  runWords,
  type CantRunCard,
  type ChipState,
  type ComingRun,
} from './logic';

export const EYEBROW = 'font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3';

/** The agent's colour (one of eight), as a CSS value. */
export const agentColor = (agentUid: string | null) =>
  agentUid ? `var(--agent-${agentColorIndex(agentUid)})` : 'var(--line-strong)';

/** A small square with the agent's initial, then its name. */
export function AgentTag({ uid, name }: { uid: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-14 text-ink">
      <span
        aria-hidden
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-12 font-semibold text-on-solid"
        style={{ backgroundColor: agentColor(uid) }}
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

/** "✓ done", "! can't run", "– skipped": a run's state as a pill. */
export function RunPill({
  state,
  label,
  className,
}: {
  state: ChipState;
  /** Instead of the state word (e.g. the day: "✓ 1 Oct"). */
  label?: string;
  className?: string;
}) {
  const w = runWords(state);
  return (
    <Pill tone={w.tone} className={cn('h-5 px-2 text-12', className)}>
      <span data-run-state={state}>
        {w.sym ? `${w.sym} ` : ''}
        {label ?? w.word}
      </span>
    </Pill>
  );
}

/** The plan of each run: "Prepare → You approve → Send" (agent blue, you amber). */
export function StepPills({ steps, agent }: { steps: ScheduleStepView[]; agent?: string }) {
  return (
    <ol className="flex flex-wrap items-center gap-1" data-plan-pills="">
      {steps.map((s, i) => (
        <li key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 ? (
            <span aria-hidden className="text-12 text-text-3">
              →
            </span>
          ) : null}
          <Pill
            tone={s.who === 'you' ? 'gate' : 'agent'}
            className="h-5 max-w-[14rem] px-2 text-12"
          >
            <span className="truncate" title={s.title}>
              {s.who === 'you' ? 'You: ' : agent ? `${agent}: ` : ''}
              {s.title.replace(/^You approve: /, 'approve ')}
            </span>
          </Pill>
        </li>
      ))}
    </ol>
  );
}

/** The red banner while the scheduler's beat is too old (design 5.4). */
export function SchedulerBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      role="alert"
      data-scheduler-banner=""
      className="mb-4 flex items-start gap-2.5 rounded-card border border-sendback-border bg-sendback-bg px-4 py-3 text-14 text-sendback"
    >
      <Icon icon={AlertTriangle} size={18} className="mt-0.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <strong className="font-semibold">{text}</strong>
        <span className="block text-13">
          Hivenod’s scheduler is not running. You get a question for each missed run when it is
          back.
        </span>
      </span>
    </div>
  );
}

const CARD = {
  red: 'border-sendback-border bg-sendback-bg',
  amber: 'border-gate bg-gate-bg',
  plain: 'border-line-strong bg-surface',
} as const;
const KICKER = {
  red: 'text-sendback',
  amber: 'text-gate-text',
  plain: 'text-text-2',
} as const;

/**
 * A run that could not happen (design 8): what, when, why, what skipping means, and Run now · Try
 * later (in 1 hour, tomorrow 09:00, a typed time) · Skip this one. One write each (decideRun).
 */
export function CantRunCardView({
  card,
  uid,
  now,
  tz,
  compact,
}: {
  card: CantRunCard;
  uid: string;
  now: number;
  tz: string;
  /** Phone or a narrow column: short labels. */
  compact?: boolean;
}) {
  const { actionContext, run } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState<RunChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const tone = cardTone(card.level);
  const r = card.run;

  async function decide(choice: RunChoice, laterMs?: number) {
    const ctx = actionContext(card.wid);
    if (!ctx || busy) return;
    setError(null);
    setBusy(choice);
    try {
      const plan = decideRun(ctx, {
        runId: r.id,
        run: { memberUid: uid, scheduleId: r.scheduleId, state: r.state, threadId: r.threadId },
        choice,
        ...(laterMs ? { laterAt: new Date(laterMs) } : {}),
        nowMs: Date.now(),
      });
      await run(plan);
      setLaterOpen(false);
      toast.push({
        message:
          choice === 'runNow'
            ? `Running now: ${card.scheduleTitle}`
            : choice === 'later'
              ? `Tries again ${laterWords(laterMs!, Date.now(), tz).replace(/^Today/, 'today').replace(/^Tomorrow/, 'tomorrow')}`
              : `Skipped: ${r.title}`,
        duration: 4000,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  const choices = laterChoices(now, tz);
  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const p = parseLaterTime(typed, Date.now(), tz);
    if (!p.ok) {
      setTypedError(p.error);
      return;
    }
    setTypedError(null);
    void decide('later', p.atMs);
  };

  return (
    <section
      aria-label={`Run didn’t happen: ${r.title}`}
      data-cant-run={r.id}
      data-level={card.level}
      className={cn('rounded-panel border-2 p-4 shadow-e1', CARD[tone])}
    >
      <p
        className={cn(
          'font-mono text-12 font-semibold uppercase tracking-[0.08em] [overflow-wrap:anywhere]',
          KICKER[tone],
        )}
      >
        {card.kicker}
      </p>
      <div className="mt-1.5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-16 font-semibold text-ink [overflow-wrap:anywhere]">
            {r.threadId ? (
              <Link
                to="/inbox/$wid/t/$tid"
                params={{ wid: card.wid, tid: r.threadId }}
                className="hov:underline foc:outline-2 foc:outline-focus"
              >
                {card.headline}
              </Link>
            ) : (
              card.headline
            )}
          </p>
          <p className="mt-0.5 text-14 text-text-2 [overflow-wrap:anywhere]">
            Why: {card.why} {compact ? null : card.skip}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="approve"
            data-run-now=""
            loading={busy === 'runNow'}
            disabled={!!busy && busy !== 'runNow'}
            onClick={() => void decide('runNow')}
          >
            Run now
          </Button>
          <Popover
            label="Try later"
            open={laterOpen}
            onOpenChange={setLaterOpen}
            align="end"
            trigger={
              <Button
                variant="secondary"
                data-try-later=""
                aria-expanded={laterOpen}
                loading={busy === 'later'}
                disabled={!!busy && busy !== 'later'}
              >
                Try later
              </Button>
            }
          >
            <div className="flex flex-col gap-2">
              <p className="text-14 font-semibold text-ink">Try again…</p>
              <Button
                variant="secondary"
                data-later-hour=""
                onClick={() => void decide('later', choices.inHourMs)}
              >
                In 1 hour · {laterWords(choices.inHourMs, now, tz)}
              </Button>
              <Button
                variant="secondary"
                data-later-tomorrow=""
                onClick={() => void decide('later', choices.tomorrowMs)}
              >
                {laterWords(choices.tomorrowMs, now, tz)}
              </Button>
              <form onSubmit={submitTyped} className="mt-1 flex flex-col gap-1.5">
                <Input
                  label="Pick a time"
                  placeholder="14:30, tomorrow 10:00, 3 Nov 9:00"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  error={typedError ?? undefined}
                />
                <Button type="submit" variant="primary" data-later-typed="">
                  Try then
                </Button>
              </form>
            </div>
          </Popover>
          <Button
            variant="secondary"
            data-skip-run=""
            loading={busy === 'skip'}
            disabled={!!busy && busy !== 'skip'}
            onClick={() => void decide('skip')}
          >
            {compact ? 'Skip' : 'Skip this one'}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-14 text-sendback">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Today's "Coming up": the runs still to come today and tomorrow (design 9.3). */
export function ComingUpPanel({
  runs,
  agentName,
}: {
  runs: ComingRun[];
  agentName: (wid: string, uid: string) => string;
}) {
  if (!runs.length) return null;
  return (
    <section
      aria-label="Coming up"
      data-coming-up=""
      className="rounded-panel border border-line bg-surface p-4 shadow-e1"
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-16 font-semibold text-ink">
          <Icon icon={CalendarClock} size={16} className="text-text-2" />
          Coming up
        </h2>
        <Link
          to="/schedules"
          className="inline-flex items-center text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus"
        >
          All schedules
          <Icon icon={ChevronRight} size={14} />
        </Link>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {runs.map((r) => (
          <li key={r.key} className="flex items-baseline gap-2.5 py-2" data-coming-run="">
            <span className="w-[4.5rem] shrink-0 text-13 tabular-nums text-text-2">
              {r.today ? r.time : `Tmrw ${r.time}`}
            </span>
            <span
              aria-hidden
              className="mt-1 size-2 shrink-0 self-start rounded-full"
              style={{ backgroundColor: agentColor(r.agentUid) }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-14 text-ink">{r.title}</span>
              <span className="block truncate text-12 text-text-2">
                {agentName(r.wid, r.agentUid)} · {r.words}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
