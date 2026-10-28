import {
  formatTokens,
  logLineSchema,
  newTokens,
  type Agent,
  type Item,
  type Run,
} from '@hive/shared';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { ChevronDown, ChevronRight, Square } from 'lucide-react';
import { useState } from 'react';
import { colorIndex } from '../agents/logic';
import { RunLog } from '../activity/RunLog';
import { useNow } from '../activity/data';
import { clock, formatDuration } from '../activity/logic';
import { db } from '../lib/db';
import { useLiveQuery, type Row } from '../lib/live';
import { formatEur } from '../shell/logic';
import { AgentAvatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { WorkingDots } from '../ui/feedback';
import { Icon } from '../ui/icon';
import { isNewAttachment } from './logic';

/** The last few log lines of a run, live: the cheapest way to see what the agent is doing now. */
function useTail(wid: string, runId: string | undefined, n: number) {
  const live = useLiveQuery(
    runId ? `log-tail:${wid}:${runId}:${n}` : null,
    () =>
      query(collection(db, `workspaces/${wid}/runs/${runId}/log`), orderBy('at', 'desc'), limit(n)),
    logLineSchema,
  );
  // Newest first from the query; show oldest first, newest at the bottom, like a terminal.
  return live.state === 'ready' ? [...live.data].reverse() : null;
}

/**
 * Card EmDyZyfC: a working item shows its run right where you are looking at it. Who and how
 * long, cost and tokens, the machine, progress with the current line, the last log lines
 * streaming, the full log, and Stop. Everything comes from data the run already writes.
 */
export function LiveRun({
  wid,
  item,
  agent,
  run,
  files,
  onStop,
  onOpenFile,
}: {
  wid: string;
  item: Item;
  agent: Row<Agent> | undefined;
  run: Row<Run> | undefined;
  /** Attachments this run produced so far. */
  files: Array<{ id: string; name: string; at: number }>;
  /** Present when the viewer may stop work. */
  onStop: (() => void) | null;
  onOpenFile: (attachmentId: string) => void;
}) {
  const now = useNow(1000);
  const [full, setFull] = useState(false);
  const tail = useTail(wid, run?.id, 3);
  const name = agent?.data.name ?? 'An agent';
  const started = run?.data.startedAt.toMillis();
  const p = item.progress && item.progress.total > 0 ? item.progress : null;
  const current = tail && tail.length ? (tail[tail.length - 1]?.data.text ?? null) : null;
  const facts: string[] = [];
  if (started) facts.push(formatDuration(now - started));
  if (run) {
    facts.push(formatEur(run.data.costEur));
    if (run.data.tokensIn || run.data.tokensOut)
      facts.push(`${formatTokens(newTokens(run.data))} tokens`);
  }
  if (agent?.data.seenHost) facts.push(`on ${agent.data.seenHost}`);

  return (
    <section
      aria-label="Live run"
      data-testid="live-run"
      className="flex flex-col gap-3 rounded-card border border-agent bg-agent-soft p-3.5"
    >
      <div className="flex items-start gap-3">
        <AgentAvatar
          name={name}
          color={agent ? colorIndex(agent.data.color, agent.id) : 0}
          live
          size="md"
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-14 font-semibold text-ink">
            {name} is working now <WorkingDots />
            <span className="sr-only">live</span>
          </p>
          <p className="mt-0.5 break-words text-13 text-text-2">{facts.join(' · ')}</p>
        </div>
        {onStop ? (
          <Button
            variant="sendback"
            aria-label="Stop work"
            leading={<Icon icon={Square} size={14} />}
            onClick={onStop}
          >
            Stop
          </Button>
        ) : null}
      </div>

      {p ? (
        <div>
          <div
            role="progressbar"
            aria-label="Run progress"
            aria-valuemin={0}
            aria-valuemax={p.total}
            aria-valuenow={p.done}
            aria-valuetext={`${p.done} of ${p.total}`}
            className="h-2 overflow-hidden rounded-full bg-line"
          >
            <div
              className="h-full rounded-full bg-agent transition-[width] duration-300"
              style={{ width: `${Math.min(100, (p.done / p.total) * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 break-words text-13 text-ink">
            <span className="font-semibold tabular-nums">
              {p.done} of {p.total}
            </span>
            {current ? <> · {current}</> : null}
          </p>
        </div>
      ) : current ? (
        <p className="break-words text-13 text-ink">{current}</p>
      ) : null}

      <div
        role="log"
        aria-label="Latest log lines"
        aria-live="off"
        className="rounded-btn border border-line bg-canvas p-2.5 font-mono text-12 leading-5 text-ink"
      >
        {tail === null ? (
          <p className="text-text-2">Loading the log…</p>
        ) : tail.length === 0 ? (
          <p className="text-text-2">
            No log lines yet. They appear here as the agent writes them.
          </p>
        ) : (
          tail.map((l) => (
            <p key={l.id} className="whitespace-pre-wrap break-words">
              <span className="text-text-2">{clock(l.data.at.toMillis())}</span> {l.data.text}
            </p>
          ))
        )}
      </div>

      {files.length ? (
        <ul aria-label="Files made by this run" className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onOpenFile(f.id)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-13 text-ink foc:outline-2 foc:outline-offset-2 foc:outline-focus"
              >
                {f.name}
                {isNewAttachment(f.at, now) ? (
                  <span className="rounded-full border border-agent bg-agent-soft px-1.5 text-12 font-semibold text-ink">
                    new
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4">
        {run ? (
          <button
            type="button"
            aria-expanded={full}
            onClick={() => setFull((v) => !v)}
            className="inline-flex min-h-11 items-center gap-1 text-13 font-medium text-ink underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
          >
            <Icon icon={full ? ChevronDown : ChevronRight} size={14} />
            {full ? 'Hide full log' : 'Full log'}
          </button>
        ) : null}
      </div>
      {full && run ? <RunLog wid={wid} runId={run.id} live /> : null}
    </section>
  );
}
