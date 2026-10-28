/**
 * Needs-you entries for per-item paths (card st5INNZj): a pending people-step change ("Skip
 * Release for …?") for that step's deciders, and a proposed library step for approvers. Their
 * buttons go in the inbox's one action bar (sticky on a phone), the seam for card 9bmMIGlC.
 */
import {
  acceptProposal,
  askPathChange,
  defaultGate,
  isUnshaped,
  newStepId,
  rejectProposal,
  skipStep,
  type Agent,
  type Item,
  type Step,
  ownGet,
} from '@hive/shared';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { PathDecisionButtons, usePathDecision } from '../board/PathPanel';
import { pathView } from '../board/path';
import { ResponsiveModal } from '../components/ResponsiveModal';
import type { Row } from '../lib/live';
import { displayName, useProfiles } from '../members/data';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { Input, Textarea } from '../ui/form';
import { useToast } from '../ui/overlay';
import { PathCompact } from '../ui/path';
import type { InboxEntry } from './logic';

const MIN_REASON = 10;
const OPEN = ['queued', 'working', 'waiting'];

function asker(entry: InboxEntry, agents: Row<Agent>[], names: Record<string, string>): string {
  const by = entry.stepId
    ? ownGet(entry.item.pathRequests, entry.stepId)?.by
    : entry.proposal?.data.by;
  if (!by) return 'Someone';
  return by.type === 'agent'
    ? (agents.find((a) => a.id === by.id)?.data.name ?? 'Removed agent')
    : (names[by.id] ?? 'Someone');
}

