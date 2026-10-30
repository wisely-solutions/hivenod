/** Telegram Bot API over fetch: sending, long polling, linking a chat and the two decision buttons. */
import { randomId, notifyPath, type Notice } from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { canSendBack, decide, whyNot } from './decide';
import type { ApprovalAction, ReachTelegram, TelegramAction, ThreadTelegram } from './engine';
import { decideReach, type ReachChoice } from './reachDecide';
import { decideThread, threadCheck, type ThreadAction, type ThreadDecision } from './threadDecide';
import { itemSchema, projectSchema, paths } from '@hive/shared';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A button's text is kept short (Telegram cuts long ones anyway). */
const label = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

type Button = { text: string; callback_data?: string; url?: string };

/**
 * The keyboard of a thread message (slice 3, design 9b): Approve · Not now / Ask for changes ·
 * Open for a person step; the answers (two a row), then Reply · Not now / Open for a question.
 * Callback data: `t<kind>:<code>` (ta approve, tn not now, tc ask for changes, tr reply, to<i>
 * answer i). Pure: the tests render it.
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
  return [
    [{ text: 'Approve', callback_data: `ta:${code}` }, notNow],
    [{ text: 'Ask for changes', callback_data: `tc:${code}` }, openB],
  ];
}

/**
 * The keyboard of a silent message (item KZ6O9): Ping again · Release to queue / Stop · Open on an
 * item; Ping again · Open on a thread step. Callback data `r<p|r|s>:<code>`. Pure.
 */
export function reachKeyboard(code: string, a: ReachTelegram, open: string): Button[][] {
  const openB: Button = { text: 'Open', url: open };
  const ping: Button = { text: 'Ping again', callback_data: `rp:${code}` };
  if (a.ref.kind === 'step') return [[ping, openB]];
  return [
    [ping, { text: 'Release to queue', callback_data: `rr:${code}` }],
    [{ text: 'Stop', callback_data: `rs:${code}` }, openB],
  ];
}

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
  async send(chatId: number, notice: Notice, action?: TelegramAction): Promise<boolean> {
    const text = noticeText(notice);
    const row1 = [{ text: 'Open', url: `${this.appUrl}${notice.url}` }];
    let rows: unknown[][] = [row1];
    if (action && isReach(action)) {
      const code = randomId(12);
      await this.db
        .doc(`telegramActions/${code}`)
        .set({ ...action, chatId, createdAt: this.now() });
      rows = reachKeyboard(code, action, `${this.appUrl}${notice.url}`);
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
    } else if (action) {
      const code = randomId(12);
      await this.db
        .doc(`telegramActions/${code}`)
        .set({ ...action, chatId, createdAt: this.now() });
      const buttons: unknown[] = [{ text: 'Approve', callback_data: `a:${code}` }];
      const proj = await this.db.doc(paths.project(action.wid, action.pid)).get();
      const item = await this.db.doc(paths.item(action.wid, action.pid, action.iid)).get();
      const p = projectSchema.safeParse(proj.data());
      const i = itemSchema.safeParse(item.data());
      if (p.success && i.success && canSendBack(p.data, i.data))
        buttons.push({ text: 'Send back', callback_data: `s:${code}` });
      rows.unshift(buttons);
    }
    try {
      await this.api.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
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

  private async action(code: string, chatId: number): Promise<ApprovalAction | null> {
    const snap = await this.db.doc(`telegramActions/${code}`).get();
    const d = snap.data() as (ApprovalAction & { chatId: number; kind?: string }) | undefined;
    if (d?.kind === 'thread' || d?.kind === 'reach') return null;
    // The chat must be the one the message was sent to, and still the person's linked chat.
    if (!d || d.chatId !== chatId) return null;
    const link = (await this.db.doc(notifyPath.telegram(d.uid)).get()).data() as
      { chatId?: number } | undefined;
    return link?.chatId === chatId ? d : null;
  }

  /** The buttons of a silent message (item KZ6O9). */
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
    const choice: ReachChoice | null =
      kind === 'rp' ? 'ping' : kind === 'rr' ? 'release' : kind === 'rs' ? 'stop' : null;
    if (!d || d.kind !== 'reach' || d.chatId !== chatId || link?.chatId !== chatId || !choice)
      return void (await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'This button has expired.',
        show_alert: true,
      }));
    const r = await decideReach(this.db, d, choice, this.now());
    await this.api.call('answerCallbackQuery', {
      callback_query_id: q.id,
      text: r.text.slice(0, 190),
      ...(r.ok ? {} : { show_alert: true }),
    });
    // Ping again keeps the buttons (it may be pressed again later); the others end it.
    if (r.ok && choice !== 'ping' && q.message)
      await this.api
        .call('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: q.message.message_id,
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => undefined);
    if (r.ok) await this.say(chatId, r.text);
  }

  private async onButton(q: NonNullable<Update['callback_query']>) {
    const chatId = q.message?.chat.id;
    const [kind, code] = (q.data ?? '').split(':');
    if (chatId && code && kind?.startsWith('t')) return this.onThreadButton(q, chatId, kind, code);
    if (chatId && code && kind?.startsWith('r')) return this.onReachButton(q, chatId, kind, code);
    if (!chatId || !code || (kind !== 'a' && kind !== 's'))
      return void (await this.api.call('answerCallbackQuery', { callback_query_id: q.id }));
    const a = await this.action(code, chatId);
    if (!a)
      return void (await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: 'This button has expired.',
        show_alert: true,
      }));
    if (kind === 'a') {
      const r = await decide(this.db, a, 'approve', '', this.now());
      await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: r.text.slice(0, 190),
      });
      if (q.message)
        await this.api
          .call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: q.message.message_id,
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => undefined);
      if (!r.ok) await this.say(chatId, r.text);
      else await this.say(chatId, r.text);
      return;
    }
    // Send back needs a reason: ask for it as a reply to this prompt.
    const snap = await this.loadForPrompt(a);
    if (snap) {
      await this.api.call('answerCallbackQuery', {
        callback_query_id: q.id,
        text: snap.slice(0, 190),
        show_alert: true,
      });
      return;
    }
    await this.api.call('answerCallbackQuery', { callback_query_id: q.id });
    const sent = await this.say(
      chatId,
      'Why send it back? Reply to this message (at least 10 characters).',
      {
        reply_markup: { force_reply: true, input_field_placeholder: 'What should change?' },
      },
    );
    await this.db.doc(`telegramActions/${code}`).update({ promptMessageId: sent.message_id });
  }

  private async loadForPrompt(a: ApprovalAction): Promise<string | null> {
    const [p, i] = await Promise.all([
      this.db.doc(paths.project(a.wid, a.pid)).get(),
      this.db.doc(paths.item(a.wid, a.pid, a.iid)).get(),
    ]);
    const pr = projectSchema.safeParse(p.data());
    const it = itemSchema.safeParse(i.data());
    if (!pr.success || !it.success) return 'I could not find that item any more.';
    return whyNot(pr.data, it.data, a);
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
    const a = await this.action(doc.id, chatId);
    if (!a) return;
    const r = await decide(this.db, a, 'sendback', text, this.now());
    if (r.ok) await doc.ref.delete().catch(() => undefined);
    await this.say(
      chatId,
      r.ok
        ? r.text
        : r.text + (r.text.startsWith('Please say') ? ' Reply to my question again.' : ''),
    );
  }
}
