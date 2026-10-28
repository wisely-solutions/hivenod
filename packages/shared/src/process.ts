/**
 * Process editing (SPEC 9.7): the "In plain words" sentence for a gate, the people-and-groups
 * resolution, save validation and the diff written to `project.processChanged`. Pure.
 */
import { joinNames } from './gates';
import { isReservedStepId, MAX_STEPS, type Gate, type Step } from './schema';

export interface GroupRef {
  id: string;
  name: string;
  memberUids: readonly string[];
}

/** What the editor holds for a gate's "Who can decide": people chosen directly plus whole groups. */
export interface Deciders {
  people: readonly string[];
  groupIds: readonly string[];
}

/** The resolved list stored on the gate: people first, then group members, no duplicates. */
export function resolveDeciders(d: Deciders, groups: readonly GroupRef[]): string[] {
  const out = new Set<string>(d.people);
  for (const gid of d.groupIds) {
    for (const u of groups.find((g) => g.id === gid)?.memberUids ?? []) out.add(u);
  }
  return [...out];
}

/** Splits a stored gate back into people and groups. A person who is in a chosen group is a group member. */
export function splitDeciders(
  gate: Pick<Gate, 'deciderUids' | 'groupIds'>,
  groups: readonly GroupRef[],
): Deciders {
  const covered = new Set<string>();
  const groupIds = gate.groupIds.filter((gid) => groups.some((g) => g.id === gid));
  for (const gid of groupIds)
    for (const u of groups.find((g) => g.id === gid)!.memberUids) covered.add(u);
  return { groupIds, people: gate.deciderUids.filter((u) => !covered.has(u)) };
}

export function defaultGate(deciderUids: string[] = []): Gate {
  return {
    deciderUids,
    groupIds: [],
    rule: 'any',
    n: 1,
    mustInclude: [],
    rejectPolicy: 'one',
    remindAfterHours: 24,
  };
}

/**
 * The live "In plain words" sentence for a gate's settings (screen 7). Names are looked up by uid;
 * `groups` names the chosen groups. The wording is the design copy: tests pin it.
 */
export function plainWords(
  gate: Gate,
  names: Readonly<Record<string, string>>,
  groups: readonly GroupRef[] = [],
): string {
  const p = plainParts(gate, names, groups);
  return [p.first, p.reject].filter(Boolean).join(' ') + p.remind;
}

interface PlainParts {
  first: string;
  reject: string;
  remind: string;
}

function plainParts(
  gate: Gate,
  names: Readonly<Record<string, string>>,
  groups: readonly GroupRef[],
): PlainParts {
  const name = (u: string) => names[u] ?? 'Someone';
  const total = new Set(gate.deciderUids).size;
  if (total === 0)
    return {
      first: 'Nobody is chosen yet. Add at least one person or group.',
      reject: '',
      remind: '',
    };

  const chosen = groups.filter((g) => gate.groupIds.includes(g.id));
  const inGroup = new Set(chosen.flatMap((g) => g.memberUids));
  const direct = gate.deciderUids.filter((u) => !inGroup.has(u));
  const single = total === 1;
  // One decider is always named as a person, even when they come in through a group.
  const who = single
    ? name(gate.deciderUids[0]!)
    : joinNames([...chosen.map((g) => g.name), ...direct.map(name)]);
  const people = `${total} ${single ? 'person' : 'people'}`;
  const sources = chosen.length + direct.length;

  let first: string;
  switch (gate.rule) {
    case 'any':
      first = single ? `${who} decides.` : `Any one of ${who} can approve.`;
      break;
    case 'atLeast':
      if (gate.n > total)
        first = `It needs ${gate.n} approvals but only ${people} can decide. Add people or lower the number.`;
      else if (single) first = `${who} must approve.`;
      else if (gate.n <= 1) first = `Any one of ${who} can approve.`;
      else
        first = `At least ${gate.n} of ${who}${sources === 1 ? ` (${people})` : ''} must approve.`;
      break;
    case 'all':
      first = single ? `${who} must approve.` : `Everyone in ${who} must approve.`;
      break;
    case 'specific':
      first = single
        ? `${who} must approve.`
        : `${joinNames(gate.deciderUids.map(name))} must each approve.`;
      break;
  }

  const must = gate.mustInclude.filter((u) => gate.deciderUids.includes(u)).map(name);
  if (must.length && (gate.rule === 'any' || gate.rule === 'atLeast') && !single) {
    first = first.replace(
      /\.$/,
      must.length === 1
        ? `, and ${must[0]} must be one of them.`
        : `, and ${joinNames(must)} must all be among them.`,
    );
  }

  const reject =
    gate.rejectPolicy === 'one'
      ? 'One rejection sends it back.'
      : single
        ? 'It goes back only if most reject, which here means that one person.'
        : 'It goes back only if most of them reject.';
  const remind =
    gate.remindAfterHours > 0
      ? ` If nobody decides in ${gate.remindAfterHours} ${gate.remindAfterHours === 1 ? 'hour' : 'hours'}, a reminder badge shows.`
      : '';
  return { first, reject, remind };
}

