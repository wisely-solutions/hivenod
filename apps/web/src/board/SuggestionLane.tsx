import type { Agent, Project } from '@hive/shared';
import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { DecisionDialog } from '../inbox/DecisionDialog';
import { firstStepName, prepareDecision, type Decision } from '../inbox/decision';
import type { InboxEntry } from '../inbox/logic';
import type { Row } from '../lib/live';
import { Button } from '../ui/button';
import { useToast } from '../ui/overlay';
import { suggestionLine, type ItemRow } from './logic';

/**
 * Agent suggestions (untriaged findings) in a dashed lane at the top of the first column (card
 * TU5pDmzE, Draft A). Hidden when there are none. People who may triage (canTriage) add one to
 * the first step or dismiss it with a reason; everyone else sees them read-only.
 */
export function SuggestionLane({
  pid,
  project,
  rows,
  items,
  agents,
  canTriage,
  onOpen,
}: {
  pid: string;
  project: Project;
  rows: readonly ItemRow[];
  items: readonly ItemRow[];
  agents: readonly Row<Agent>[];
  canTriage: boolean;
  onOpen: (id: string) => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [dismissing, setDismissing] = useState<InboxEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const step = firstStepName(project);
  const sorted = [...rows].sort((a, b) => a.data.order - b.data.order);

  const entryOf = (r: ItemRow): InboxEntry => ({
    key: `f:${pid}:${r.id}`,
    kind: 'finding',
    pid,
    itemId: r.id,
    project,
    item: r.data,
    since: r.data.updatedAt.toMillis(),
  });

  /** Commits at once (no undo on the board); returns a problem to show, or null. */
  function decide(entry: InboxEntry, d: Decision): string | null {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return 'You are offline or signed out.';
    let prepared;
    try {
      prepared = prepareDecision(ctx, entry, d);
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not save. Try again.';
    }
    setBusy(entry.itemId);
    run(prepared.plan)
      .then(() => toast.push({ message: prepared.message }))
      .catch(() => toast.push({ message: 'Could not save. Try again.' }))
      .finally(() => setBusy(null));
    return null;
  }

  const count = rows.length;
  return (
    <section
      aria-label={`${count} ${count === 1 ? 'suggestion' : 'suggestions'} from agents`}
      data-testid="suggestions"
      className="flex flex-col gap-2 rounded-card border border-dashed border-agent bg-agent-soft p-2"
    >
      <h3 className="flex items-center gap-1.5 px-1 pt-0.5 text-13 font-semibold text-agent">
        <Lightbulb size={14} aria-hidden />
        {count} {count === 1 ? 'suggestion' : 'suggestions'} from agents
      </h3>
      <ul className="flex flex-col gap-2">
        {sorted.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3 shadow-e1"
          >
            <button
              type="button"
              onClick={() => onOpen(r.id)}
              className="text-left text-14 font-semibold leading-snug text-ink hov:underline foc:outline-2 foc:outline-focus"
            >
              {r.data.title}
            </button>
            <p className="line-clamp-3 text-13 text-text-2">{suggestionLine(r, items, agents)}</p>
            {canTriage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="approve"
                  loading={busy === r.id}
                  onClick={() => decide(entryOf(r), { kind: 'intake' })}
                >
                  Add to {step}
                </Button>
                <Button variant="sendback" onClick={() => setDismissing(entryOf(r))}>
                  Dismiss…
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canTriage ? null : (
        <p className="px-1 text-12 text-text-2">
          Admins, the project creator and the deciders of {step} add or dismiss suggestions.
        </p>
      )}
      <DecisionDialog
        mode={dismissing ? 'dismiss' : null}
        entry={dismissing}
        onSubmit={decide}
        onClose={() => setDismissing(null)}
      />
    </section>
  );
}
