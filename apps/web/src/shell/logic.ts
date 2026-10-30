import type { Agent } from '@hive/shared';
import { isOnline } from '../agents/logic';
import type { Row } from '../lib/live';

/**
 * The footer's agents (item OE8FmrTaIxFVGcaeGG3N, slice 11): projects and their runs are gone, so
 * no agent counts as working on an item; idle = connected and waiting for work (an offline or
 * paused agent, as the agent page says, is neither).
 */
export function agentActivity(agents: Row<Agent>[], now: number) {
  const active = agents.filter((a) => !a.data.revokedAt);
  return { working: 0, idle: active.filter((a) => isOnline(a.data, now)).length };
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

export function formatEur(n: number): string {
  // A real but tiny cost (a short agent run) is not shown as free.
  if (n > 0 && n < 0.005) return '<€0.01';
  const rounded = Math.round(n * 100) / 100;
  return `€${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}
