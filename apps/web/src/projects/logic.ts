import type { EventType, HiveEvent, Project, Run } from '@hive/shared';
import type { Row } from '../lib/live';
import { eventSentence } from '../activity/logic';
import { isLive } from '../shell/logic';
import type { ItemsByProject } from '../shell/logic';

export interface ProjectSummary {
  needsYou: number;
  openItems: number;
  agentsActive: number;
  /** Run cost this month, in euros. */
  spend: number;
}

export function summarize(
  pid: string,
  items: ItemsByProject,
  runs: Row<Run>[],
  needsYou: number,
  now: number,
): ProjectSummary {
  const mine = runs.filter((r) => r.data.projectId === pid);
  return {
    needsYou,
    openItems: (items[pid] ?? []).length,
    agentsActive: new Set(mine.filter((r) => isLive(r.data, now)).map((r) => r.data.agentUid)).size,
    spend: mine.reduce((sum, r) => sum + r.data.costEur, 0),
  };
}

/** Projects that need you come first, then the newest. Stable, so cards only move when counts do. */
export function orderProjects(
  projects: Row<Project>[],
  needs: Record<string, number>,
): Row<Project>[] {
  return [...projects].sort(
    (a, b) =>
      (needs[b.id] ?? 0) - (needs[a.id] ?? 0) ||
      b.data.createdAt.toMillis() - a.data.createdAt.toMillis() ||
      a.id.localeCompare(b.id),
  );
}

export const VERBS: Record<EventType, string> = {
  'item.created': 'added an item',
  'item.moved': 'moved an item',
  'item.claimed': 'picked up an item',
  'item.released': 'let go of an item',
  'item.completed': 'finished a step',
  'item.sentBack': 'sent an item back',
  'item.updated': 'updated an item',
  'item.deleted': 'deleted an item',
  'item.workStopped': 'stopped an agent’s work',
  'item.resumed': 'resumed an item',
  'item.archived': 'archived an item',
  'item.restored': 'restored an item',
  'item.erasing': 'started deleting an item',
  'attachment.added': 'attached a file',
  'message.posted': 'posted a message',
  'decision.approved': 'approved an item',
  'decision.sentBack': 'sent an item back',
  'decision.stopped': 'stopped an item',
  'decision.answered': 'answered a question',
  'finding.raised': 'suggested an idea',
  'finding.triaged': 'triaged a suggestion',
  'run.started': 'started a run',
  'run.heartbeat': 'is still working',
  'run.ended': 'ended a run',
  'agent.created': 'created an agent',
  'agent.revoked': 'revoked an agent',
  'agent.rotated': 'rotated an agent token',
  'agent.updated': 'updated an agent',
  'project.created': 'created a project',
  'project.updated': 'updated a project',
  'project.processChanged': 'changed the process',
  'project.archived': 'archived a project',
  'project.deleted': 'deleted a project',
  'project.membersChanged': 'changed who is on the project',
  'workspace.created': 'created the organization',
  'workspace.updated': 'updated the organization',
  'workspace.deleting': 'started deleting the organization',
  'member.invited': 'invited someone',
  'member.joined': 'joined',
  'member.roleChanged': 'changed a role',
  'member.removed': 'removed a member',
  'member.left': 'left the organization',
  'member.inviteRevoked': 'revoked an invite',
  'group.created': 'created a group',
  'group.updated': 'updated a group',
  'group.deleted': 'deleted a group',
  'item.shaped': 'set an item’s path',
  'item.pathChanged': 'changed an item’s path',
  'item.pathChangeDecided': 'decided a path change',
  'step.proposed': 'proposed a step',
  'step.accepted': 'added a proposed step',
  'step.rejected': 'turned down a proposed step',
};

/** "Scout finished a step": who did it and what, in plain words. */
export function describeEvent(
  e: Pick<HiveEvent, 'actor' | 'type'> & { data?: HiveEvent['data'] },
): string {
  const verb =
    e.type === 'project.updated' && e.data?.restored ? 'restored a project' : VERBS[e.type];
  return `${e.actor.name || 'Someone'} ${verb ?? 'did something'}`;
}

/**
 * Like describeEvent, but names the item when its title is known ("Rui sent “Ticket rules” back").
 * Events with no item, or no known title, keep the plain wording.
 */
export function describeEventWithItem(
  e: Pick<HiveEvent, 'actor' | 'type' | 'itemId' | 'data'>,
  title: string | null | undefined,
): string {
  return title && e.itemId ? eventSentence(e, title) : describeEvent(e);
}

/** The newest event of each project, by project id. `events` may be in any order. */
export function latestByProject(events: Row<HiveEvent>[]): Record<string, Row<HiveEvent>> {
  const out: Record<string, Row<HiveEvent>> = {};
  for (const e of events) {
    const pid = e.data.projectId;
    if (!pid) continue;
    const cur = out[pid];
    if (!cur || e.data.at.toMillis() > cur.data.at.toMillis()) out[pid] = e;
  }
  return out;
}

export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const PROJECT_COLORS = 8;
/** Colours are stored as `agent-3` (the shared eight-colour palette). */
export function projectColorIndex(color: string, seed: string): number {
  const m = /^agent-([1-8])$/.exec(color);
  if (m) return Number(m[1]);
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % PROJECT_COLORS) + 1;
}

export const EMOJI_CHOICES = [
  '📁',
  '🏗️',
  '✍️',
  '🔎',
  '🚀',
  '🤝',
  '💡',
  '🧪',
  '📊',
  '🛠️',
  '🌱',
  '📣',
];
