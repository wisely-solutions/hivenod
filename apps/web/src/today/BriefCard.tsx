/**
 * The brief at the top of Today (item kt3E7u9EliL3q2veDDI0, design 2.1): the date and time, a
 * greeting, 2-3 sentences from counts, "About N min", and a bar with one segment per decision.
 */
import { Clock, Sun } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import type { Brief, Segment } from '../needs/brief';
import { dateLine, greeting } from './logic';

const SEGMENT: Record<Segment, string> = {
  red: 'bg-sendback',
  amber: 'bg-gate',
  grey: 'bg-line-strong/50',
  green: 'bg-approve',
};

export function BriefCard({
  brief,
  name,
  now,
  loading,
}: {
  brief: Brief | null;
  name: string;
  now: number;
  loading: boolean;
}) {
  // Phone: three lines with "more" (design 2.7).
  const [more, setMore] = useState(false);
  const done = brief ? brief.segments.filter((s) => s === 'green').length : 0;
  return (
    <section
      aria-labelledby="today-greeting"
      data-brief=""
      className="rounded-panel border border-line bg-surface p-4 shadow-e1 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-btn bg-agent-soft text-agent"
        >
          <Icon icon={Sun} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
            {dateLine(now)}
          </p>
          <h1 id="today-greeting" className="text-20 font-semibold text-ink sm:text-[22px]">
            {greeting(now)}, {name}
          </h1>
        </div>
        {brief && !brief.empty && brief.minutes > 0 ? (
          <span className="mt-1 hidden shrink-0 items-center gap-1.5 text-13 text-text-2 sm:inline-flex">
            <Icon icon={Clock} size={14} />
            about {brief.minutes} min
          </span>
        ) : null}
      </div>
      <div className="mt-3 min-h-[3lh] text-15 leading-relaxed text-ink">
        {loading || !brief ? (
          <span className="sr-only">Loading the brief</span>
        ) : (
          <p data-brief-text="" className={cn(!more && 'max-sm:line-clamp-3')}>
            {brief.sentences.join(' ')}
          </p>
        )}
        {brief && !loading && brief.sentences.join(' ').length > 120 ? (
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            aria-expanded={more}
            className="mt-1 text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus sm:hidden"
          >
            {more ? 'less' : 'more'}
          </button>
        ) : null}
      </div>
      {brief && brief.segments.length > 0 ? (
        <div
          role="img"
          aria-label={`${done} of ${brief.segments.length} decisions made`}
          className="mt-4 flex gap-1"
        >
          {brief.segments.map((s, i) => (
            <span
              key={i}
              data-segment={s}
              className={cn('h-1.5 min-w-2 flex-1 rounded-full transition-colors', SEGMENT[s])}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
