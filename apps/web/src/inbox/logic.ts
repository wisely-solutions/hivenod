import {
  canEditAgentSettings,
  canTriage,
  isSuggestion,
  MAX_AGENT_SEND_BACKS,
  type Gate,
  type Item,
  type Message,
  type Project,
  type StepProposal,
} from '@hive/shared';
import type { Row } from '../lib/live';
import { needsMyDecision } from '../shell/logic';

/**
 * `path`: a pending change of a people step on an item's path, for that step's deciders;
 * `proposal`: a new library step an agent proposed, for approvers (card st5INNZj). Both are
 * decisions, so the Approvals filter shows them.
 */
export type InboxKind = 'approval' | 'question' | 'finding' | 'path' | 'proposal';
export type InboxFilter = 'all' | 'approvals' | 'questions' | 'findings';

export interface InboxEntry {
  /**
   * Unique and stable: `a:<pid>:<iid>`, `q:<pid>:<iid>:<mid>`, `f:<pid>:<iid>`,
   * `p:<pid>:<iid>:<stepId>` (path) or `s:<pid>:<proposalId>` (proposal).
   */
  key: string;
  kind: InboxKind;
  /** The organization it belongs to, when the list spans several (needs/logic.ts). */
  wid?: string;
  pid: string;
  itemId: string;
  project: Project;
  item: Item;
  /** Since when it has been waiting (ms). */
  since: number;
  question?: Row<Message>;
  /** For `path`: the people step whose change is pending. */
  stepId?: string;
  /** For `proposal`. */
  proposal?: Row<StepProposal>;
}

export interface Inbox {
  /** Waiting for this person, oldest first. */
  todo: InboxEntry[];
  /** Waiting for others after this person decided. */
  waiting: InboxEntry[];
}

export interface InboxInput {
  projects: Row<Project>[];
  items: Record<string, Row<Item>[]>;
  /** Agent suggestions (untriaged findings) by project. */
  suggestions?: Record<string, Row<Item>[]>;
  questions: Record<string, Row<Message>[]>;
  /** Open step proposals by project (only loaded where this person may decide them). */
  proposals?: Record<string, Row<StepProposal>[]>;
  uid: string;
  /** Organization admin: may triage suggestions in every project. */
  isAdmin?: boolean;
  /** Stamped on every entry, so a list across organizations knows where each one belongs. */
  wid?: string;
}

const ms = (t: { toMillis: () => number }) => t.toMillis();

/** True when the finding still needs a human to triage it (it is a suggestion). */
export const isOpenFinding = (item: Item): boolean => isSuggestion(item);

export function buildInbox({
  projects,
  items,
  suggestions = {},
  questions,
  proposals = {},
  uid,
  isAdmin = false,
  wid,
}: InboxInput): Inbox {
  const todo: InboxEntry[] = [];
  const waiting: InboxEntry[] = [];
  for (const p of projects) {
    if (p.data.archivedAt) continue;
    const rows = items[p.id] ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      const base = {
        pid: p.id,
        itemId: r.id,
        project: p.data,
        item: r.data,
        since: ms(r.data.updatedAt),
      };
      if (isSuggestion(r.data)) continue;
      // Pending people-step changes on the path, for that step's deciders.
      if (['queued', 'working', 'waiting'].includes(r.data.status)) {
        for (const [stepId, req] of Object.entries(r.data.pathRequests ?? {})) {
          const step = p.data.steps.find((s) => s.id === stepId);
          if (step?.kind !== 'human' || !step.gate?.deciderUids.includes(uid)) continue;
          // Only changes that can still apply: a step ahead, or skipping the gate it waits at.
          const at = p.data.steps.findIndex((s) => s.id === r.data.stepId);
          const here = stepId === r.data.stepId && req.op === 'drop' && r.data.status === 'waiting';
          if (!here && p.data.steps.indexOf(step) <= at) continue;
          todo.push({
            ...base,
            key: `p:${p.id}:${r.id}:${stepId}`,
            kind: 'path',
            stepId,
            since: req.at?.toMillis?.() ?? base.since,
          });
        }
      }
      if (needsMyDecision(p.data, r.data, uid)) {
        todo.push({ ...base, key: `a:${p.id}:${r.id}`, kind: 'approval' });
      } else if (r.data.status === 'waiting' && r.data.gate) {
        const step = p.data.steps.find((s) => s.id === r.data.stepId);
        const mine = step?.gate?.deciderUids.includes(uid);
        if (mine && (uid in r.data.gate.approvals || uid in r.data.gate.rejections)) {
          waiting.push({ ...base, key: `a:${p.id}:${r.id}`, kind: 'approval' });
        }
      }
    }
    // Suggestions wait on the people who may triage them (canTriage), nobody else.
    if (canTriage(p.data, uid, isAdmin)) {
      for (const r of suggestions[p.id] ?? []) {
        todo.push({
          key: `f:${p.id}:${r.id}`,
          kind: 'finding',
          pid: p.id,
          itemId: r.id,
          project: p.data,
          item: r.data,
          since: ms(r.data.updatedAt),
        });
      }
    }
    if (canEditAgentSettings({ uid, isAdmin }, p.data)) {
      for (const sp of proposals[p.id] ?? []) {
        const item = byId.get(sp.data.itemId);
        if (sp.data.status !== 'open' || !item) continue;
        todo.push({
          key: `s:${p.id}:${sp.id}`,
          kind: 'proposal',
          pid: p.id,
          itemId: item.id,
          project: p.data,
          item: item.data,
          since: ms(sp.data.at),
          proposal: sp,
        });
      }
    }
    for (const q of questions[p.id] ?? []) {
      const item = byId.get(q.data.itemId);
      if (!item || q.data.kind !== 'question' || q.data.answered) continue;
      todo.push({
        key: `q:${p.id}:${item.id}:${q.id}`,
        kind: 'question',
        pid: p.id,
        itemId: item.id,
        project: p.data,
        item: item.data,
        since: ms(q.data.at),
        question: q,
      });
    }
  }
  const oldest = (a: InboxEntry, b: InboxEntry) => a.since - b.since;
  if (wid) for (const e of [...todo, ...waiting]) e.wid = wid;
  return { todo: todo.sort(oldest), waiting: waiting.sort(oldest) };
}

