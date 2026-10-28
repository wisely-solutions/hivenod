/**
 * Per-item paths (card st5INNZj): what the path strip shows. Look A (compact segments) by default,
 * C (a vertical trail) when expanded; decided with João on 2026-10-27. Pure: tested in path.test.ts.
 */
import {
  isUnshaped,
  nextOnPath,
  pathPosition,
  stepsOnPath,
  type Item,
  type PathOp,
  type Project,
  type Step,
} from '@hive/shared';

export type SegmentState = 'done' | 'current' | 'ahead' | 'skipped' | 'proposed';
export type Tone = 'gate' | 'agent' | 'neutral' | 'approve';

export interface PathSegment {
  id: string;
  name: string;
  kind: Step['kind'];
  state: SegmentState;
  /** A pending people-step change on this step. */
  request?: PathOp;
  /** Why it is skipped. */
  note?: string;
  /** Trail line: "Done", "You decide", "Ana decides", "Scout is working", "Agent". */
  who: string;
  /** The person viewing decides this step. */
  mine: boolean;
}

export interface PathView {
  segments: PathSegment[];
  /** The current step (null for an item waiting to be shaped). */
  current: { name: string; kind: Step['kind']; n: number; m: number; next: string | null } | null;
  /** The status on the right of the strip ("You decide", "Scout is working", "Shaping…"). */
  status: { text: string; tone: Tone } | null;
  /** Pending changes in a word: "Spec proposed", "Skip Release asked". */
  pending: string[];
  /** Every step on the path is finished (the item is done). */
  done?: boolean;
  skippedNames: string[];
  unshaped: boolean;
}

export interface PathViewInput {
  project: Pick<Project, 'steps'>;
  item: Item;
  uid: string;
  /** Names by uid, for "Ana decides". */
  names?: Readonly<Record<string, string>>;
  /** The agent holding the item, and whether it is working right now. */
  agent?: { name: string; live: boolean } | null;
  /** Who approved each people step, by step id (latest decision): shown on its done row. */
  approvals?: Readonly<Record<string, { name: string; atMs: number }>>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "27 Oct, 14:05" in the viewer's time zone. */
export function approvedAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function decidersText(step: Step, uid: string, names: Readonly<Record<string, string>>): string {
  const ids = step.gate?.deciderUids ?? [];
  if (ids.includes(uid)) return 'You decide';
  const named = ids.map((u) => names[u]).filter(Boolean) as string[];
  if (!named.length) return 'People decide';
  if (named.length === 1) return `${named[0]} decides`;
  if (named.length === 2) return `${named[0]} or ${named[1]} decide`;
  return `${named[0]} and ${named.length - 1} others decide`;
}

export function pathView({
  project,
  item,
  uid,
  names = {},
  agent,
  approvals = {},
}: PathViewInput): PathView {
  const steps = stepsOnPath(project, item);
  const unshaped = isUnshaped(item);
  const segments: PathSegment[] = steps.map((p) => {
    const mine = p.step.kind === 'human' && !!p.step.gate?.deciderUids.includes(uid);
    let who: string;
    if (p.state === 'done') {
      const a = p.step.kind === 'human' ? approvals[p.step.id] : undefined;
      who = a ? `Approved by ${a.name} · ${approvedAt(a.atMs)}` : 'Done';
    } else if (p.state === 'skipped') who = 'Skipped';
    else if (p.state === 'proposed') who = `Proposed · ${decidersText(p.step, uid, names)}`;
    else if (p.step.kind === 'human') who = decidersText(p.step, uid, names);
    else if (p.state === 'current' && agent)
      who = agent.live ? `${agent.name} is working` : agent.name;
    else who = 'Agent';
    return {
      id: p.step.id,
      name: p.step.name,
      kind: p.step.kind,
      state: unshaped ? 'ahead' : p.state,
      ...(p.request ? { request: p.request } : {}),
      ...(p.note ? { note: p.note } : {}),
      who,
      mine,
    };
  });
  const cur = steps.find((s) => s.state === 'current') ?? null;
  const pos = pathPosition(project, item);
  const current =
    cur && !unshaped
      ? {
          name: cur.step.name,
          kind: cur.step.kind,
          n: pos.n,
          m: pos.m,
          next: nextOnPath(project as Project, item)?.name ?? null,
        }
      : null;
  let status: PathView['status'] = null;
  if (unshaped)
    status = {
      text: agent ? `${agent.name} is shaping it` : 'Shaping…',
      tone: agent ? 'agent' : 'neutral',
    };
  else if (item.status === 'done') status = { text: 'Done', tone: 'approve' };
  else if (cur?.step.kind === 'human' && item.status === 'waiting') {
    const mine = !!cur.step.gate?.deciderUids.includes(uid);
    status = { text: mine ? 'You decide' : decidersText(cur.step, uid, names), tone: 'gate' };
  } else if (cur?.step.kind === 'agent' && agent?.live)
    status = { text: `${agent.name} is working`, tone: 'agent' };
  const pending = steps
    .filter((p) => p.request)
    .map((p) => (p.request === 'add' ? `${p.step.name} proposed` : `Skip ${p.step.name} asked`));
  return {
    segments,
    current,
    status,
    pending,
    ...(item.status === 'done' && !unshaped ? { done: true } : {}),
    skippedNames: steps.filter((s) => s.state === 'skipped').map((s) => s.step.name),
    unshaped,
  };
}

/** "3 skipped: Research, Spec, Release". */
export function skippedLine(names: readonly string[]): string {
  return names.length ? `${names.length} skipped: ${names.join(', ')}` : '';
}

/** The trail rows: steps on the path (and proposed ones), skipped ones folded into one line. */
export function trailRows(view: PathView): PathSegment[] {
  return view.segments.filter((s) => s.state !== 'skipped');
}

/** The steps a person may toggle in the path editor: those after the current step. */
export function editableSteps(project: Pick<Project, 'steps'>, item: Item): Step[] {
  if (isUnshaped(item)) return [...project.steps];
  const i = project.steps.findIndex((s) => s.id === item.stepId);
  return project.steps.slice(i + 1);
}

/** "Step 2 of 4" along the item's own path (skipped steps do not count): one count for every screen. */
export function stepOfText(project: Project, item: Item): string {
  const { n, m } = pathPosition(project, item);
  return n > 0 ? `${n} of ${m}` : '';
}
