/**
 * Per-item paths (card st5INNZj), pure. The project's process is its step library; an item's
 * path is the library minus the steps it skips (`pathSkips`), so it always keeps library order.
 * An item without skips (made before paths) goes through the full library. `shape: null` marks
 * a new item that is waiting to be shaped: nobody works on it or decides it until it is.
 */
import type { Item, PathOp, Step } from './schema';

/**
 * Own-property lookup for maps keyed by step id. Plain objects inherit `constructor`, `toString`,
 * `__proto__` and friends, so `id in map` and `map[id]` would find them for such step ids. The
 * Go port (cli/internal) does not have this problem and the two must stay identical.
 */
export function ownGet<T>(
  map: Readonly<Record<string, T>> | null | undefined,
  key: string,
): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}
export function hasOwnKey(map: object | null | undefined, key: string): boolean {
  return !!map && Object.hasOwn(map, key);
}

type Lib = { steps: readonly Step[] };
export type PathItem = Partial<
  Pick<
    Item,
    'stepId' | 'status' | 'shape' | 'pathSkips' | 'gateSkips' | 'pathRequests' | 'pathRefused'
  >
>;

/**
 * Whether new items of this project wait to be shaped. Projects made before paths have no
 * setting: they follow SHAPE_BY_DEFAULT (off, so they keep working as before until someone
 * switches it on). New projects store true. Flip the constant to make shaping the global default.
 */
export const SHAPE_BY_DEFAULT = false;
export function shapesNewItems(project: { shapeNewItems?: boolean }): boolean {
  return project.shapeNewItems ?? SHAPE_BY_DEFAULT;
}

export function isUnshaped(item: Pick<PathItem, 'shape'>): boolean {
  return item.shape === null;
}
/** Shaped by an agent or a person (legacy items are neither shaped nor unshaped). */
export function isShaped(item: Pick<PathItem, 'shape'>): boolean {
  return !!item.shape;
}

/**
 * Whether the item skips `step`: an agent step by its pathSkips, a people step only by its
 * gateSkips (what a decider approved). Mirrors the rules.
 */
export function skips(item: PathItem, step: Pick<Step, 'id' | 'kind'>): boolean {
  const map = step.kind === 'agent' ? item.pathSkips : item.gateSkips;
  return hasOwnKey(map, step.id);
}
/** Why the item skips `step` ('' when no reason was given). */
export function skipReason(item: PathItem, step: Pick<Step, 'id' | 'kind'>): string {
  return ownGet(step.kind === 'agent' ? item.pathSkips : item.gateSkips, step.id) ?? '';
}

/** The step ids on the item's path, in library order. */
export function pathOf(project: Lib, item: PathItem): string[] {
  return project.steps.filter((s) => !skips(item, s)).map((s) => s.id);
}

/** `ids` in library order, without duplicates and without ids the library does not have. */
export function libraryOrder(project: Lib, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  return project.steps.filter((s) => want.has(s.id)).map((s) => s.id);
}

export type PathStepState = 'done' | 'current' | 'ahead' | 'skipped' | 'proposed';
export interface PathStep {
  step: Step;
  state: PathStepState;
  /** A pending people-step change for this step. */
  request?: PathOp;
  /** Why it is skipped. */
  note?: string;
}

/**
 * Every library step with what it is for this item. A skipped step with a pending add shows as
 * 'proposed'. Steps before the current one that are on the path are done.
 */
export function stepsOnPath(project: Lib, item: PathItem): PathStep[] {
  const cur = project.steps.findIndex((s) => s.id === item.stepId);
  const finished = item.status === 'done';
  return project.steps.map((step, i) => {
    const request = ownGet(item.pathRequests, step.id)?.op;
    let state: PathStepState;
    const skipped = skips(item, step);
    if (skipped) state = request === 'add' ? 'proposed' : 'skipped';
    else if (i < cur || (finished && i === cur)) state = 'done';
    else if (i === cur) state = 'current';
    else state = 'ahead';
    return {
      step,
      state,
      ...(request ? { request } : {}),
      ...(skipped && skipReason(item, step) ? { note: skipReason(item, step) } : {}),
    };
  });
}

/** "Step n of m" along the path; a proposed people step does not count until it is added. */
export function pathPosition(project: Lib, item: PathItem): { n: number; m: number } {
  const path = pathOf(project, item);
  return { n: path.indexOf(item.stepId ?? '') + 1, m: path.length };
}

/** The next step on the item's path after `stepId` (default: its current step), or null. */
export function nextOnPath(project: Lib, item: PathItem, stepId = item.stepId): Step | null {
  const i = project.steps.findIndex((s) => s.id === stepId);
  return project.steps.slice(i + 1).find((s) => !skips(item, s)) ?? null;
}

/** The first step on the path (where a newly shaped item arrives). */
export function firstOnPath(project: Lib, item: PathItem): Step | null {
  return project.steps.find((s) => !skips(item, s)) ?? null;
}

/** What a path change does, split by kind: agents may only make the agent-step part. */
export function pathChangeKind(
  project: Lib,
  before: readonly string[],
  after: readonly string[],
): { agentAdded: string[]; agentDropped: string[]; gateAdded: string[]; gateDropped: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  const out = {
    agentAdded: [] as string[],
    agentDropped: [] as string[],
    gateAdded: [] as string[],
    gateDropped: [] as string[],
  };
  for (const s of project.steps) {
    const human = s.kind === 'human';
    if (a.has(s.id) && !b.has(s.id)) (human ? out.gateAdded : out.agentAdded).push(s.id);
    if (b.has(s.id) && !a.has(s.id)) (human ? out.gateDropped : out.agentDropped).push(s.id);
  }
  return out;
}
