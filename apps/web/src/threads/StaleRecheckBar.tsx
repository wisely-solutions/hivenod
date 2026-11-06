/**
 * "N summaries may be out of date · Re-check N" (item "Re-check N out of date in one tap"): on
 * Today and at the top of the Inbox, only while N > 0. One tap, a 5 s Undo, then one Re-check per
 * thread (requestRecheck: one write, one agent turn each). Threads already waiting on a re-check
 * are not counted or asked twice. No polling: N follows the pages' own thread listeners, and the
 * bar goes away by itself once the requests are written.
 */
import { RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useNow } from '../activity/data';
import { useReady } from '../auth/context';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { UndoButton } from '../ui/UndoButton';
import { outOfDateThreads, rowKey } from './bulkRecheck';
import type { ThreadRow } from './logic';
import { useBulkRecheck } from './useBulkRecheck';

const KEY = 'rk:stale';

export function StaleRecheckBar({
  threads,
  className,
}: {
  threads: readonly ThreadRow[];
  className?: string;
}) {
  const { session } = useReady();
  // A local clock only (no reads): a request nobody answered for 30 minutes may be asked again.
  const now = useNow(30_000);
  // Asked a moment ago: not offered again until the listener shows the request (no double tap).
  const [asked, setAsked] = useState<ReadonlyMap<string, number>>(() => new Map());
  const sending = useRef<string[]>([]);
  const targets = useMemo(
    () =>
      outOfDateThreads(threads, session.me.uid, now).filter(
        (t) => now - (asked.get(rowKey(t)) ?? -Infinity) > 60_000,
      ),
    [threads, session.me.uid, now, asked],
  );
  const { counting, error, start } = useBulkRecheck(KEY, () =>
    setAsked((cur) => new Map([...cur, ...sending.current.map((k) => [k, Date.now()] as const)])),
  );
  const n = targets.length;
  if (n === 0 && !counting) return null;
  return (
    <div className={className}>
      <div
        data-stale-bar=""
        role="group"
        aria-label="Summaries that may be out of date"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-agent/30 bg-agent/5 px-3.5 py-2"
      >
        <p className="mr-auto flex items-center gap-2 text-14 font-semibold text-ink">
          <Icon icon={RefreshCw} size={15} className="shrink-0 text-agent" />
          <span data-stale-count={n}>
            {n} {n === 1 ? 'summary' : 'summaries'} may be out of date
          </span>
        </p>
        {counting ? (
          <UndoButton countdown={counting} variant="primary" />
        ) : (
          <Button
            variant="primary"
            data-recheck-stale=""
            className="shrink-0"
            onClick={() => {
              sending.current = targets.map(rowKey);
              start(targets, 'stale', now);
            }}
          >
            Re-check {n}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-14 text-sendback">
          {error}
        </p>
      ) : null}
    </div>
  );
}
