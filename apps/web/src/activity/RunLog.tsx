import { logLineSchema } from '@hive/shared';
import { useEffect, useMemo, useRef } from 'react';
import { useLiveCollection } from '../lib/live';
import { cn } from '../ui/cn';
import { clock } from './logic';

/** The log lines of one run in order. While the run is alive the view follows the tail. */
export function RunLog({ wid, runId, live }: { wid: string; runId: string; live: boolean }) {
  const lines = useLiveCollection(`workspaces/${wid}/runs/${runId}/log`, logLineSchema);
  // Line ids are the numbers 0..499, as text: sort them as numbers.
  const sorted = useMemo(
    () =>
      lines.state === 'ready' ? [...lines.data].sort((a, b) => Number(a.id) - Number(b.id)) : [],
    [lines],
  );
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [live, sorted.length]);

  if (lines.state === 'loading') return <p className="text-13 text-text-2">Loading the log…</p>;
  if (lines.state === 'error')
    return <p className="text-13 text-sendback">The log could not be loaded.</p>;
  if (!sorted.length)
    return (
      <p className="text-13 text-text-2">
        {live ? 'No log lines yet. They appear here as the agent writes them.' : 'No log lines.'}
      </p>
    );
  return (
    <div
      role="log"
      aria-label="Run log"
      // A scrollable region must be reachable by keyboard so the log can be read without a mouse.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="max-h-56 overflow-auto rounded-btn border border-line bg-canvas p-2.5 font-mono text-12 leading-5 foc:outline-2 foc:outline-focus"
    >
      {sorted.map((l) => (
        <p
          key={l.id}
          className={cn(
            // The extra-arguments line holds copyable flags: keep each one whole (no wrap at the
            // hyphens); the log region scrolls sideways instead.
            l.data.text.startsWith('Extra Claude arguments:')
              ? 'whitespace-pre'
              : 'whitespace-pre-wrap break-words',
            l.data.level === 'error' && 'text-sendback',
            l.data.level === 'warn' && 'text-gate-text',
          )}
        >
          <span className="text-text-2">{clock(l.data.at.toMillis())}</span>{' '}
          {l.data.level === 'info' ? '' : `[${l.data.level}] `}
          {l.data.text}
        </p>
      ))}
      <div ref={end} />
    </div>
  );
}
