import {
  parkOf,
  STALE_CLAIM_MINUTES,
  type Agent,
  type Item,
  type Project,
  type Run,
} from '@hive/shared';
import { isOnline } from '../agents/logic';
import type { Row } from '../lib/live';

/** Items by project id, as the shell has them loaded. */
export type ItemsByProject = Record<string, Row<Item>[]>;

/** True when this person is a decider at the item's current gate and has not decided yet. */
export function needsMyDecision(project: Project, item: Item, uid: string): boolean {
  if (item.status !== 'waiting' || !item.gate) return false;
  // Nobody decides an item before it is shaped (card st5INNZj).
  if (item.shape === null) return false;
  const step = project.steps.find((s) => s.id === item.stepId);
  if (!step || step.kind !== 'human' || !step.gate) return false;
  if (!step.gate.deciderUids.includes(uid)) return false;
  return !(uid in item.gate.approvals) && !(uid in item.gate.rejections);
}

export interface NeedsYou {
  total: number;
  byProject: Record<string, number>;
}

export function countNeedsYou(
  projects: Row<Project>[],
  items: ItemsByProject,
  uid: string,
): NeedsYou {
  const byProject: Record<string, number> = {};
  let total = 0;
  for (const p of projects) {
    if (p.data.archivedAt) continue;
    const n = (items[p.id] ?? []).filter((i) => needsMyDecision(p.data, i.data, uid)).length;
    if (n > 0) {
      byProject[p.id] = n;
      total += n;
    }
  }
  return { total, byProject };
}

/** A run is live when it is running and its heartbeat is recent. */
export function isLive(run: Run, now: number): boolean {
  return (
    run.status === 'running' &&
    !run.endedAt &&
    now - run.heartbeatAt.toMillis() < STALE_CLAIM_MINUTES * 60_000
  );
}

/**
 * Working agents: a live run, or a fresh claim on an open item (the board's own signal, which
 * arrives with the claim itself, so the footer and the board agree and the footer does not wait
 * for the month-of-runs listener).
 */
export function agentActivity(
  agents: Row<Agent>[],
  runs: Row<Run>[],
  now: number,
  claims: Row<Item>[] = [],
) {
  const active = agents.filter((a) => !a.data.revokedAt);
  const busy = new Set(runs.filter((r) => isLive(r.data, now)).map((r) => r.data.agentUid));
  for (const i of claims) {
    const c = i.data.claim;
    if (c && now - c.heartbeatAt.toMillis() < STALE_CLAIM_MINUTES * 60_000) busy.add(c.agentUid);
  }
  const working = active.filter((a) => busy.has(a.id)).length;
  // Idle = connected and waiting; an offline agent (as the agent page says) is neither.
  const idle = active.filter((a) => !busy.has(a.id) && isOnline(a.data, runs, a.id, now)).length;
  return { working, idle };
}

/**
 * Items agents are working on right now (card cGSENsRF: one agent may hold several): items with a
 * live run or a fresh claim, counted once each.
 */
export function itemsInWork(runs: Row<Run>[], now: number, claims: Row<Item>[] = []): number {
  const keys = new Set(
    runs.filter((r) => isLive(r.data, now)).map((r) => `${r.data.projectId}/${r.data.itemId}`),
  );
  const claimed = new Set<string>();
  for (const i of claims) {
    const c = i.data.claim;
    if (c && now - c.heartbeatAt.toMillis() < STALE_CLAIM_MINUTES * 60_000) claimed.add(c.runId);
  }
  // A claim and its run are the same item: count claims whose run is not (yet) seen live.
  const liveRuns = new Set(runs.filter((r) => isLive(r.data, now)).map((r) => r.id));
  for (const id of claimed) if (!liveRuns.has(id)) keys.add(`run/${id}`);
  return keys.size;
}

/** Items agents hold but parked, waiting on something outside them (item QjTTL). */
export function itemsWaiting(now: number, claims: Row<Item>[] = []): number {
  let n = 0;
  for (const i of claims) {
    const c = i.data.claim;
    if (c && now - c.heartbeatAt.toMillis() < STALE_CLAIM_MINUTES * 60_000 && parkOf(i.data)) n++;
  }
  return n;
}

/**
 * The footer's agent line. With parked items (item QjTTL): "1 agent · working 2 · waiting 1 · 0
 * idle"; otherwise as before ("2 agents working on 3 items · 0 idle").
 */
export function activityText(a: { working: number; idle: number; items: number; waiting: number }) {
  const agents = `${a.working} ${a.working === 1 ? 'agent' : 'agents'}`;
  if (a.waiting > 0)
    return `${agents} · working ${Math.max(0, a.items - a.waiting)} · waiting ${a.waiting} · ${a.idle} idle`;
  const items = a.items > a.working ? ` on ${a.items} items` : '';
  return `${agents} working${items} · ${a.idle} idle`;
}

/**
 * Shape of the shell's month-of-runs query (equality, range, order). Firestore needs a composite
 * index with exactly this direction; the emulator does not check, so a unit test holds it against
 * firestore.indexes.json.
 */
export const MONTH_RUNS = { equal: 'projectId', range: 'startedAt', direction: 'desc' } as const;

/** Run cost since the start of the current month (display only). */
export function monthSpend(runs: Row<Run>[], now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return runs.reduce(
    (sum, r) => (r.data.startedAt.toMillis() >= start ? sum + r.data.costEur : sum),
    0,
  );
}

/**
 * Money only once it is final: a cached subset of runs would under-report. Until then show the
 * last confirmed value for `scope` (remembered on this device), or "€…" when there is none.
 */
export function spendText(spent: number, known: boolean, scope?: string): string {
  const key = scope ? `hive.spend.last.${scope}` : null;
  if (known) {
    if (key)
      try {
        localStorage.setItem(key, String(spent));
      } catch {
        /* storage is a convenience */
      }
    return formatEur(spent);
  }
  if (key)
    try {
      const last = Number(localStorage.getItem(key));
      if (localStorage.getItem(key) !== null && Number.isFinite(last)) return formatEur(last);
    } catch {
      /* fall through */
    }
  return '€…';
}

export function formatEur(n: number): string {
  // A real but tiny cost (a short agent run) is not shown as free.
  if (n > 0 && n < 0.005) return '<€0.01';
  const rounded = Math.round(n * 100) / 100;
  return `€${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}
