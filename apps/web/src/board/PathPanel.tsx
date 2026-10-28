/**
 * The item's path in its detail (card st5INNZj): the strip (A) that opens into the trail (C), the
 * decision on a pending people-step change for its deciders, the path editor, and for an item
 * waiting to be shaped: "Set path" and "Use the full process".
 */
import {
  askPathChange,
  decidePathChange,
  isUnshaped,
  planPathChange,
  shapeItem,
  skips,
  skipReason,
  skipStep,
  fullProcessPlan,
  type ActionPlan,
  type Agent,
  type ActionContext,
  type Decision,
  type Item,
  type Project,
  ownGet,
} from '@hive/shared';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { displayName, useProfiles } from '../members/data';
import type { Row } from '../lib/live';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Textarea } from '../ui/form';
import { PathStrip } from '../ui/path';
import { useToast } from '../ui/overlay';
import { isItemLive } from './logic';
import { editableSteps, pathView, type PathSegment } from './path';

/** The item as it will be after a path write (each write bumps pathRev; the rules check it). */
function after(item: Item, change: Partial<Item>): Item {
  return { ...item, ...change, pathRev: (item.pathRev ?? 0) + 1 };
}
function withSkip(item: Item, stepId: string, kind: 'agent' | 'human', on: boolean): Item {
  const key = kind === 'agent' ? 'pathSkips' : 'gateSkips';
  const map = { ...(item[key] ?? {}) };
  if (on) map[stepId] = '';
  else delete map[stepId];
  return after(item, { [key]: map, ...(item.pathSkips ? {} : { pathSkips: {} }) });
}

/** Uses the decision on one pending people-step change; shared with Needs you (the seam for the
 * single phone decision bar, card 9bmMIGlC). */
