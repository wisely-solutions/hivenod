/**
 * The decision page's view logic (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 3 and 4.3): the top
 * card's state and kicker, the summary's freshness line (and why it is out of date), the safe
 * reading of a summary (one bad visual never hides the rest), the version diff and the fold hints.
 * Pure: no React, no Firestore.
 */
import {
  cliSupports,
  inboxSummarySchema,
  isThreadAttachmentOf,
  minVersionFor,
  summaryFreshness,
  SUMMARY_LIMITS,
  THREAD_IMAGE_RE,
  visualSchema,
  type InboxAttachment,
  type InboxThread,
  type PlanView,
  type Visual,
} from '@hive/shared';
import { z } from 'zod';
import type { Row } from '../lib/live';
import type { ThreadImages } from '../ui/visuals/ImageVisuals';
import { timeAgo } from '../agents/logic';
import { dayLabel, hhmm } from '../today/logic';
import { lineDiff } from '../ui/visuals/scale';
import type { PlanMain } from './plan';
import { STATE_CHIP, waitingText } from './logic';

// ---------- reading a summary ----------

/** A visual as the page shows it: drawn by the kit, or a quiet "not shown" note with its kind. */
export type ShownVisual = { ok: true; visual: Visual } | { ok: false; kind: string };

export function parseVisual(v: unknown): ShownVisual {
  const r = visualSchema.safeParse(v);
  if (r.success) return { ok: true, visual: r.data };
  const kind =
    typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string'
      ? (v as { kind: string }).kind.slice(0, 24)
      : 'unknown';
  return { ok: false, kind };
}

/**
 * The summary doc as the page reads it: every field through the shared schema, except that each
 * visual is checked on its own (an unknown kind from a newer agent shows as "not shown").
 */
export const looseSummarySchema = inboxSummarySchema.extend({
  visuals: z
    .array(z.unknown())
    .max(SUMMARY_LIMITS.visuals)
    .transform((l) => l.map(parseVisual)),
});
export type ShownSummary = z.infer<typeof looseSummarySchema>;

/**
 * The thread's images a visual may show (slice 4): image attachments of this thread (by id and
 * by field) whose content is a PNG, JPEG or WebP data URL. Never SVG, HTML or a URL.
 */
export function threadImages(rows: readonly Row<InboxAttachment>[], tid: string): ThreadImages {
  const out = new Map<string, { name: string; src: string }>();
  for (const r of rows) {
    const a = r.data;
    if (
      a.kind === 'image' &&
      a.threadId === tid &&
      isThreadAttachmentOf(r.id, tid) &&
      typeof a.content === 'string' &&
      THREAD_IMAGE_RE.test(a.content)
    )
      out.set(r.id, { name: a.name, src: a.content });
  }
  return out;
}

