/**
 * The right rail of Today (item kt3E7u9EliL3q2veDDI0, design 2.1), beside the stack from 1280 px
 * and under it below: the threads waiting on others, and what the agents are working on (the
 * agenda went with Calendar, item OE8FmrTaIxFVGcaeGG3N slice 5).
 */
import { Link } from '@tanstack/react-router';
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from '../ui/icon';
import { WorkingDots } from '../ui/feedback';
import { waitLabel } from '../inbox/logic';

function Panel({
  title,
  aside,
  children,
  label,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className="rounded-panel border border-line bg-surface p-4 shadow-e1"
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-16 font-semibold text-ink">{title}</h2>
        {aside ? <span className="text-13 text-text-2">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function TodayRail({
  waiting,
  working,
  now,
}: {
  waiting: Array<{ key: string; wid: string; tid: string; title: string; on: string; at: number }>;
  working: Array<{ key: string; wid: string; tid: string; title: string; note: string }>;
  now: number;
}) {
  if (!waiting.length && !working.length) return null;
  return (
    <div className="flex flex-col gap-4" data-today-rail="">
      {waiting.length ? (
        <Panel title="Waiting on others" label="Waiting on others" aside={String(waiting.length)}>
          <ul className="flex flex-col divide-y divide-line">
            {waiting.map((w) => (
              <li key={w.key}>
                <Link
                  to="/inbox/$wid/t/$tid"
                  params={{ wid: w.wid, tid: w.tid }}
                  className="flex items-baseline gap-2 py-2 text-14 hov:underline foc:outline-2 foc:outline-focus"
                >
                  <span className="min-w-0 flex-1 truncate text-ink">{w.title}</span>
                  <span className="shrink-0 text-12 text-text-2">
                    {w.on} · {waitLabel(w.at, now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {working.length ? (
        <Panel
          title="Agents working"
          label="Agents working"
          aside={
            <span className="inline-flex items-center gap-1.5">
              <WorkingDots /> {working.length}
            </span>
          }
        >
          <ul className="flex flex-col gap-2.5">
            {working.map((w) => (
              <li key={w.key}>
                <Link
                  to="/inbox/$wid/t/$tid"
                  params={{ wid: w.wid, tid: w.tid }}
                  className="block rounded-btn foc:outline-2 foc:outline-focus"
                >
                  <span className="flex items-center gap-1.5 text-14 font-medium text-ink hov:underline">
                    <Icon icon={Bot} size={14} className="text-agent" />
                    <span className="truncate">{w.title}</span>
                  </span>
                  {w.note ? (
                    <span className="mt-0.5 block truncate text-13 text-text-2">{w.note}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
