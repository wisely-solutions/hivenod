/**
 * Reaching people outside the app (card rN5Q12W2). Pure model shared by the web app (Me ->
 * Notifications, the reminder label) and the notifier service (packages/notifier): what a person
 * chose, when they must not be disturbed, which gate a reminder belongs to, and the texts.
 *
 * Storage (written by the app unless noted):
 *  - users/{uid}/notify/prefs      the person's choices (NotifyPrefs)
 *  - users/{uid}/notify/telegram   linked chat (written by the notifier only; the person may delete it)
 *  - users/{uid}/pushSubs/{id}     one Web Push subscription per device
 *  - telegramLinks/{code}          a one-time code the person created to link Telegram (notifier reads it)
 *  - config/notify                 public settings the notifier publishes (VAPID public key, bot name)
 *  - workspaces/{wid}/notified/{key}  what the notifier already sent (notifier only; members read it)
 */
import { z } from 'zod';
import { id, uid, type Item } from './schema';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const notifyPrefsSchema = z.object({
  /** Push to this person's devices (each device still has to subscribe). */
  push: z.boolean(),
  /** Telegram messages, once a chat is linked. */
  telegram: z.boolean(),
  /** Daily email digest. Reserved: sending email needs a provider (a spend card), nothing sends it yet. */
  digest: z.boolean(),
  quiet: z.object({
    enabled: z.boolean(),
    from: hhmm,
    to: hhmm,
    /** IANA zone, e.g. Europe/Lisbon. */
    tz: z.string().min(1).max(64),
  }),
});
export type NotifyPrefs = z.infer<typeof notifyPrefsSchema>;

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  push: true,
  telegram: true,
  digest: false,
  quiet: { enabled: false, from: '22:00', to: '08:00', tz: 'UTC' },
};

/** What the Web Push API hands the page (PushSubscription.toJSON()). */
export const pushSubSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  /** Short device name for the list, e.g. "Chrome on Android". */
  label: z.string().max(80),
  createdAt: z.number(),
});
export type PushSub = z.infer<typeof pushSubSchema>;

export const telegramLinkSchema = z.object({
  chatId: z.number(),
  username: z.string().max(100).nullable(),
  linkedAt: z.number(),
});
export type TelegramLink = z.infer<typeof telegramLinkSchema>;

export const notifyConfigSchema = z.object({
  vapidPublicKey: z.string().max(200).nullable(),
  telegramBot: z.string().max(100).nullable(),
});
export type NotifyConfig = z.infer<typeof notifyConfigSchema>;

/** What the notifier remembers about one waiting gate (doc id `g-<itemId>`). */
export const notifiedSchema = z.object({
  itemId: id,
  projectId: id,
  /** `<stepId>:<sendBackCount>`, see gateKey(): a new arrival at a gate is a new key. */
  gateKey: z.string().max(100),
  /** People already told about this arrival. */
  sent: z.array(uid).max(200),
  /** When the reminder went out (ms), absent while none has. */
  remindedAt: z.number().nullable(),
  at: z.number(),
});
export type Notified = z.infer<typeof notifiedSchema>;

export const notifyPath = {
  prefs: (u: string) => `users/${u}/notify/prefs`,
  telegram: (u: string) => `users/${u}/notify/telegram`,
  pushSubs: (u: string) => `users/${u}/pushSubs`,
  pushSub: (u: string, subId: string) => `users/${u}/pushSubs/${subId}`,
  telegramLink: (code: string) => `telegramLinks/${code}`,
  config: 'config/notify',
  notified: (w: string, key: string) => `workspaces/${w}/notified/${key}`,
  notifiedGate: (itemId: string) => `g-${itemId}`,
} as const;