/** Only https links are followed (a ref's url, a bullet's ref). */
export function safeHttps(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ---------- the top card's state ----------

export type TopKind = 'person' | 'question' | 'working' | 'blocked' | 'waiting' | 'done' | 'idle';
export type TopTone = 'gate' | 'agent' | 'sendback' | 'neutral' | 'approve';
export interface TopState {
  kind: TopKind;
  tone: TopTone;
  kicker: string;
}

export interface TopInput {
  thread: {
    state: InboxThread['state'];
    question: { text: string; answer: string | null } | null;
    waiting: InboxThread['waiting'];
    updatedAt: number;
  };
  /** The thread's plan on show (the live one, else the latest), with its main action. */
  plan: {
    view: PlanView;
    main: PlanMain;
    /** The waiting gate's short label ("Ship it?"), if any. */
    label: string | null;
    /** The failed step's error line, if any. */
    error: string | null;
  } | null;
  /** Open single proposals (not plan steps). */
  proposals: number;
  agent: string;
}

const clip = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** Which of the six states the top card is in (design 3.2), and its kicker line. */
export function topState(i: TopInput): TopState {
  const { thread: t, plan, agent } = i;
  const v = plan?.view;
  if (v && (v.state === 'blocked' || plan.main?.kind === 'retry')) {
    const n =
      plan.main?.kind === 'retry' ? plan.main.index + 1 : (v.current?.number ?? v.cursor + 1);
    return {
      kind: 'blocked',
      tone: 'sendback',
      kicker: `Blocked at step ${n}${plan.error ? `: ${clip(plan.error, 90)}` : ''}`,
    };
  }
  if (t.state === 'needsYou' && t.question && !t.question.answer)
    return { kind: 'question', tone: 'gate', kicker: `${agent} asks` };
  if (v && plan.main?.kind === 'approvePlan')
    return {
      kind: 'person',
      tone: 'gate',
      kicker: `Your approval · plan of ${v.total} ${v.total === 1 ? 'step' : 'steps'}`,
    };
  if (v && plan.main?.kind === 'step') {
    const label = plan.main.gate && plan.label ? ` · ${clip(plan.label, 40)}` : '';
    return {
      kind: 'person',
      tone: 'gate',
      kicker: `Your approval · step ${plan.main.index + 1} of ${v.total}${label}`,
    };
  }
  if (i.proposals > 0)
    return {
      kind: 'person',
      tone: 'gate',
      kicker: i.proposals > 1 ? `Your approval · ${i.proposals} proposals` : 'Your approval',
    };
  const running =
    v &&
    v.current &&
    v.current.kind === 'agent' &&
    (v.current.ui === 'running' || v.current.ui === 'approved');
  if (running)
    return {
      kind: 'working',
      tone: 'agent',
      kicker: `${agent} is working · step ${v.current!.number} of ${v.total}`,
    };
  if (t.state === 'investigating')
    return { kind: 'working', tone: 'agent', kicker: `${agent} is working on it` };
  if (t.state === 'waiting')
    return { kind: 'waiting', tone: 'neutral', kicker: waitingText(t.waiting) };
  if (t.state === 'ignored') return { kind: 'done', tone: 'neutral', kicker: 'Ignored' };
  if (v?.state === 'done' || t.state === 'done')
    return { kind: 'done', tone: 'approve', kicker: `Done · ${dayMonth(t.updatedAt)}` };
  return { kind: 'idle', tone: STATE_CHIP[t.state].tone, kicker: STATE_CHIP[t.state].label };
}

// ---------- freshness ----------

export interface FreshnessInput {
  summary: { version: number; at: number } | null;
  /** The thread's last change. */
  updatedAt: number;
  now: number;
  agent: { name: string; online: boolean; lastSeen: number | null; cliVersion: string | null };
}
export interface Freshness {
  kind: 'none' | 'fresh' | 'stale';
  /** "updated 3 min ago" (null without a summary). */
  updated: string | null;
  version: string | null;
  /** "May be out of date: changed since 14:02" (stale only). */
  stale: string | null;
  /** Why no new summary comes (agent offline, CLI too old), when not fresh. */
  why: string | null;
}

/** "14:02" today, else "Tue 27 Oct, 09:05". */
export function sinceText(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  return d.toDateString() === n.toDateString() ? hhmm(d) : `${dayLabel(d)}, ${hhmm(d)}`;
}

/** The summary's freshness line (design 4.3). */
export function freshness(i: FreshnessInput): Freshness {
  const ms = (v: number) => ({ toMillis: () => v });
  const kind = summaryFreshness({
    updatedAt: ms(i.updatedAt),
    summary: i.summary ? { at: ms(i.summary.at) } : null,
  });
  let why: string | null = null;
  if (kind !== 'fresh') {
    const a = i.agent;
    if (cliSupports('summary', a.cliVersion) === 'old')
      why = `${a.name}'s CLI ${a.cliVersion} can't write summaries: update to ${minVersionFor('summary')} or later`;
    else if (!a.online)
      why = a.lastSeen
        ? `${a.name} is offline since ${sinceText(a.lastSeen, i.now)}`
        : `${a.name} has not been online yet`;
  }
  return {
    kind,
    updated: i.summary ? `updated ${timeAgo(new Date(i.summary.at), i.now)}` : null,
    version: i.summary ? `v${i.summary.version}` : null,
    stale:
      kind === 'stale'
        ? `May be out of date: changed since ${sinceText(i.updatedAt, i.now)}`
        : null,
    why,
  };
}

// ---------- versions, folds ----------

/** An older version's bullets against the current ones: same, removed (old only), added. */
export function bulletDiff(older: readonly string[], current: readonly string[]) {
  const d = lineDiff(older, current);
  const out: Array<{ text: string; change: 'same' | 'removed' | 'added' }> = [];
  let j = 0;
  for (const b of d.before) {
    if (b.changed) {
      out.push({ text: b.text, change: 'removed' });
      continue;
    }
    while (j < d.after.length && d.after[j]!.changed)
      out.push({ text: d.after[j++]!.text, change: 'added' });
    out.push({ text: b.text, change: 'same' });
    j++;
  }
  while (j < d.after.length) {
    const a = d.after[j++]!;
    if (a.changed) out.push({ text: a.text, change: 'added' });
  }
  return out;
}

/** The phone's Plan fold: "3 done · you · 2 next" (each part as a pill with its tone). */
export function planFoldParts(v: PlanView): Array<{ text: string; tone: TopTone }> {
  const parts: Array<{ text: string; tone: TopTone }> = [];
  if (v.through) parts.push({ text: `${v.through} done`, tone: 'approve' });
  const c = v.current;
  if (v.state === 'blocked') parts.push({ text: 'blocked', tone: 'sendback' });
  else if (v.waitingForYou) parts.push({ text: 'you', tone: 'gate' });
  else if (c && (c.ui === 'running' || c.ui === 'approved'))
    parts.push({ text: 'running', tone: 'agent' });
  const next = c
    ? v.steps.filter((s) => s.index > c.index && s.ui !== 'done' && s.ui !== 'skipped').length
    : 0;
  if (next) parts.push({ text: `${next} next`, tone: 'agent' });
  if (!parts.length) parts.push({ text: v.progress, tone: 'neutral' });
  return parts;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything's fold label: "23 messages · 2 notes · 3 links · log". */
export function everythingHint(c: {
  messages: number;
  notes: number;
  outcomes: number;
  links: number;
  /** Files the agent attached to the thread (slice 4). */
  files?: number;
}) {
  const parts = [count(c.messages, 'message')];
  if (c.notes) parts.push(count(c.notes, 'note'));
  if (c.files) parts.push(count(c.files, 'file'));
  if (c.outcomes) parts.push(count(c.outcomes, 'outcome'));
  if (c.links) parts.push(count(c.links, 'link'));
  parts.push('log');
  return parts.join(' · ');
}

/** A text's start, cut at a word. */
export function excerpt(text: string, n: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

// ---------- the top line on Today and the Inbox list (slice 3) ----------

/**
 * The thread's summary top line (design 3.4): its ask while something waits for the member,
 * else its headline; null without a summary (the callers keep their own line then).
 */
export function summaryLine(t: Pick<InboxThread, 'state' | 'summary'>): string | null {
  const s = t.summary;
  if (!s) return null;
  const waits = t.state === 'needsYou' || t.state === 'yourCall';
  return (waits && s.ask) || s.headline;
}
