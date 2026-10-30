/**
 * The Off switch on the web (scheduled tasks slice 7, design 9.4): what the pill, the panel and
 * the Today banner say, from the member's Off doc in each organization. Pure, so it is tested
 * without Firestore.
 */
import { isOffFor, type AgentsOff } from '@hive/shared';

/** The member's Off doc in one organization (null: absent, all on). */
export interface OrgOff {
  wid: string;
  off: Pick<AgentsOff, 'all' | 'agents'> & { sinceMs: number | null };
}

/** Whether a doc has anything Off. */
export const isOffDoc = (o: OrgOff['off'] | null | undefined): boolean =>
  !!o && o.sinceMs !== null && (o.all || o.agents.length > 0);

export interface OffSummary {
  /** Something is Off in some organization. */
  off: boolean;
  /** Every organization the member is in has all agents Off. */
  all: boolean;
  /** The earliest since among the Off docs. */
  sinceMs: number | null;
  /** The agents named (when not all), with their organization. */
  agents: { wid: string; uid: string }[];
  /** The pill's text: "Agents on", "Agents off", "Off: Hive", "Off: 2 agents". */
  label: string;
}

export function summarizeOff(
  orgs: readonly OrgOff[],
  agentName: (wid: string, uid: string) => string | null,
): OffSummary {
  const offOrgs = orgs.filter((o) => isOffDoc(o.off));
  if (offOrgs.length === 0)
    return { off: false, all: false, sinceMs: null, agents: [], label: 'Agents on' };
  const all = orgs.length > 0 && orgs.every((o) => isOffDoc(o.off) && o.off.all);
  const sinceMs = Math.min(...offOrgs.map((o) => o.off.sinceMs ?? Infinity));
  const agents = offOrgs.flatMap((o) =>
    o.off.all ? [] : o.off.agents.map((uid) => ({ wid: o.wid, uid })),
  );
  let label = 'Agents off';
  if (!offOrgs.some((o) => o.off.all)) {
    const first = agents[0];
    const name = agents.length === 1 && first ? agentName(first.wid, first.uid) : null;
    label = name ? `Off: ${name}` : `Off: ${agents.length} agents`;
  }
  return { off: true, all, sinceMs, agents, label };
}

/** Whether this agent is silenced by the member in that organization. */
export function agentIsOff(orgs: readonly OrgOff[], wid: string, uid: string): boolean {
  const o = orgs.find((x) => x.wid === wid)?.off;
  return isOffDoc(o) && isOffFor(o ?? null, uid);
}

/** "14:02" today, else "Oct 29, 14:02" (the member's own clock). */
export function sinceText(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * What the agents will start once On (design 9.4: shown before confirming): steps approved
 * before Off, single outcomes or plan steps at their cursor.
 */
export interface WaitingStep {
  id: string;
  threadId: string;
  type: string;
  decidedMs: number;
  planId: string | null;
}
export function willStart(
  steps: readonly WaitingStep[],
  sinceMs: number,
  atCursor: (planId: string, outcomeId: string) => boolean,
): WaitingStep[] {
  return steps.filter(
    (s) => s.decidedMs <= sinceMs && (s.planId === null || atCursor(s.planId, s.id)),
  );
}
