/** Telegram Bot API over fetch: sending, long polling, linking a chat and the thread quick actions. */
import { EXT_ASK_LABEL, randomId, notifyPath, type Notice } from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import type { ReachTelegram, TelegramAction, ThreadTelegram } from './engine';
import { decideReach } from './reachDecide';
import {
  decideRunAction,
  runWhyNot,
  memberZone,
  type RunAction,
  type RunDecision,
} from './runDecide';
import type { RunTelegram } from './scheduler';
import { parseLaterTime } from '@hive/shared';
import { decideThread, threadCheck, type ThreadAction, type ThreadDecision } from './threadDecide';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A button's text is kept short (Telegram cuts long ones anyway). */
const label = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

type Button = { text: string; callback_data?: string; url?: string };

/**
 * The keyboard of a thread message (slice 3, design 9b): Approve · Not now / Ask for changes ·
 * Open for a person step; the answers (two a row), then Reply · Not now / Open for a question.
 * Callback data: `t<kind>:<code>` (ta approve, tn not now, tc ask for changes, tr reply, to<i>
 * answer i, td mark done). A Their reply draft: Approve follow-up · Mark done / Open. Pure: the
 * tests render it.
 */
export function threadKeyboard(code: string, a: ThreadTelegram, open: string): Button[][] {
  const openB: Button = { text: 'Open', url: open };
  const notNow: Button = { text: 'Not now', callback_data: `tn:${code}` };
  if (a.ask === 'question') {
    const rows: Button[][] = [];
    a.options.forEach((o, i) => {
      const b = { text: label(o), callback_data: `to${i}:${code}` };
      if (i % 2 === 0) rows.push([b]);
      else rows[rows.length - 1]!.push(b);
    });
    rows.push([{ text: 'Reply', callback_data: `tr:${code}` }, notNow]);
    rows.push([openB]);
    return rows;
  }
  if (a.ext)
    return [
      [
        {
          text: `Approve ${(EXT_ASK_LABEL[a.ext] ?? 'message').toLowerCase()}`,
          callback_data: `ta:${code}`,
        },
        { text: 'Mark done', callback_data: `td:${code}` },
      ],
      [openB],
    ];
  return [
    [{ text: 'Approve', callback_data: `ta:${code}` }, notNow],
    [{ text: 'Ask for changes', callback_data: `tc:${code}` }, openB],
  ];
}

/**
 * The keyboard of a silent message (item KZ6O9): Ping again · Open on a thread step. Callback
 * data `rp:<code>`. Pure.
 */
export function reachKeyboard(code: string, open: string): Button[][] {
  return [
    [
      { text: 'Ping again', callback_data: `rp:${code}` },
      { text: 'Open', url: open },
    ],
  ];
}

/**
 * The keyboard of a run that could not happen (scheduled tasks, slice 4): Run now · Try later /
 * Skip this one · Open. A digest lists its runs, two buttons each (Run now · Skip). Callback data
 * `x<kind>:<code>` (xn run now, xl try later, xs skip; xh in 1 hour, xt tomorrow 09:00, xp pick a
 * time). One code per run. Pure: the tests render it.
 */
export function runKeyboard(
  codes: { code: string; title: string }[],
  open: string,
  digest = false,
): Button[][] {
  const openB: Button = { text: 'Open', url: open };
  if (!digest && codes.length === 1) {
    const c = codes[0]!.code;
    return [
      [
        { text: 'Run now', callback_data: `xn:${c}` },
        { text: 'Try later', callback_data: `xl:${c}` },
      ],
      [{ text: 'Skip this one', callback_data: `xs:${c}` }, openB],
    ];
  }
  return [
    ...codes.map(({ code, title }) => [
      { text: label(`Run now · ${title}`), callback_data: `xn:${code}` },
      { text: 'Skip', callback_data: `xs:${code}` },
    ]),
    [openB],
  ];
}

/** Try later's choices: In 1 hour · Tomorrow 09:00 / Pick a time… */
export function laterKeyboard(code: string): Button[][] {
  return [
    [
      { text: 'In 1 hour', callback_data: `xh:${code}` },
      { text: 'Tomorrow 09:00', callback_data: `xt:${code}` },
    ],
    [{ text: 'Pick a time…', callback_data: `xp:${code}` }],
  ];
}

const isRun = (a: TelegramAction): a is RunTelegram => (a as { kind?: string }).kind === 'run';
const isThread = (a: TelegramAction): a is ThreadTelegram =>
  (a as { kind?: string }).kind === 'thread';