/** What the person decides on, above the action bar. */
export function PathEntryBody({
  entry,
  agents,
  names,
  uid,
}: {
  entry: InboxEntry;
  agents: Row<Agent>[];
  names: Record<string, string>;
  uid: string;
}) {
  const { project, item } = entry;
  const who = asker(entry, agents, names);
  if (entry.kind === 'path' && entry.stepId) {
    const step = project.steps.find((s) => s.id === entry.stepId);
    const req = ownGet(item.pathRequests, entry.stepId);
    const view = pathView({ project, item, uid, names });
    return (
      <section className="flex flex-col gap-3" data-testid="path-request">
        <div className="rounded-card border border-dashed border-gate bg-gate-bg p-3 text-14">
          <p className="text-ink">
            <span className="font-semibold">
              {who}{' '}
              {req?.op === 'add' ? `suggests adding ${step?.name}` : `asks to skip ${step?.name}`}.
            </span>{' '}
            It is a people step, so one of its deciders settles it. The item keeps going meanwhile;
            if it reaches {step?.name} first, it waits there as usual.
          </p>
          {req?.reason ? <p className="mt-1.5 text-ink">“{req.reason}”</p> : null}
        </div>
        <PathCompact view={view} labels />
      </section>
    );
  }
  if (entry.kind === 'proposal' && entry.proposal) {
    const p = entry.proposal.data;
    const after = project.steps.find((s) => s.id === p.afterStepId)?.name;
    return (
      <section className="flex flex-col gap-3" data-testid="step-proposal">
        <div className="rounded-card border border-dashed border-gate bg-gate-bg p-3 text-14">
          <p className="text-ink">
            <span className="font-semibold">
              {who} proposes a new {p.kind === 'human' ? 'people' : 'agent'} step, {p.name},
            </span>{' '}
            {after ? `after ${after}` : 'at the start'}, while working on “{item.title}”.
          </p>
          <p className="mt-1.5 text-ink">“{p.reason}”</p>
        </div>
        <dl className="grid gap-2 text-14">
          <div>
            <dt className="text-12 text-text-2">What it is for</dt>
            <dd className="text-ink">{p.description || '—'}</dd>
          </div>
          {p.instructions ? (
            <div>
              <dt className="text-12 text-text-2">Instructions</dt>
              <dd className="whitespace-pre-wrap text-ink">{p.instructions}</dd>
            </div>
          ) : null}
          {p.outputs.length ? (
            <div>
              <dt className="text-12 text-text-2">Expected outputs</dt>
              <dd className="text-ink">{p.outputs.join('; ')}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-13 text-text-2">
          Added steps join the process for new items and for “{item.title}”. Other open items keep
          the path they have.
        </p>
      </section>
    );
  }
  return null;
}

/** The buttons, in the inbox's action bar. */
export function PathEntryActions({ entry }: { entry: InboxEntry }) {
  if (entry.kind === 'path' && entry.stepId) return <PathActions entry={entry} />;
  if (entry.kind === 'proposal' && entry.proposal) return <ProposalActions entry={entry} />;
  return null;
}

function PathActions({ entry }: { entry: InboxEntry }) {
  const stepId = entry.stepId!;
  const { decide, busy } = usePathDecision(entry.pid, entry.itemId, entry.project, entry.item);
  const name = entry.project.steps.find((s) => s.id === stepId)?.name ?? 'the step';
  const op = ownGet(entry.item.pathRequests, stepId)?.op ?? 'drop';
  return (
    <PathDecisionButtons name={name} op={op} busy={busy} onDecide={(a) => void decide(stepId, a)} />
  );
}

/** Items that keep their path: open, shaped, not yet at the new step's position. */
export function itemsToKeepOff(
  rows: readonly Row<Item>[],
  steps: readonly Step[],
  newId: string,
  proposingItemId: string,
): Row<Item>[] {
  const at = steps.findIndex((s) => s.id === newId);
  return rows.filter((r) => {
    if (r.id === proposingItemId || !OPEN.includes(r.data.status) || isUnshaped(r.data))
      return false;
    if (r.data.type === 'finding') return false;
    const i = steps.findIndex((s) => s.id === r.data.stepId);
    return i >= 0 && i < at;
  });
}

function ProposalActions({ entry }: { entry: InboxEntry }) {
  const { session, actionContext, run } = useReady();
  const shell = useShellData();
  const toast = useToast();
  const p = entry.proposal!;
  const project = entry.project;
  const uid = session.me.uid;
  const [mode, setMode] = useState<'accept' | 'reject' | null>(null);
  const [name, setName] = useState(p.data.name);
  const [deciders, setDeciders] = useState<string[]>(() => [
    ...new Set([uid, ...p.data.deciderUids]),
  ]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const members = useMemo(
    () => [...new Set([uid, ...project.memberUids, ...p.data.deciderUids])],
    [uid, project.memberUids, p.data.deciderUids],
  );
  const profiles = useProfiles(session.workspaceId, members);

  async function accept() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const human = p.data.kind === 'human';
      const step: Step = {
        id: newStepId(),
        name: name.trim() || p.data.name,
        kind: p.data.kind,
        description: p.data.description,
        ...(p.data.instructions ? { instructions: p.data.instructions } : {}),
        ...(p.data.outputs.length ? { outputs: p.data.outputs } : {}),
        ...(human ? { gate: defaultGate(deciders) } : {}),
      };
      await run(
        acceptProposal(ctx, {
          project,
          projectId: entry.pid,
          proposalId: p.id,
          proposal: p.data,
          step,
        }),
      );
      // Task 7b: the new step lands on every item that has not reached it yet; keep it off the
      // other open items, one write each (a people step this person does not decide is asked).
      const pos = p.data.afterStepId
        ? project.steps.findIndex((s) => s.id === p.data.afterStepId) + 1
        : 0;
      const steps = [...project.steps.slice(0, pos), step, ...project.steps.slice(pos)];
      const others = itemsToKeepOff(shell.items[entry.pid] ?? [], steps, step.id, p.data.itemId);
      const mine = !human || deciders.includes(uid);
      let done = 0;
      let failed = 0;
      for (const r of others) {
        setProgress(`Keeping ${step.name} off the other open items: ${done} of ${others.length}`);
        try {
          const where = { project: { steps }, projectId: entry.pid, itemId: r.id, item: r.data };
          await run(
            mine
              ? skipStep(ctx, {
                  ...where,
                  stepId: step.id,
                  skip: true,
                  reason: 'Added to the process after this item started',
                })
              : askPathChange(ctx, {
                  ...where,
                  stepId: step.id,
                  reason: 'Added to the process after this item started',
                }),
          );
          done += 1;
        } catch {
          failed += 1;
        }
      }
      setProgress(null);
      toast.push({
        message:
          `${step.name} added to the process.` +
          (others.length
            ? ` Kept off ${done} of ${others.length} other open items${failed ? ` (${failed} could not be changed: change them on the item)` : ''}.`
            : ''),
      });
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await run(
        rejectProposal(ctx, {
          projectId: entry.pid,
          proposalId: p.id,
          itemId: p.data.itemId,
          reason,
        }),
      );
      toast.push({ message: `${p.data.name} not added. The agent can read why.` });
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="approve" onClick={() => setMode('accept')}>
        Add to process…
      </Button>
      <Button variant="sendback" onClick={() => setMode('reject')}>
        Reject…
      </Button>
      <ResponsiveModal
        open={mode !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setMode(null);
        }}
        title={mode === 'reject' ? `Reject ${p.data.name}` : `Add ${p.data.name} to the process`}
        description={project.name}
      >
        {mode === 'accept' ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void accept();
            }}
          >
            <Input label="Step name" value={name} onChange={(e) => setName(e.target.value)} />
            {p.data.kind === 'human' ? (
              <fieldset className="flex flex-col">
                <legend className="mb-1 text-14 font-medium text-ink">Who decides</legend>
                {members.map((m) => (
                  <label key={m} className="flex min-h-11 items-center gap-3 text-14 text-ink">
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--ink)]"
                      checked={deciders.includes(m)}
                      onChange={(e) =>
                        setDeciders((c) =>
                          e.target.checked ? [...c, m] : c.filter((x) => x !== m),
                        )
                      }
                    />
                    {m === uid ? 'You' : displayName(profiles[m], m)}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {progress ? <p className="text-13 text-text-2">{progress}</p> : null}
            {error ? <p className="text-13 text-sendback">{error}</p> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" disabled={busy} onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="approve"
                loading={busy}
                disabled={p.data.kind === 'human' && deciders.length === 0}
              >
                Add to process
              </Button>
            </div>
          </form>
        ) : mode === 'reject' ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void reject();
            }}
          >
            <Textarea
              label="Why not"
              hint="The agent reads it, so it does not propose the same again."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {error ? <p className="text-13 text-sendback">{error}</p> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="sendback"
                loading={busy}
                disabled={reason.trim().length < MIN_REASON}
              >
                Reject
              </Button>
            </div>
          </form>
        ) : null}
      </ResponsiveModal>
    </>
  );
}
