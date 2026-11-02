/**
 * The plan in full (plan view, slice C): one plan of a thread as a spec, read-only: its version,
 * every step as a StepSpec, what changed since the version before, and the older versions greyed.
 * It uses the thread's own live queries (useThread): no new reads. The decisions stay on the
 * thread; the link at the top goes back to it.
 */
import {
  agentSchema,
  planView,
  replacedPlanIds,
  type InboxOutcome,
  type InboxPlan,
} from '@hive/shared';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useReady } from '../auth/context';
import { useLiveCollection, type Row } from '../lib/live';
import { dayLabel, hhmm } from '../today/logic';
import { Pill } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Skeleton } from '../ui/feedback';
import { useThread } from './data';
import {
  planDiff,
  planInputOf,
  planVersions,
  stepTitle,
  type DiffStep,
  type StepChange,
} from './plan';
import { StepSpec } from './StepSpec';

const stateWord: Record<InboxPlan['state'], string> = {
  proposed: 'Proposed',
  active: 'Active',
  blocked: 'Blocked',
  done: 'Done',
  stopped: 'Stopped',
};

const dateOf = (p: Row<InboxPlan>) => {
  const d = new Date(p.data.createdAt.toMillis());
  return `${dayLabel(d)}, ${hhmm(d)}`;
};

/** A plan's steps as the diff reads them (steps without an outcome row are left out). */
function diffSteps(plan: Row<InboxPlan>, outcomes: readonly Row<InboxOutcome>[]): DiffStep[] {
  return plan.data.steps.flatMap((id) => {
    const o = outcomes.find((x) => x.id === id);
    return o ? [{ type: o.data.type, fields: o.data.fields }] : [];
  });
}

function ChangeRow({ c }: { c: StepChange }) {
  const word = c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed';
  return (
    <li data-change={c.kind} className="rounded-card border border-line bg-surface-2 p-3">
      <p className="text-14 font-semibold text-ink">
        Step {c.index + 1} · {word}: {c.type ? `${c.type.before} → ${c.type.after}` : c.label}
      </p>
      {c.fields.map((f) => (
        <div key={f.name} className="mt-1.5 text-14 [overflow-wrap:anywhere]">
          <span className="font-medium text-text-2">{f.label}: </span>
          <span className="text-text-2 line-through">{f.before || '(empty)'}</span>
          <span aria-hidden> → </span>
          <span className="sr-only"> became </span>
          <span className="text-ink">{f.after || '(empty)'}</span>
        </div>
      ))}
    </li>
  );
}

