import { AGENT_ONLINE_MS, type Agent, type Item, type Project, type Run } from '@hive/shared';
import type { Row } from '../lib/live';
import { AGENT_COLORS } from '../ui/avatar';

/** An agent is online when it was seen or sent a heartbeat in the last two minutes (SPEC 6). */
export const ONLINE_MINUTES = AGENT_ONLINE_MS / 60_000;

export const COLOR_NAMES = [
  'Blue',
  'Violet',
  'Magenta',
  'Rust',
  'Amber',
  'Green',
  'Teal',
  'Slate',
] as const;

/** Colours are stored as `agent-3`; anything else falls back to a stable pick from the id. */
export function colorIndex(color: string, uid: string): number {
  const m = /^agent-([1-8])$/.exec(color);
  if (m) return Number(m[1]);
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % AGENT_COLORS) + 1;
}

export const colorValue = (index: number) => `agent-${index}`;

export type AgentStatus =
  | { kind: 'revoked' }
  /** `items`: how many items it works on at once (card cGSENsRF: a channel session with max_items). */
  | { kind: 'online'; working: { title: string; items?: number } | null }
  /** Paused after too many failed runs (card zSzW3LXy); a run still going shows as online. */
  | { kind: 'paused'; reason: string | null }
  | { kind: 'idle'; lastSeen: Date | null };

export function lastSeenOf(agent: Agent, runs: Row<Run>[], uid: string): Date | null {
  let best = agent.lastSeenAt?.toMillis() ?? 0;
  for (const r of runs) {
    if (r.data.agentUid === uid) best = Math.max(best, r.data.heartbeatAt.toMillis());
  }
  return best ? new Date(best) : null;
}

/** Seen or heartbeating in the last two minutes, not signed out, and not paused (a paused agent takes no new work). */
export function isOnline(agent: Agent, runs: Row<Run>[], uid: string, now: number): boolean {
  if (agent.revokedAt || agent.pausedAt) return false;
  const seen = lastSeenOf(agent, runs, uid);
  const out = agent.signedOutAt?.toMillis() ?? 0;
  return !!seen && seen.getTime() > out && now - seen.getTime() < ONLINE_MINUTES * 60_000;
}

export function agentStatus(
  uid: string,
  agent: Agent,
  runs: Row<Run>[],
  items: Record<string, Row<Item>[]>,
  now: number,
): AgentStatus {
  if (agent.revokedAt) return { kind: 'revoked' };
  // The session said it stopped (Ctrl+C, --once, exit): nothing before that counts as online.
  const out = agent.signedOutAt?.toMillis() ?? 0;
  const fresh = (ms: number) => ms > out && now - ms < ONLINE_MINUTES * 60_000;
  const lives = runs
    .filter(
      (r) =>
        r.data.agentUid === uid &&
        r.data.status === 'running' &&
        !r.data.endedAt &&
        fresh(r.data.heartbeatAt.toMillis()),
    )
    .sort((a, b) => b.data.heartbeatAt.toMillis() - a.data.heartbeatAt.toMillis());
  const live = lives[0];
  if (live) {
    const n = new Set(lives.map((r) => `${r.data.projectId}/${r.data.itemId}`)).size;
    const item = (items[live.data.projectId] ?? []).find((i) => i.id === live.data.itemId);
    if (n > 1) return { kind: 'online', working: { title: item?.data.title ?? '', items: n } };
    return { kind: 'online', working: item ? { title: item.data.title } : null };
  }
  if (agent.pausedAt) return { kind: 'paused', reason: agent.pausedReason ?? null };
  const seen = lastSeenOf(agent, runs, uid);
  if (seen && fresh(seen.getTime())) return { kind: 'online', working: null };
  return { kind: 'idle', lastSeen: seen };
}

export function timeAgo(then: Date, now: number): string {
  const s = Math.max(0, Math.round((now - then.getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function statusText(s: AgentStatus, now: number): string {
  if (s.kind === 'revoked') return 'Revoked';
  if (s.kind === 'paused') return `Paused${s.reason ? ` · ${s.reason}` : ''} · takes no new work`;
  if (s.kind === 'online') {
    if (s.working?.items && s.working.items > 1) return `Online · working ${s.working.items} items`;
    return s.working ? `Online · working on “${s.working.title}”` : 'Online · waiting for work';
  }
  return s.lastSeen
    ? `Offline · last seen ${timeAgo(s.lastSeen, now)}`
    : 'Offline · not connected yet';
}

export function scopeText(agent: Agent, projects: Row<Project>[]): string {
  if (agent.projectIds === '*') return 'All projects';
  const names = agent.projectIds
    .map((id) => projects.find((p) => p.id === id)?.data.name)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return 'No projects';
  return names.length <= 2
    ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** Runs started since local midnight, and what they cost. */
export function todayStats(uid: string, runs: Row<Run>[], now: number) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const mine = runs.filter((r) => r.data.agentUid === uid && r.data.startedAt.toMillis() >= start);
  return { runs: mine.length, cost: mine.reduce((sum, r) => sum + r.data.costEur, 0) };
}
