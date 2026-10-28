import type { Item, Project, Run } from '@hive/shared';
import { useNavigate } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useReady } from '../auth/context';
import { formatDuration } from '../activity/logic';
import { buildInbox } from '../inbox/logic';
import { useShellData } from '../shell/data';
import { formatEur } from '../shell/logic';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import type { Row } from '../lib/live';

const HEX_OFFSETS = [
  [0, -34],
  [30, -17],
  [30, 17],
  [0, 34],
  [-30, 17],
  [-30, -17],
] as const;

/** Six small hexagons that fly out once. Hidden under prefers-reduced-motion (CSS). */
export function HexBurst() {
  return (
    <span aria-hidden data-testid="hex-burst" className="hex-burst">
      {HEX_OFFSETS.map(([dx, dy]) => (
        <span
          key={`${dx}:${dy}`}
          style={{ ['--dx' as string]: `${dx}px`, ['--dy' as string]: `${dy}px` }}
        />
      ))}
    </span>
  );
}

/** Next waiting item: same project first, then the oldest overall (`todo` is oldest first). */
export function pickNext<T extends { pid: string; itemId: string }>(
  todo: readonly T[],
  pid: string,
  itemId: string,
): T | undefined {
  const waiting = todo.filter((e) => e.itemId !== itemId);
  return waiting.find((e) => e.pid === pid) ?? waiting[0];
}

/** How long the work took: first run start to the last update, when the item had runs. */
export function tookMs(item: Item, runs: Row<Run>[]): number | null {
  if (runs.length === 0) return null;
  const start = Math.min(...runs.map((r) => r.data.startedAt.toMillis()));
  const ms = item.updatedAt.toMillis() - start;
  return ms > 0 ? ms : null;
}

/**
 * The finished state of an item (replaces the decide panel): a check, "Done", how long it took,
 * how many runs, what it cost, and a jump to the next item waiting for this person.
 */
export function DonePanel({
  pid,
  item,
  itemId,
  runs,
  burst,
}: {
  pid: string;
  project?: Project;
  item: Item;
  itemId: string;
  runs: Row<Run>[];
  burst: boolean;
}) {
  const { session } = useReady();
  const navigate = useNavigate();
  const { projects, items, suggestions, questions, settled } = useShellData();
  const todo = buildInbox({
    projects,
    items,
    suggestions,
    questions,
    uid: session.me.uid,
    isAdmin: session.isAdmin,
  }).todo;
  const next = pickNext(todo, pid, itemId);
  const took = tookMs(item, runs);
  const facts = [
    took !== null ? `Took ${formatDuration(took)}` : null,
    `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`,
    formatEur(item.costEur),
  ].filter(Boolean);
  return (
    <section
      aria-label="Done"
      data-testid="done-panel"
      className="relative flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3.5"
    >
      <span className="relative inline-flex size-9 items-center justify-center rounded-full bg-gate-bg text-gate-text">
        <Icon icon={Check} size={20} />
        {burst ? <HexBurst /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-16 font-semibold text-ink">Done</p>
        <p className="text-13 text-text-2">{facts.join(' · ')}</p>
      </div>
      {!next && !settled ? (
        // The inbox is still loading: keep the button's room so the text does not re-wrap when it lands.
        <span aria-hidden className="invisible h-11 w-[10.5rem]" />
      ) : null}
      {next ? (
        <Button
          variant="secondary"
          onClick={() =>
            void navigate({
              to: '/p/$pid',
              params: { pid: next.pid },
              search: { item: next.itemId },
            })
          }
        >
          Open next waiting
        </Button>
      ) : null}
    </section>
  );
}