/** A short stable id for a subscription (its endpoint is too long and awkward for a doc id). */
export function subId(endpoint: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < endpoint.length; i++) {
    const c = endpoint.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${endpoint.length.toString(36)}`;
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Local minutes since midnight in `tz` (falls back to UTC for an unknown zone). */
function localMinutes(now: Date, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** True while the person asked not to be disturbed. The window may cross midnight (22:00 to 08:00). */
export function inQuietHours(quiet: NotifyPrefs['quiet'], now: Date): boolean {
  if (!quiet.enabled) return false;
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  if (from === to) return false;
  const m = localMinutes(now, quiet.tz);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Identifies one arrival of an item at a gate; sending an item back and forward makes a new one. */
export function gateKey(item: Pick<Item, 'stepId' | 'sendBackCount'>): string {
  return `${item.stepId}:${item.sendBackCount}`;
}

/** True when a gate has waited at least `remindAfterHours` (0 means no reminders). */
export function reminderDue(sinceMs: number, nowMs: number, remindAfterHours: number): boolean {
  return remindAfterHours > 0 && nowMs - sinceMs >= remindAfterHours * 3_600_000;
}

/**
 * The note shown next to "Waiting 30 h" on Needs you and the board: "reminder sent" once the
 * notifier sent it, "reminder due" when the time has passed but nothing was sent (nobody is
 * reachable, or the notifier is off), nothing before that.
 */
export function reminderNote(input: {
  sinceMs: number;
  nowMs: number;
  remindAfterHours: number;
  item: Pick<Item, 'stepId' | 'sendBackCount'>;
  notified: Pick<Notified, 'gateKey' | 'remindedAt'> | null | undefined;
}): 'sent' | 'due' | null {
  if (input.notified?.remindedAt && input.notified.gateKey === gateKey(input.item)) return 'sent';
  return reminderDue(input.sinceMs, input.nowMs, input.remindAfterHours) ? 'due' : null;
}

/** The deep link to an item, relative to the app origin. */
export function itemLink(projectId: string, itemId: string): string {
  return `/p/${projectId}?item=${itemId}`;
}

export interface Notice {
  title: string;
  body: string;
  /** Relative deep link. */
  url: string;
  /** When the push was sent (ms), set by the notifier's push sender; the service worker drops old ones. */
  sentAt?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function approvalNotice(a: {
  projectName: string;
  stepName: string;
  itemTitle: string;
  projectId: string;
  itemId: string;
  reminderHours?: number;
}): Notice {
  return {
    title: a.reminderHours
      ? `Still waiting: ${clip(a.itemTitle, 80)}`
      : `Needs your approval: ${clip(a.itemTitle, 80)}`,
    body: a.reminderHours
      ? `${a.projectName} · ${a.stepName} · waiting ${a.reminderHours} h`
      : `${a.projectName} · ${a.stepName}`,
    url: itemLink(a.projectId, a.itemId),
  };
}

export function questionNotice(q: {
  projectName: string;
  itemTitle: string;
  text: string;
  projectId: string;
  itemId: string;
}): Notice {
  return {
    title: `Question: ${clip(q.itemTitle, 80)}`,
    body: `${q.projectName} · ${clip(q.text, 160)}`,
    url: itemLink(q.projectId, q.itemId),
  };
}

/** The deep link to an Inbox thread, relative to the app origin. */
export function threadLink(workspaceId: string, threadId: string): string {
  return `/inbox/${workspaceId}/t/${threadId}`;
}

/** An Inbox thread waits for its member: a question (Needs you) or proposals (Your call). */
export function inboxNotice(t: {
  kind: 'needsYou' | 'yourCall';
  subjectName: string;
  threadTitle: string;
  /** The question, or what is proposed. */
  text: string;
  workspaceId: string;
  threadId: string;
  urgent?: boolean;
}): Notice {
  const head = t.kind === 'needsYou' ? 'Needs you' : 'Your call';
  return {
    title: `${t.urgent ? 'Urgent · ' : ''}${head}: ${clip(t.threadTitle || 'An Inbox thread', 80)}`,
    body: `${t.subjectName ? `${clip(t.subjectName, 60)} · ` : ''}${clip(t.text, 160)}`,
    url: threadLink(t.workspaceId, t.threadId),
  };
}

/** One message instead of many when several things piled up during quiet hours. */
export function summaryNotice(count: number): Notice {
  return {
    title: `${count} things need you`,
    body: 'Held back during quiet hours.',
    url: '/',
  };
}

/** The tab title, with the count when something waits. */
export function tabTitle(base: string, count: number | null): string {
  return count && count > 0 ? `(${count}) ${base}` : base;
}
