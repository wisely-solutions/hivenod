/**
 * The item a Build it step made (item qwFAWxZM5xkcE7PPjAzi, slice 6): its project, title and the
 * step it is at, with Open. The plan waits until the item is Done; the agent then reports the
 * step done and the plan moves on. The member may not see the item's project (it belongs to
 * another team): the card then shows what the step asked for and the item's id.
 */
import { itemSchema, paths, projectSchema, type InboxOutcome } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { ExternalLink, ListChecks } from 'lucide-react';
import { useReady } from '../auth/context';
import { useLiveDoc } from '../lib/live';
import { Icon } from '../ui/icon';
import { itemLinkParts } from './plan';

export function BuildItCard({ wid, outcome }: { wid: string; outcome: InboxOutcome }) {
  const { session } = useReady();
  const iid = outcome.result?.itemId ?? null;
  const parts = itemLinkParts(outcome.result?.permalink);
  const pid = parts && parts.iid === iid ? parts.pid : null;
  const item = useLiveDoc(pid && iid ? paths.item(wid, pid, iid) : null, itemSchema);
  const project = useLiveDoc(pid ? paths.project(wid, pid) : null, projectSchema);
  if (!iid) return null;
  const it = item.state === 'ready' ? item.data : null;
  const pr = project.state === 'ready' ? project.data : null;
  const stepName = it && pr ? (pr.steps.find((s) => s.id === it.stepId)?.name ?? it.stepId) : null;
  const title = it?.title ?? String(outcome.fields.title ?? 'Build it');
  const state =
    outcome.state === 'done'
      ? 'Done'
      : it?.status === 'done'
        ? 'Done: the agent reports it next'
        : stepName
          ? `At ${stepName}`
          : 'In progress';
  const here = wid === session.workspaceId && pid;
  return (
    <div
      data-build-item={iid}
      className="mt-3 flex items-start gap-3 rounded-card border border-line bg-surface p-3"
    >
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-btn bg-agent-soft text-agent"
      >
        <Icon icon={ListChecks} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-12 text-text-2">
          {pr
            ? pr.name
            : typeof outcome.fields.project === 'string'
              ? outcome.fields.project
              : 'Item'}
        </p>
        <p className="truncate text-14 font-semibold text-ink" title={title}>
          {title}
        </p>
        <p data-build-state="" className="text-13 text-text-2">
          {state}
          {it ? null : ` · item ${iid}`}
        </p>
      </div>
      {here ? (
        <Link
          to="/p/$pid"
          params={{ pid: pid! }}
          search={{ item: iid }}
          className="inline-flex min-h-9 shrink-0 items-center gap-1 text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus"
        >
          Open
          <Icon icon={ExternalLink} size={13} />
        </Link>
      ) : null}
    </div>
  );
}
