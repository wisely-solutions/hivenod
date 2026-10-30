import { AGENT_ONLINE_MS, type Agent } from '@hive/shared';
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
  | { kind: 'online' }
  /** Paused after too many failed runs (card zSzW3LXy). */
  | { kind: 'paused'; reason: string | null }
  | { kind: 'idle'; lastSeen: Date | null };

export function lastSeenOf(agent: Agent): Date | null {
  const best = agent.lastSeenAt?.toMillis() ?? 0;
  return best ? new Date(best) : null;
}

/** Seen in the last two minutes, not signed out, and not paused (a paused agent takes no new work). */
export function isOnline(agent: Agent, now: number): boolean {
  if (agent.revokedAt || agent.pausedAt) return false;
  const seen = lastSeenOf(agent);
  const out = agent.signedOutAt?.toMillis() ?? 0;
  return !!seen && seen.getTime() > out && now - seen.getTime() < ONLINE_MINUTES * 60_000;
}

/**
 * Where an agent stands (projects and their runs were removed in item OE8FmrTaIxFVGcaeGG3N, slice
 * 11: presence alone says it). The session said it stopped (Ctrl+C, --once, exit): nothing before
 * that counts as online.
 */
export function agentStatus(agent: Agent, now: number): AgentStatus {
  if (agent.revokedAt) return { kind: 'revoked' };
  if (agent.pausedAt) return { kind: 'paused', reason: agent.pausedReason ?? null };
  const seen = lastSeenOf(agent);
  const out = agent.signedOutAt?.toMillis() ?? 0;
  if (seen && seen.getTime() > out && now - seen.getTime() < ONLINE_MINUTES * 60_000)
    return { kind: 'online' };
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
  if (s.kind === 'online') return 'Online · waiting for work';
  return s.lastSeen
    ? `Offline · last seen ${timeAgo(s.lastSeen, now)}`
    : 'Offline · not connected yet';
}