export function PlanPage() {
  const { wid, tid, planId } = useParams({ from: '/inbox/$wid/t/$tid/plan/$planId' });
  const { session } = useReady();
  const uid = session.me.uid;
  const { thread, outcomes, plans } = useThread(wid, tid, uid);
  const agents = useLiveCollection(`workspaces/${wid}/agents`, agentSchema);
  const back = (
    <Link
      to="/inbox/$wid/t/$tid"
      params={{ wid, tid }}
      className="mb-3 inline-flex min-h-11 items-center gap-1 rounded-btn pr-2 text-14 font-medium text-text-2 hover:text-ink foc:outline-2 foc:outline-focus"
    >
      <Icon icon={ChevronLeft} size={16} />
      {thread.state === 'ready' && thread.data ? thread.data.title : 'Thread'}
    </Link>
  );
  if (thread.state === 'loading' || plans.state === 'loading' || outcomes.state === 'loading')
    return (
      <div className="mx-auto w-full max-w-3xl" aria-hidden>
        <Skeleton className="mb-4 h-10 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    );
  const rows = (plans.state === 'ready' ? plans.data : []).slice();
  const outs = outcomes.state === 'ready' ? outcomes.data : [];
  const plan = rows.find((p) => p.id === planId);
  if (thread.state === 'error' || !thread.data || thread.data.memberUid !== uid || !plan)
    return (
      <div className="mx-auto w-full max-w-3xl">
        {back}
        <p role="alert" className="text-14 text-text-2">
          This plan is not in your Inbox. Only the person a thread is for can open it.
        </p>
      </div>
    );
  const versions = planVersions(
    rows.map((p) => ({ id: p.id, createdAtMs: p.data.createdAt.toMillis() })),
  );
  const vOf = (id: string) => versions.find((v) => v.id === id)!.n;
  const byVersion = [...rows].sort((a, b) => vOf(a.id) - vOf(b.id));
  const n = vOf(plan.id);
  const prev = byVersion.find((p) => vOf(p.id) === n - 1);
  const newest = byVersion[byVersion.length - 1]!;
  const replaced = replacedPlanIds(
    rows.map((p) => ({
      id: p.id,
      state: p.data.state,
      createdAtMs: p.data.createdAt.toMillis(),
    })),
  ).has(plan.id);
  const agentName = (id: string) =>
    (agents.state === 'ready' && agents.data.find((a) => a.id === id)?.data.name) || 'An agent';
  const pl = planInputOf(plan, outs);
  const view = planView(pl.plan, pl.outcomes);
  const curSteps = diffSteps(plan, outs);
  const changes = prev
    ? planDiff(diffSteps(prev, outs), curSteps).filter((c) => c.kind !== 'same')
    : [];
  const older = byVersion.filter((p) => vOf(p.id) < n).reverse();

  return (
    <div data-plan-page={plan.id} className="mx-auto w-full max-w-3xl pb-10">
      {back}
      <header>
        <p className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
          Plan · v{n} of {versions.length}
        </p>
        <h1 className="mt-1 text-20 font-semibold sm:text-24 text-ink [overflow-wrap:anywhere]">
          {thread.data.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-14 text-text-2">
          <span>{agentName(plan.data.proposedBy)}</span>
          <span aria-hidden>·</span>
          <span>{dateOf(plan)}</span>
          <Pill tone={replaced ? 'neutral' : 'agent'}>
            {replaced ? `Replaced by v${vOf(newest.id)}` : stateWord[plan.data.state]}
          </Pill>
        </div>
        {plan.data.note ? (
          <p className="mt-2 text-14 text-ink [overflow-wrap:anywhere]">{plan.data.note}</p>
        ) : null}
        {replaced ? (
          <p className="mt-2 text-13 text-text-2">
            A newer plan replaced this one before it was decided.{' '}
            <Link
              to="/inbox/$wid/t/$tid/plan/$planId"
              params={{ wid, tid, planId: newest.id }}
              className="font-medium text-agent hov:underline"
            >
              Open v{vOf(newest.id)}
            </Link>
          </p>
        ) : null}
      </header>

      <ol aria-label="Steps" className="mt-5 flex flex-col gap-4">
        {view.steps.map((s) => {
          const row = outs.find((o) => o.id === s.outcomeId);
          return (
            <li
              key={s.outcomeId}
              data-step={s.number}
              className="rounded-card border border-line bg-surface p-4"
            >
              <h2 className="text-15 font-semibold text-ink [overflow-wrap:anywhere]">
                <span className="text-text-2">{s.number}. </span>
                {stepTitle(s.type, row?.data.fields ?? {})}
              </h2>
              {row ? (
                <StepSpec
                  type={row.data.type}
                  fields={row.data.fields}
                  ui={s.ui}
                  className="mt-2"
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {prev ? (
        <section aria-labelledby="changed-h" data-plan-changes="" className="mt-8">
          <h2 id="changed-h" className="text-16 font-semibold text-ink">
            What changed since v{n - 1}
          </h2>
          {changes.length ? (
            <ul className="mt-3 flex flex-col gap-2">
              {changes.map((c) => (
                <ChangeRow key={c.index} c={c} />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-14 text-text-2">Nothing: the steps are the same.</p>
          )}
        </section>
      ) : null}

      {older.length ? (
        <section aria-labelledby="older-h" data-plan-older="" className="mt-8">
          <h2 id="older-h" className="text-16 font-semibold text-ink">
            Older versions
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {older.map((p) => (
              <li
                key={p.id}
                data-older-version={vOf(p.id)}
                className={cn('rounded-card border border-line bg-surface-2 p-3 text-text-2')}
              >
                <Link
                  to="/inbox/$wid/t/$tid/plan/$planId"
                  params={{ wid, tid, planId: p.id }}
                  className="text-14 font-semibold text-text-2 underline foc:outline-2 foc:outline-focus"
                >
                  v{vOf(p.id)}
                </Link>
                <span className="text-14">
                  {' · '}
                  {dateOf(p)} · {stateWord[p.data.state]}
                  {p.data.state === 'proposed' && p.id !== newest.id ? ' (replaced)' : ''}
                </span>
                {p.data.note ? (
                  <p className="mt-1 text-13 [overflow-wrap:anywhere]">{p.data.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