const FILTER_KIND: Record<Exclude<InboxFilter, 'all'>, InboxKind> = {
  approvals: 'approval',
  questions: 'question',
  findings: 'finding',
};

/** Path changes and step proposals are decisions too: they count as approvals. */
const filterKind = (k: InboxKind): InboxKind => (k === 'path' || k === 'proposal' ? 'approval' : k);

export function filterEntries(entries: InboxEntry[], filter: InboxFilter): InboxEntry[] {
  return filter === 'all'
    ? entries
    : entries.filter((e) => filterKind(e.kind) === FILTER_KIND[filter]);
}

export function countByFilter(entries: InboxEntry[]): Record<InboxFilter, number> {
  const n = { all: entries.length, approvals: 0, questions: 0, findings: 0 };
  for (const e of entries) {
    if (filterKind(e.kind) === 'approval') n.approvals += 1;
    else if (e.kind === 'question') n.questions += 1;
    else n.findings += 1;
  }
  return n;
}

export function parseFilter(v: unknown): InboxFilter {
  return v === 'approvals' || v === 'questions' || v === 'findings' ? v : 'all';
}

/**
 * The rule of a gate in the words every decision surface uses ("Any one of 2 deciders"), shown on
 * the decision bar and in the viewer (card 9bmMIGlC). Empty when the step has no gate.
 */
export function gateRuleLine(gate: Pick<Gate, 'rule' | 'n' | 'deciderUids'> | undefined): string {
  if (!gate) return '';
  const total = new Set(gate.deciderUids).size;
  const who = total === 1 ? '1 decider' : `${total} deciders`;
  if (total <= 1) return 'One decider';
  if (gate.rule === 'any') return `Any one of ${who}`;
  if (gate.rule === 'atLeast') return `${gate.n} of ${who}`;
  return `All ${who}`;
}

/** How many approvals the gate needs in total. */
export function approvalsNeeded(project: Project, item: Item): number {
  const gate = project.steps.find((s) => s.id === item.stepId)?.gate;
  if (!gate) return 0;
  if (gate.rule === 'any') return 1;
  if (gate.rule === 'atLeast') return gate.n;
  return gate.deciderUids.length;
}

/** "1 of 2 approved · Ana ✓ · you" (the last part only while this person has yet to decide). */
export function approvalLine(
  project: Project,
  item: Item,
  uid: string,
  names: Readonly<Record<string, string>>,
): string {
  const gate = project.steps.find((s) => s.id === item.stepId)?.gate;
  if (!gate || !item.gate) return '';
  const approved = Object.keys(item.gate.approvals).filter((u) => gate.deciderUids.includes(u));
  const parts = [`${approved.length} of ${approvalsNeeded(project, item)} approved`];
  for (const u of approved) parts.push(u === uid ? 'You ✓' : `${names[u] ?? 'Someone'} ✓`);
  if (needsMyDecision(project, item, uid)) parts.push('you');
  return parts.join(' · ');
}

/** "3 h", "2 d", "5 min": how long something has waited, short. */
export function waitLabel(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** After the entry at `key` leaves the list, which key takes focus: the one below, else above. */
export function nextKey(list: readonly { key: string }[], key: string): string | null {
  const i = list.findIndex((e) => e.key === key);
  if (i < 0) return list[0]?.key ?? null;
  return (list[i + 1] ?? list[i - 1])?.key ?? null;
}

export const SWIPE_THRESHOLD = 96;
export type SwipeAction = 'approve' | 'iterate' | null;
export function swipeAction(offsetX: number): SwipeAction {
  if (offsetX >= SWIPE_THRESHOLD) return 'approve';
  if (offsetX <= -SWIPE_THRESHOLD) return 'iterate';
  return null;
}

/**
 * A question an agent asked because agents already sent the item back the most times allowed
 * (card KLCTVnX8): the item is held at its step until a person answers.
 */
export function isStuckHold(entry: Pick<InboxEntry, 'kind' | 'item' | 'question'>): boolean {
  return (
    entry.kind === 'question' &&
    !!entry.question &&
    (entry.item.agentSendBacks ?? 0) >= MAX_AGENT_SEND_BACKS &&
    entry.item.awaitingAnswer?.questionId === entry.question.id
  );
}

export type QuestionBlock = { kind: 'text'; text: string } | { kind: 'list'; items: string[] };

/**
 * A question's text as blocks: runs of numbered lines ("1. …") become a list, the rest stays text
 * (card pqqOWE3s: the stuck hold's reasons are numbered lines, not one run-on paragraph).
 */
export function questionBlocks(text: string): QuestionBlock[] {
  const out: QuestionBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    const t = para.join('\n').trim();
    if (t) out.push({ kind: 'text', text: t });
    para = [];
  };
  for (const line of text.split('\n')) {
    const m = /^\s*\d+[.)]\s+(.*\S)\s*$/.exec(line);
    if (m) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === 'list') last.items.push(m[1]!);
      else out.push({ kind: 'list', items: [m[1]!] });
    } else para.push(line);
  }
  flush();
  return out;
}