const isReach = (a: TelegramAction): a is ReachTelegram =>
  (a as { kind?: string }).kind === 'reach';

/** The message text: the bold one-liner, then the second line. */
export function noticeText(notice: Notice): string {
  return `<b>${esc(notice.title)}</b>\n${esc(notice.body)}`;
}
export const LINK_TTL_MS = 15 * 60_000;

export class TelegramApi {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export class TelegramBot {
  private stopped = false;
  constructor(
    private api: TelegramApi,
    private db: Firestore,
    private appUrl: string,
    private now: () => number,
    private log: (s: string) => void,
  ) {}

  async botName(): Promise<string | null> {
    const me = await this.api.call<{ username?: string }>('getMe');
    return me.username ?? null;
  }

  /** The Ports.sendTelegram implementation. */
  async send(
    chatId: number,
    notice: Notice,
    action?: TelegramAction,
    silent?: boolean,
  ): Promise<boolean> {
    const text = noticeText(notice);
    const row1 = [{ text: 'Open', url: `${this.appUrl}${notice.url}` }];
    let rows: unknown[][] = [row1];
    if (action && isReach(action)) {
      const code = randomId(12);
      await this.db
        .doc(`telegramActions/${code}`)
        .set({ ...action, chatId, createdAt: this.now() });
      rows = reachKeyboard(code, `${this.appUrl}${notice.url}`);
    } else if (action && isRun(action)) {
      const codes: { code: string; title: string }[] = [];
      for (const r of action.runs) {
        const code = randomId(12);
        const doc: RunAction = {
          kind: 'run',
          wid: r.wid,
          runId: r.runId,
          uid: action.uid,
          title: r.title,
        };
        await this.db.doc(`telegramActions/${code}`).set({ ...doc, chatId, createdAt: this.now() });
        codes.push({ code, title: r.title });
      }
      rows = runKeyboard(codes, `${this.appUrl}${notice.url}`, action.digest === true);
    } else if (action && isThread(action)) {
      const code = randomId(12);
      const doc: ThreadAction = {
        kind: 'thread',
        wid: action.wid,
        tid: action.tid,
        uid: action.uid,
        arrival: action.arrival,
      };
      await this.db.doc(`telegramActions/${code}`).set({ ...doc, chatId, createdAt: this.now() });
      rows = threadKeyboard(code, action, `${this.appUrl}${notice.url}`);
    }
    try {
      await this.api.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
        ...(silent ? { disable_notification: true } : {}),
      });
      return true;
    } catch (e) {
      this.log(`telegram send: ${String(e)}`);
      return false;
    }
  }

  stop() {
    this.stopped = true;
  }

  async poll(): Promise<void> {
    let offset = 0;
    while (!this.stopped) {
      try {
        const updates = await this.api.call<Update[]>('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await this.handle(u);
          } catch (e) {
            this.log(`telegram update ${u.update_id}: ${String(e)}`);
          }
        }
      } catch (e) {
        this.log(`telegram poll: ${String(e)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async handle(u: Update): Promise<void> {
    if (u.callback_query) return this.onButton(u.callback_query);
    const m = u.message;
    if (!m?.text || m.chat.type !== 'private') return;
    const chatId = m.chat.id;
    const text = m.text.trim();
    const start = /^\/start(?:\s+(\S+))?$/.exec(text);
    if (start) {
      if (start[1]) return this.link(chatId, m.from?.username ?? null, start[1]);
      return void (await this.say(
        chatId,
        'Hi. To get Hivenod messages here, open Me, Notifications in the app and tap Connect Telegram.',
      ));
    }
    if (text === '/unlink') return this.unlink(chatId);
    if (m.reply_to_message) return this.onReason(chatId, m.reply_to_message.message_id, text);
  }

  private async say(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.api.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...extra,
    });
  }

  private async link(chatId: number, username: string | null, code: string) {
    const ref = this.db.doc(notifyPath.telegramLink(code));
    const snap = await ref.get();
    const d = snap.data() as { uid?: string; createdAt?: number } | undefined;
    if (!d?.uid || !d.createdAt || this.now() - d.createdAt > LINK_TTL_MS) {
      await ref.delete().catch(() => undefined);
      return void (await this.say(
        chatId,
        'That link has expired. Tap Connect Telegram in the app again.',
      ));
    }
    await this.db.doc(notifyPath.telegram(d.uid)).set({ chatId, username, linkedAt: this.now() });
    await this.db.doc(`telegramChats/${chatId}`).set({ uid: d.uid });
    await ref.delete();
    await this.say(
      chatId,
      'Connected. I will message you here when something needs you. Send /unlink to stop.',
    );
  }

  private async unlink(chatId: number) {
    const chat = (await this.db.doc(`telegramChats/${chatId}`).get()).data() as
      { uid?: string } | undefined;
    if (chat?.uid) await this.db.doc(notifyPath.telegram(chat.uid)).delete();
    await this.db.doc(`telegramChats/${chatId}`).delete();
    await this.say(chatId, 'Unlinked. You will not get messages here any more.');
  }

  private async threadAction(code: string, chatId: number): Promise<ThreadAction | null> {
    const d = (await this.db.doc(`telegramActions/${code}`).get()).data() as
      (ThreadAction & { chatId: number }) | undefined;
    if (!d || d.kind !== 'thread' || d.chatId !== chatId) return null;
    const link = (await this.db.doc(notifyPath.telegram(d.uid)).get()).data() as
      { chatId?: number } | undefined;
    return link?.chatId === chatId ? d : null;
  }

  /** The buttons of a thread message (slice 3). */
  private async onThreadButton(
    q: NonNullable<Update['callback_query']>,
    chatId: number,
    kind: string,
    code: string,
  ) {
    const a = await this.threadAction(code, chatId);
    if (!a)
      return void (await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'This button has expired.',
        show_alert: true,
      }));
    const clear = async () => {
      if (q.message)
        await this.api
          .call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: q.message.message_id,
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => undefined);
    };
    // Ask for changes and Reply need a text: ask for it as a reply to a prompt.
    if (kind === 'tc' || kind === 'tr') {
      const why = await threadCheck(this.db, a);
      if (why) {
        await this.api.call('answerCallbackQuery', {
          callback_query_id: q.id,
          text: why.slice(0, 190),
          show_alert: true,
        });
        return clear();
      }
      await this.api.call('answerCallbackQuery', { callback_query_id: q.id });
      const sent = await this.say(
        chatId,
        kind === 'tc'
          ? 'What should change? Reply to this message.'
          : 'Your answer? Reply to this message.',
        {
          reply_markup: {
            force_reply: true,
            input_field_placeholder: kind === 'tc' ? 'What should change?' : 'Your answer',
          },
        },
      );
      await this.db
        .doc(`telegramActions/${code}`)
        .update({ promptMessageId: sent.message_id, prompt: kind === 'tc' ? 'changes' : 'answer' });
      return;
    }
    const opt = /^to(\d)$/.exec(kind);
    const d: ThreadDecision | null =
      kind === 'ta'
        ? { kind: 'approve' }
        : kind === 'td'
          ? { kind: 'markDone' }
          : kind === 'tn'
            ? { kind: 'notNow' }
            : opt
              ? { kind: 'option', index: Number(opt[1]) }
              : null;
    if (!d) return void (await this.api.call('answerCallbackQuery', { callback_query_id: q.id }));
    const r = await decideThread(this.db, a, d, this.now());
    await this.api.call('answerCallbackQuery', {
      callback_query_id: q.id,
      text: r.text.slice(0, 190),
      ...(r.ok ? {} : { show_alert: true }),
    });
    await clear();
    if (r.ok) await this.say(chatId, r.text);
  }

  /** The button of a silent message (item KZ6O9): Ping again. */
  private async onReachButton(
    q: NonNullable<Update['callback_query']>,
    chatId: number,
    kind: string,
    code: string,
  ) {
    const d = (await this.db.doc(`telegramActions/${code}`).get()).data() as
      (ReachTelegram & { chatId: number }) | undefined;
    const link =
      d?.kind === 'reach'
        ? ((await this.db.doc(notifyPath.telegram(d.uid)).get()).data() as
            { chatId?: number } | undefined)
        : undefined;
    // rp: Ping again (rr/rs: Release and Stop of old item messages, gone with projects).
    if (!d || d.kind !== 'reach' || d.chatId !== chatId || link?.chatId !== chatId || kind !== 'rp')
      return void (await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'This button has expired.',
        show_alert: true,
      }));
    const r = await decideReach(this.db, d, this.now());
    await this.api.call('answerCallbackQuery', {
      callback_query_id: q.id,
      text: r.text.slice(0, 190),
      ...(r.ok ? {} : { show_alert: true }),
    });
    // Ping again keeps the buttons (it may be pressed again later).
    if (r.ok) await this.say(chatId, r.text);
  }

  private async runAction(code: string, chatId: number): Promise<RunAction | null> {
    const d = (await this.db.doc(`telegramActions/${code}`).get()).data() as
      (RunAction & { chatId: number }) | undefined;
    if (!d || d.kind !== 'run' || d.chatId !== chatId) return null;
    const link = (await this.db.doc(notifyPath.telegram(d.uid)).get()).data() as
      { chatId?: number } | undefined;
    return link?.chatId === chatId ? d : null;
  }

  /** The buttons of a run that could not happen (scheduled tasks, slice 4). */
  private async onRunButton(
    q: NonNullable<Update['callback_query']>,
    chatId: number,
    kind: string,
    code: string,
  ) {
    const a = await this.runAction(code, chatId);
    const answer = (text?: string, alert = false) =>
      this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        ...(text ? { text: text.slice(0, 190) } : {}),
        ...(alert ? { show_alert: true } : {}),
      });
    if (!a) return void (await answer('This button has expired.', true));
    if (kind === 'xl' || kind === 'xp') {
      const why = await runWhyNot(this.db, a);
      if (why) return void (await answer(why, true));
      await answer();
      if (kind === 'xl') {
        await this.say(chatId, `Try “${a.title}” again when?`, {
          reply_markup: { inline_keyboard: laterKeyboard(code) },
        });
        return;
      }
      const sent = await this.say(
        chatId,
        `When should I try “${a.title}” again? Reply with a time, e.g. 14:30, tomorrow 10:00 or 3 Nov 9:00.`,
        { reply_markup: { force_reply: true, input_field_placeholder: 'e.g. tomorrow 10:00' } },
      );
      await this.db
        .doc(`telegramActions/${code}`)
        .update({ promptMessageId: sent.message_id, prompt: 'later' });
      return;
    }
    const d: RunDecision | null =
      kind === 'xn'
        ? { choice: 'runNow' }
        : kind === 'xs'
          ? { choice: 'skip' }
          : kind === 'xh'
            ? { choice: 'later', at: 'hour' }
            : kind === 'xt'
              ? { choice: 'later', at: 'tomorrow' }
              : null;
    if (!d) return void (await answer());
    const r = await decideRunAction(this.db, a, d, this.now());
    await answer(r.text, !r.ok);
    if (r.ok) await this.say(chatId, r.text);
  }

  private async onButton(q: NonNullable<Update['callback_query']>) {
    const chatId = q.message?.chat.id;
    const [kind, code] = (q.data ?? '').split(':');
    if (chatId && code && kind?.startsWith('t')) return this.onThreadButton(q, chatId, kind, code);
    if (chatId && code && kind?.startsWith('r')) return this.onReachButton(q, chatId, kind, code);
    if (chatId && code && kind?.startsWith('x')) return this.onRunButton(q, chatId, kind, code);
    // Old Approve / Send back buttons of project items (gone, design 7) answer nothing.
    if (chatId && code && (kind === 'a' || kind === 's'))
      return void (await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'This button has expired.',
        show_alert: true,
      }));
    return void (await this.api.call('answerCallbackQuery', { callback_query_id: q.id }));
  }

  private async onReason(chatId: number, promptId: number, text: string) {
    const q = await this.db
      .collection('telegramActions')
      .where('chatId', '==', chatId)
      .where('promptMessageId', '==', promptId)
      .limit(1)
      .get();
    const doc = q.docs[0];
    if (!doc) return;
    if (doc.data().kind === 'run') {
      const ra = await this.runAction(doc.id, chatId);
      if (!ra) return;
      const p = parseLaterTime(text, this.now(), await memberZone(this.db, ra.uid));
      if (!p.ok) return void (await this.say(chatId, `${p.error} Reply to my question again.`));
      const r = await decideRunAction(this.db, ra, { choice: 'later', atMs: p.atMs }, this.now());
      if (r.ok) await doc.ref.update({ promptMessageId: null }).catch(() => undefined);
      await this.say(chatId, r.text);
      return;
    }
    if (doc.data().kind === 'thread') {
      const ta = await this.threadAction(doc.id, chatId);
      if (!ta) return;
      const d: ThreadDecision =
        doc.data().prompt === 'answer' ? { kind: 'answer', text } : { kind: 'changes', text };
      const r = await decideThread(this.db, ta, d, this.now());
      if (r.ok) await doc.ref.delete().catch(() => undefined);
      await this.say(chatId, r.ok ? r.text : `${r.text} Reply to my question again.`);
      return;
    }
    // An old Send back prompt of a project item (gone, design 7): nothing to do.
    await doc.ref.delete().catch(() => undefined);
  }
}
