import { canTriage, shapesNewItems, triageFinding, type Item, type Project } from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { DecidePanel } from '../components/DecidePanel';
import { displayName, useProfiles } from '../members/data';
import { Eyebrow, Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/form';
import { AnimatePresence, motion, spring, useReducedMotion } from '../ui/motion';
import { useToast } from '../ui/overlay';
import { gateRuleLine } from '../inbox/logic';
import { approvalRows, findingsOf, type FindingRow } from './logic';

import { firstStepName } from '../inbox/decision';

const MIN_DISMISS = 10;

function Finding({
  row,
  pid,
  project,
  parentId,
  parent,
  mayTriage,
}: {
  row: FindingRow;
  pid: string;
  project: Project;
  parentId: string;
  parent: Item;
  mayTriage: boolean;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const f = row.data;

  async function go(outcome: 'intake' | 'addedToItem' | 'dismissed', message: string) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(outcome);
    setError('');
    try {
      await run(
        triageFinding(ctx, {
          project,
          projectId: pid,
          itemId: row.id,
          finding: { title: f.title, summary: f.summary, parentItemId: parentId },
          outcome,
          reason: outcome === 'dismissed' ? reason.trim() : '',
          parentSummary: parent.summary,
          unshaped: shapesNewItems(project),
        }),
      );
      toast.push({ message });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
      setBusy(null);
    }
  }

  const short = reason.trim().length < MIN_DISMISS;
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
      <p className="text-14 font-medium text-ink">{f.title}</p>
      {f.summary ? <p className="whitespace-pre-wrap text-13 text-text-2">{f.summary}</p> : null}
      <p className="text-12 text-text-3">Found while working · {f.source.label}</p>
      {!mayTriage ? null : dismissing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            label="Why dismiss it?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint={`${reason.trim().length} / ${MIN_DISMISS} characters minimum. Agents see why.`}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="sendback"
              disabled={short}
              loading={busy === 'dismissed'}
              onClick={() => go('dismissed', 'Suggestion dismissed.')}
            >
              Dismiss suggestion
            </Button>
            <Button variant="ghost" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={busy === 'intake'}
            onClick={() =>
              go(
                'intake',
                `Added to ${firstStepName(project)} as a task. Agents can pick it up now.`,
              )
            }
          >
            Add to {firstStepName(project)}
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'addedToItem'}
            onClick={() => go('addedToItem', 'Added to this item.')}
          >
            Add to this item
          </Button>
          <Button variant="ghost" onClick={() => setDismissing(true)}>
            Dismiss…
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-13 text-sendback">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Suggestions agents raised about an item, with the triage buttons (when the viewer may triage). */
export function FoundWhileWorking({
  pid,
  itemId,
  project,
  item,
  items,
}: {
  pid: string;
  itemId: string;
  project: Project;
  item: Item;
  items: Array<{ id: string; data: Item }>;
}) {
  const { session } = useReady();
  const reduce = useReducedMotion();
  const findings = findingsOf(items, itemId);
  const mayTriage = canTriage(project, session.me.uid, session.isAdmin);
  return (
    <section aria-label="Found while working" className="flex flex-col gap-2">
      <Eyebrow>Found while working{findings.length ? ` · ${findings.length}` : ''}</Eyebrow>
      {findings.length === 0 ? (
        <p className="text-14 text-text-2">Nothing found outside the scope of this item.</p>
      ) : null}
      <AnimatePresence initial={false}>
        {findings.map((r) => (
          <motion.div
            key={r.id}
            layout={!reduce}
            initial={false}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 48, height: 0 }}
            transition={spring.ui}
          >
            <Finding
              row={r}
              pid={pid}
              project={project}
              parentId={itemId}
              parent={item}
              mayTriage={mayTriage}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}

/** What sits beside (or under) the document: findings, approvals so far, and the decision. */
export function ReviewPanel({
  pid,
  itemId,
  project,
  item,
  items,
}: {
  pid: string;
  itemId: string;
  project: Project;
  item: Item;
  items: Array<{ id: string; data: Item }>;
}) {
  const { session } = useReady();
  const step = project.steps.find((s) => s.id === item.stepId);
  const rows = approvalRows(step, item);
  const profiles = useProfiles(
    session.workspaceId,
    rows.map((r) => r.uid),
  );
  const approved = rows.filter((r) => r.state === 'approved');

  return (
    <div className="flex flex-col gap-6">
      <FoundWhileWorking pid={pid} itemId={itemId} project={project} item={item} items={items} />

      {rows.length ? (
        <section aria-label="Approvals" className="flex flex-col gap-2">
          <Eyebrow>Approvals · {gateRuleLine(step?.gate)}</Eyebrow>
          <p className="text-13 text-text-2">
            {approved.length === 0
              ? 'Nobody has approved yet.'
              : `${approved.length} approved so far.`}
          </p>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.uid} className="rounded-card border border-line bg-surface p-2.5 text-14">
                <p className="flex flex-wrap items-center gap-2 text-ink">
                  <span className="font-medium">{displayName(profiles[r.uid], r.uid)}</span>
                  {r.state === 'approved' ? (
                    <Pill tone="approve">Approved</Pill>
                  ) : (
                    <Pill tone={r.required ? 'gate' : 'neutral'}>
                      {rows.length === 1
                        ? 'Waiting'
                        : r.required
                          ? 'Required'
                          : step?.gate?.rule === 'any'
                            ? 'Can approve'
                            : 'Optional'}
                    </Pill>
                  )}
                </p>
                {r.quote ? <p className="mt-1 text-text-2">&ldquo;{r.quote}&rdquo;</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Sticky at the bottom of the panel: Approve is never below the fold (landscape phones too). */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 max-sm:bottom-[var(--bar-bottom,0px)]">
        <DecidePanel project={project} projectId={pid} itemId={itemId} item={item} compact />
      </div>
    </div>
  );
}