export function usePathDecision(projectId: string, itemId: string, project: Project, item: Item) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(stepId: string, approve: boolean) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(`${stepId}:${approve}`);
    try {
      await run(decidePathChange(ctx, { project, projectId, itemId, item, stepId, approve }));
      const name = project.steps.find((s) => s.id === stepId)?.name ?? 'the step';
      const op = ownGet(item.pathRequests, stepId)?.op;
      toast.push({
        message: approve
          ? op === 'add'
            ? `${name} added to the path.`
            : `${name} skipped for this item.`
          : `${name} kept as it was.`,
      });
    } catch (e) {
      toast.push({ message: `Could not save: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }
  return { decide, busy };
}

/** The two buttons for a pending change, in the words of the design. */
export function PathDecisionButtons({
  name,
  op,
  busy,
  onDecide,
}: {
  name: string;
  op: 'add' | 'drop';
  busy: string | null;
  onDecide: (approve: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="approve"
        loading={busy?.endsWith(':true')}
        disabled={!!busy}
        onClick={() => onDecide(true)}
      >
        {op === 'add' ? `Add ${name}` : 'Approve skip'}
      </Button>
      <Button
        variant="sendback"
        loading={busy?.endsWith(':false')}
        disabled={!!busy}
        onClick={() => onDecide(false)}
      >
        {op === 'add' ? 'Keep it skipped' : 'Keep the step'}
      </Button>
    </div>
  );
}

export function PathPanel({
  pid,
  itemId,
  project,
  item,
  agents,
  decisions = [],
}: {
  pid: string;
  itemId: string;
  project: Project;
  item: Item;
  agents: Row<Agent>[];
  /** The item's decisions, for who approved each gate in the trail. */
  decisions?: Row<Decision>[];
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const uid = session.me.uid;
  const approved = useMemo(() => {
    const latest: Record<string, Row<Decision>> = {};
    for (const d of decisions) {
      if (d.data.outcome !== 'approved') continue;
      const cur = latest[d.data.stepId];
      if (!cur || d.data.at.toMillis() > cur.data.at.toMillis()) latest[d.data.stepId] = d;
    }
    return latest;
  }, [decisions]);
  const deciders = useMemo(
    () => [
      ...new Set([
        ...project.steps.flatMap((s) => s.gate?.deciderUids ?? []),
        ...Object.values(approved).map((d) => d.data.byUid),
      ]),
    ],
    [project.steps, approved],
  );
  const profiles = useProfiles(session.workspaceId, deciders);
  const names = useMemo(
    () => Object.fromEntries(deciders.map((u) => [u, displayName(profiles[u], u)])),
    [deciders, profiles],
  );
  const [now] = useState(() => Date.now());
  const holder = item.claim ? agents.find((a) => a.id === item.claim?.agentUid) : undefined;
  const view = pathView({
    project,
    item,
    uid,
    names,
    approvals: Object.fromEntries(
      Object.entries(approved).map(([id, d]) => [
        id,
        { name: names[d.data.byUid] ?? 'a decider', atMs: d.data.at.toMillis() },
      ]),
    ),
    agent: holder ? { name: holder.data.name, live: isItemLive(item, now) } : null,
  });
  const { decide, busy } = usePathDecision(pid, itemId, project, item);
  const unshaped = isUnshaped(item);
  const open = ['queued', 'working', 'waiting'].includes(item.status);
  const [editing, setEditing] = useState(false);
  const [want, setWant] = useState<Set<string>>(new Set());
  const [why, setWhy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = editableSteps(project, item);
  const startEdit = () => {
    setWant(new Set(editable.filter((s) => !skips(item, s)).map((s) => s.id)));
    setWhy('');
    setError(null);
    setEditing(true);
  };
  const plan = planPathChange(project, item, { type: 'human', id: uid }, [
    ...want,
    ...project.steps.filter((s) => !editable.includes(s)).map((s) => s.id),
  ]);
  // Shaping: every step not kept is skipped; people steps the person does not decide are asked.
  const shapeAsks = unshaped
    ? editable.filter(
        (s) => !want.has(s.id) && s.kind === 'human' && !s.gate?.deciderUids.includes(uid),
      )
    : [];
  const needsWhy = (unshaped ? shapeAsks.length : plan.ask.length) > 0;
  const whyOk = !needsWhy || why.trim().length >= 10;

  async function commit(plans: ActionPlan[]) {
    for (const p of plans) await run(p);
  }

  async function save() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setSaving(true);
    setError(null);
    try {
      if (unshaped) {
        const skipsWanted = Object.fromEntries(
          editable.filter((s) => !want.has(s.id)).map((s) => [s.id, why.trim()]),
        );
        const p = shapeItem(ctx, {
          project,
          projectId: pid,
          itemId,
          item,
          skips: skipsWanted,
          note: 'Set by hand',
        });
        await commit([...p.asks, p]);
        // People steps this person decides: their skip is their own decision, at once.
        let state = after(item, { shape: { by: { type: 'human', id: uid } } as Item['shape'] });
        state = { ...state, pathRev: (item.pathRev ?? 0) + p.asks.length + 1 };
        state = {
          ...state,
          pathSkips: Object.fromEntries(p.skipped.map((id) => [id, ''])),
          pathRequests: Object.fromEntries(
            p.pending.map((id) => [
              id,
              {
                op: 'drop' as const,
                by: { type: 'human' as const, id: uid },
                reason: '',
                at: null as never,
              },
            ]),
          ),
        };
        for (const id of p.pending) {
          if (!project.steps.find((s) => s.id === id)?.gate?.deciderUids.includes(uid)) continue;
          await run(
            decidePathChange(ctx, {
              project,
              projectId: pid,
              itemId,
              item: state,
              stepId: id,
              approve: true,
            }),
          );
          const reqs = { ...(state.pathRequests ?? {}) };
          delete reqs[id];
          state = withSkip({ ...state, pathRequests: reqs }, id, 'human', true);
        }
        toast.push({ message: 'Path set.' });
      } else {
        let state = item;
        const applied: { id: string; on: boolean; prev: string }[] = [];
        for (const id of [...plan.skip, ...plan.unskip]) {
          const step = project.steps.find((s) => s.id === id)!;
          const on = plan.skip.includes(id);
          // The reason it had before, so that undoing an un-skip puts it back as it was.
          const prev = skipReason(state, step);
          await run(
            skipStep(ctx, {
              project,
              projectId: pid,
              itemId,
              item: state,
              stepId: id,
              skip: on,
              reason: why.trim(),
            }),
          );
          state = withSkip(state, id, step.kind, on);
          applied.push({ id, on, prev });
        }
        for (const id of plan.ask) {
          await run(
            askPathChange(ctx, {
              project,
              projectId: pid,
              itemId,
              item: state,
              stepId: id,
              reason: why.trim(),
            }),
          );
          state = after(state, {});
        }
        const finalState = state;
        toast.push({
          message: plan.ask.length
            ? 'Path changed. The deciders of the people steps you changed are asked.'
            : 'Path changed.',
          ...(applied.length
            ? {
                undoLabel: 'Undo',
                duration: 8000,
                onUndo: () => void undoPath(ctx, finalState, applied),
              }
            : {}),
        });
      }
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** Undo = the opposite change of each step, last first (the same as an agent's undo). */
  async function undoPath(
    ctx: ActionContext,
    from: Item,
    applied: { id: string; on: boolean; prev: string }[],
  ) {
    try {
      let state = from;
      for (const { id, on, prev } of [...applied].reverse()) {
        const step = project.steps.find((x) => x.id === id)!;
        await run(
          skipStep(ctx, {
            project,
            projectId: pid,
            itemId,
            item: state,
            stepId: id,
            skip: !on,
            reason: on ? '' : prev,
          }),
        );
        state = withSkip(state, id, step.kind, !on);
      }
      toast.push({ message: 'Path change undone.' });
    } catch (e) {
      toast.push({ message: `Could not undo: ${(e as Error).message}` });
    }
  }

  async function chooseFullProcess() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setSaving(true);
    try {
      await run(fullProcessPlan(ctx, { project, projectId: pid, itemId, item }));
      toast.push({ message: 'This item goes through the full process.' });
    } catch (e) {
      toast.push({ message: `Could not save: ${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  }

  const rowExtra = (s: PathSegment) => {
    const op = s.request;
    if (!op) return null;
    const req = ownGet(item.pathRequests, s.id);
    const asker =
      req?.by.type === 'agent'
        ? (agents.find((a) => a.id === req.by.id)?.data.name ?? 'Removed agent')
        : displayName(profiles[req?.by.id ?? ''], req?.by.id ?? '');
    return (
      <div className="ml-7 flex flex-col gap-2 rounded-card border border-dashed border-gate bg-gate-bg p-2.5 text-13">
        <p className="text-ink">
          <span className="font-semibold">
            {asker} {op === 'add' ? `suggests adding ${s.name}` : `asks to skip ${s.name}`}.
          </span>{' '}
          {req?.reason ? `“${req.reason}”` : null}
        </p>
        {s.mine && open ? (
          <PathDecisionButtons
            name={s.name}
            op={op}
            busy={busy}
            onDecide={(a) => void decide(s.id, a)}
          />
        ) : (
          <p className="text-text-2">
            Any one of its deciders settles it. The item keeps going meanwhile.
          </p>
        )}
      </div>
    );
  };

  if (item.type === 'finding' || item.status === 'suggested') return null;

  const editor = editing ? (
    <div className="flex flex-col gap-2.5 rounded-card border border-line bg-canvas p-3">
      <p className="text-13 text-text-2">
        {unshaped
          ? 'Pick the steps this item goes through.'
          : 'Steps after the current one. Agent steps change at once; a people step changes at once only if you decide it, otherwise its deciders are asked.'}
      </p>
      <ul className="flex flex-col">
        {editable.map((s) => {
          const mine = s.kind === 'human' && !!s.gate?.deciderUids.includes(uid);
          return (
            <li key={s.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-14 text-ink">
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--ink)]"
                  checked={want.has(s.id)}
                  onChange={(e) =>
                    setWant((cur) => {
                      const n = new Set(cur);
                      if (e.target.checked) n.add(s.id);
                      else n.delete(s.id);
                      return n;
                    })
                  }
                />
                <span className="font-medium">{s.name}</span>
                <span
                  className={cn('text-12', s.kind === 'human' ? 'text-gate-text' : 'text-text-3')}
                >
                  {s.kind === 'human'
                    ? mine
                      ? 'people step · you decide'
                      : 'people step · asks its deciders'
                    : 'agent step'}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <Textarea
        label={needsWhy ? 'Why (the deciders read it)' : 'Why (optional)'}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        hint={needsWhy ? 'At least 10 characters.' : 'Saved with the change in the history.'}
      />
      {error ? <p className="text-13 text-sendback">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={saving}
          disabled={!whyOk || want.size === 0}
          onClick={() => void save()}
        >
          {unshaped ? 'Set path' : 'Save path'}
        </Button>
        <Button variant="secondary" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  ) : null;

  if (unshaped) {
    return (
      <section
        aria-label="Path"
        data-testid="shaping-panel"
        className="flex flex-col gap-2.5 rounded-card border border-dashed border-agent bg-agent-soft p-3"
      >
        <p className="text-14 text-ink">
          <span className="font-semibold">{view.status?.text}</span>{' '}
          {holder
            ? 'It picks the steps this item needs.'
            : 'An agent picks the steps this item needs. Nobody works on it or decides it until then.'}
        </p>
        {!holder && !editing ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={startEdit}>
              Set path
            </Button>
            <Button variant="secondary" loading={saving} onClick={() => void chooseFullProcess()}>
              Use the full process
            </Button>
          </div>
        ) : null}
        {editor}
      </section>
    );
  }

  return (
    <PathStrip view={view} rowExtra={rowExtra} defaultOpen={view.pending.length > 0}>
      {open && !editing && editable.length > 0 ? (
        <Button variant="secondary" className="self-start" onClick={startEdit}>
          Change path
        </Button>
      ) : null}
      {editor}
    </PathStrip>
  );
}
