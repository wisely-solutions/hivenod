/**
 * Gate evaluation (SPEC §5.1). Pure and dependency-free.
 * This mirrors `gateSatisfied` / `rejectionsSuffice` in firestore.rules exactly:
 * the rules are the enforcement, this is what the UI and CLI use to explain and predict.
 */
import type { Gate, Step } from './schema';

/** A map keyed by uid (as stored on items) or a plain list of uids. */
export type Votes = Readonly<Record<string, unknown>> | readonly string[];

export interface GateEvaluation {
  /** The approvals satisfy the step's rule: the item may move to the next step. */
  canAdvance: boolean;
  /** The rejections satisfy the reject policy: the item may be sent back or stopped. */
  canSendBack: boolean;
  /** People who still have to approve (everyone left for all/specific, plus mustInclude). */
  missing: string[];
  /** How many more approvals are needed at minimum. */
  remaining: number;
  /** The rule can never be satisfied with the current deciders. */
  impossible: boolean;
  /** One short sentence for the UI. */
  plainWords: string;
}

const NO_GATE: GateEvaluation = {
  canAdvance: false,
  canSendBack: false,
  missing: [],
  remaining: 0,
  impossible: true,
  plainWords: 'This step has no decision.',
};

function uidsOf(votes: Votes): string[] {
  return Array.isArray(votes) ? [...votes] : Object.keys(votes);
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Same check as the rules: do these approvals satisfy the gate? Only deciders count. */
export function gateSatisfied(gate: Gate, approvals: Votes): boolean {
  const deciders = new Set(gate.deciderUids);
  const valid = new Set(uidsOf(approvals).filter((u) => deciders.has(u)));
  if (!gate.mustInclude.every((u) => valid.has(u))) return false;
  switch (gate.rule) {
    case 'any':
      return valid.size >= 1;
    case 'atLeast':
      return valid.size >= gate.n;
    case 'all':
    case 'specific':
      return deciders.size > 0 && gate.deciderUids.every((u) => valid.has(u));
  }
}

/** Same check as the rules: do these rejections allow a send back / stop? */
export function rejectionsSuffice(gate: Gate, rejections: Votes): boolean {
  const deciders = new Set(gate.deciderUids);
  const valid = uidsOf(rejections).filter((u) => deciders.has(u)).length;
  return gate.rejectPolicy === 'one' ? valid >= 1 : valid * 2 > deciders.size;
}

export function evaluateGate(
  step: Pick<Step, 'kind' | 'gate'>,
  approvals: Votes,
  rejections: Votes,
  names: Readonly<Record<string, string>> = {},
): GateEvaluation {
  const gate = step.gate;
  if (step.kind !== 'human' || !gate) return { ...NO_GATE };

  const name = (u: string) => names[u] ?? u;
  const deciders = new Set(gate.deciderUids);
  const approved = new Set(uidsOf(approvals).filter((u) => deciders.has(u)));
  const rejectedCount = new Set(uidsOf(rejections).filter((u) => deciders.has(u))).size;

  const impossible =
    deciders.size === 0 ||
    gate.mustInclude.some((u) => !deciders.has(u)) ||
    (gate.rule === 'atLeast' && gate.n > deciders.size);

  const everyone = gate.rule === 'all' || gate.rule === 'specific';
  const required = everyone ? [...deciders] : gate.mustInclude;
  const missing = [...new Set(required)].filter((u) => !approved.has(u));
  const target = everyone ? deciders.size : gate.rule === 'atLeast' ? gate.n : 1;
  const remaining = Math.max(target - approved.size, missing.length, 0);

  const canAdvance = gateSatisfied(gate, approvals);
  const canSendBack = rejectionsSuffice(gate, rejections);

  let plainWords: string;
  if (impossible) {
    plainWords = 'Nobody can approve this yet. Check who decides.';
  } else if (canAdvance) {
    plainWords = 'Approved. Ready to move on.';
  } else if (canSendBack) {
    plainWords =
      gate.rejectPolicy === 'one'
        ? 'Rejected. It can be sent back.'
        : 'Most deciders rejected. It can be sent back.';
  } else {
    const noun = remaining === 1 ? 'approval' : 'approvals';
    const who = missing.length
      ? everyone
        ? ` from ${joinNames(missing.map(name))}`
        : `, including ${joinNames(missing.map(name))}`
      : '';
    plainWords = `Needs ${remaining} more ${noun}${who}.`;
    if (gate.rejectPolicy === 'majority' && rejectedCount > 0) {
      plainWords += ` ${rejectedCount} of ${deciders.size} rejected; more than half must reject to send it back.`;
    }
  }

  return { canAdvance, canSendBack, missing, remaining, impossible, plainWords };
}
