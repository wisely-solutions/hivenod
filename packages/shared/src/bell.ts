/**
 * The bell (item 3ENs): a short history of the things that were for you, kept 30 days, read on
 * every device. Pop-ups (push, toasts) are live only; whatever you missed waits here.
 *
 * Storage: users/{uid}/notifications/{id}, written by the notifier only (admin SDK). The person
 * reads their own entries and may only set `readAt` (once, null to a number). Ids are
 * deterministic, so a restarted notifier never writes the same entry twice.
 *
 * What lands in it (the same events push and Telegram tell people about, plus their outcomes):
 *  - gate:     an item arrived at a people step you decide and you have not voted
 *  - question: an agent asked the people of your project
 *  - answer:   someone answered a question that was put to you
 *  - sentBack: an item you created was sent back
 *  - inboxAsk:  an agent asked you about one of your Inbox threads (Needs you)
 *  - inboxCall: outcomes were proposed on one of your Inbox threads (Your call)
 *    For the inbox kinds, projectId is INBOX_BELL_PROJECT and itemId is the thread id;
 *    projectName is the subject's name.
 */
import { z } from 'zod';
import { id } from './schema';

export const BELL_KEEP_DAYS = 30;
export const BELL_KEEP_MS = BELL_KEEP_DAYS * 86_400_000;
/** The bell and the full page show at most this many entries. */
export const BELL_LIMIT = 100;

export const bellKind = z.enum(['gate', 'question', 'answer', 'sentBack', 'inboxAsk', 'inboxCall']);
/** The projectId of the inbox bell entries (their itemId is the thread id). */
export const INBOX_BELL_PROJECT = 'inbox';
export const isInboxBell = (kind: BellKind) => kind === 'inboxAsk' || kind === 'inboxCall';
export type BellKind = z.infer<typeof bellKind>;

export const bellEntrySchema = z.object({
  kind: bellKind,
  workspaceId: id,
  projectId: id,
  itemId: id,
  projectName: z.string().max(200),
  itemTitle: z.string().max(300),
  /** gate: the step that waits for you; sentBack: the step it went back to. */
  stepName: z.string().max(100),
  /** Who asked, answered or sent back ('' for a gate). */
  actorName: z.string().max(200),
  /** The question, the answer or the reason, clipped ('' for a gate). */
  text: z.string().max(300),
  /** When it happened (ms). */
  at: z.number(),
  /** When the person opened it or marked it read (ms); null while unread. */
  readAt: z.number().nullable(),
});
export type BellEntry = z.infer<typeof bellEntrySchema>;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

export const bellPath = {
  list: (u: string) => `users/${u}/notifications`,
  entry: (u: string, entryId: string) => `users/${u}/notifications/${entryId}`,
} as const;

export const bellId = {
  gate: (itemId: string, gateKey: string) => `g-${safe(itemId)}-${safe(gateKey)}`,
  question: (messageId: string) => `q-${safe(messageId)}`,
  answer: (decisionId: string) => `a-${safe(decisionId)}`,
  sentBack: (decisionId: string) => `s-${safe(decisionId)}`,
  /** One arrival of a thread at Needs you or Your call (`arrival`: see inboxArrival). */
  inbox: (threadId: string, arrival: string) => `i-${safe(threadId)}-${safe(arrival)}`,
} as const;

/** The kinds that ask you to act (the "Needs you" filter). */
export function bellNeedsYou(kind: BellKind): boolean {
  return kind === 'gate' || kind === 'question' || isInboxBell(kind);
}

export const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The sentence of an entry, in three parts so the item title can be shown in bold. */
export function bellText(
  e: Pick<BellEntry, 'kind' | 'itemTitle' | 'stepName' | 'actorName' | 'text'>,
): {
  before: string;
  title: string;
  after: string;
} {
  const who = e.actorName || 'Someone';
  const quote = e.text ? `: “${e.text}”` : '';
  switch (e.kind) {
    case 'gate':
      return { before: '', title: e.itemTitle, after: ` waits for your ${e.stepName}` };
    case 'question':
      return { before: `${who} asked about `, title: e.itemTitle, after: quote };
    case 'answer':
      return { before: `${who} answered the question on `, title: e.itemTitle, after: '' };
    case 'sentBack':
      return {
        before: `${who} sent `,
        title: e.itemTitle,
        after: ` back to ${e.stepName}${e.text ? `: ${e.text}` : ''}`,
      };
    case 'inboxAsk':
      return { before: `${who} asks you about `, title: e.itemTitle, after: quote };
    case 'inboxCall':
      return { before: 'Your call on ', title: e.itemTitle, after: e.text ? `: ${e.text}` : '' };
  }
}

export function bellPlain(e: Parameters<typeof bellText>[0]): string {
  const t = bellText(e);
  return `${t.before}${t.title}${t.after}`;
}