/** A short line for the decision-points list: who approves and what a rejection does (no reminder). */
export function plainSummary(
  gate: Gate,
  names: Readonly<Record<string, string>>,
  groups: readonly GroupRef[] = [],
): string {
  const p = plainParts(gate, names, groups);
  return p.reject ? `${p.first} ${p.reject}` : p.first;
}

// ---------- validation ----------

export interface ProcessIssue {
  stepId: string;
  message: string;
}

export function validateProcess(steps: readonly Step[]): ProcessIssue[] {
  const issues: ProcessIssue[] = [];
  if (steps.length === 0)
    issues.push({ stepId: '', message: 'A process needs at least one step.' });
  if (steps.length > MAX_STEPS)
    issues.push({ stepId: '', message: `A process can have at most ${MAX_STEPS} steps.` });
  for (const s of steps) {
    if (isReservedStepId(s.id))
      issues.push({ stepId: s.id, message: `"${s.id}" is a reserved step id.` });
    if (s.name.trim().length === 0)
      issues.push({ stepId: s.id, message: 'Give this step a name.' });
    if (s.kind === 'human') {
      const g = s.gate;
      if (!g || g.deciderUids.length === 0)
        issues.push({ stepId: s.id, message: `${s.name || 'This gate'} needs someone to decide.` });
      else if (g.rule === 'atLeast' && g.n > g.deciderUids.length)
        issues.push({
          stepId: s.id,
          message: `${s.name || 'This gate'} needs more approvals than it has deciders.`,
        });
    }
  }
  return issues;
}

/** Items that sit on a step the process no longer has. */
export function orphanedSteps(before: readonly Step[], after: readonly Step[]): string[] {
  const keep = new Set(after.map((s) => s.id));
  return before.filter((s) => !keep.has(s.id)).map((s) => s.id);
}

// ---------- diff ----------

export interface ProcessDiff {
  added: string[];
  removed: string[];
  reordered: boolean;
  /** Per changed step: the fields that changed, e.g. { approve: ['name', 'gate'] }. */
  changed: Record<string, string[]>;
}

const FIELDS = ['name', 'kind', 'description', 'instructions', 'outputs', 'gate'] as const;

export function diffProcess(before: readonly Step[], after: readonly Step[]): ProcessDiff {
  const b = new Map(before.map((s) => [s.id, s]));
  const a = new Map(after.map((s) => [s.id, s]));
  const added = after.filter((s) => !b.has(s.id)).map((s) => s.id);
  const removed = before.filter((s) => !a.has(s.id)).map((s) => s.id);
  const kept = (xs: readonly Step[]) =>
    xs.filter((s) => a.has(s.id) && b.has(s.id)).map((s) => s.id);
  const reordered = kept(before).join() !== kept(after).join();
  const changed: Record<string, string[]> = {};
  for (const s of after) {
    const old = b.get(s.id);
    if (!old) continue;
    const fields = FIELDS.filter(
      (f) => JSON.stringify(old[f] ?? null) !== JSON.stringify(s[f] ?? null),
    );
    if (fields.length) changed[s.id] = [...fields];
  }
  return { added, removed, reordered, changed };
}

export function isEmptyDiff(d: ProcessDiff): boolean {
  return (
    !d.added.length && !d.removed.length && !d.reordered && Object.keys(d.changed).length === 0
  );
}

/**
 * Steps an open item may be moved to when `removedId` is deleted. Mirrors firestore.rules: an
 * earlier step (it re-does work, never skips a decision), or the next one when the removed step
 * is an agent step. Only steps that survive the save are offered.
 */
export function moveTargets(
  before: readonly Step[],
  removedId: string,
  after: readonly Step[],
): Step[] {
  const oi = before.findIndex((s) => s.id === removedId);
  if (oi < 0) return [];
  const keep = new Map(after.map((s) => [s.id, s]));
  return before
    .filter(
      (s, ti) => keep.has(s.id) && (ti < oi || (ti === oi + 1 && before[oi]!.kind === 'agent')),
    )
    .map((s) => keep.get(s.id)!);
}
