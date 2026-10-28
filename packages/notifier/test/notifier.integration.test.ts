/**
 * The notifier against the real Firestore emulator: listeners feed the engine, Telegram messages
 * carry decision buttons, a button press approves through the same ActionPlan the app uses, a
 * reply sends back with a reason, and a one-time code links a chat.
 */
import { bellId, bellPath, notifyPath, paths } from '@hive/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atGate, I, itemDoc, put, useEmulator, W } from '../../shared/rules/harness';
import { Engine } from '../src/engine';
import { firestorePorts, watchAll } from '../src/store';
import { TelegramApi, TelegramBot } from '../src/telegram';

useEmulator();

let db: Firestore;
beforeAll(() => {
  db = getFirestore(getApps()[0] ?? initializeApp({ projectId: 'hive-rules-test' }));
});

interface Body {
  chat_id?: number;
  text?: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard?: { callback_data?: string; url?: string }[][];
  };
}
interface Call {
  method: string;
  body: Body;
}
function fakeTelegram() {
  const calls: Call[] = [];
  let nextId = 100;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(init.body) as Body;
    calls.push({ method, body });
    return {
      json: async () => ({ ok: true, result: { message_id: nextId++, username: 'hive_bot' } }),
    };
  }) as unknown as typeof fetch;
  return {
    calls,
    bot: new TelegramBot(
      new TelegramApi('T', fetchImpl),
      db,
      'https://app.test',
      () => Date.now(),
      () => undefined,
    ),
  };
}
const until = async (f: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
};
const buttonCode = (calls: Call[], prefix: string) => {
  const rows = calls
    .filter((c) => c.method === 'sendMessage')
    .flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []);
  const b = rows.flat().find((x) => String(x.callback_data ?? '').startsWith(prefix));
  return b?.callback_data;
};
const press = (bot: TelegramBot, chat: number, data: string) =>
  bot.handle({
    update_id: 1,
    callback_query: {
      id: 'cb',
      from: { id: chat },
      data,
      message: { message_id: 5, chat: { id: chat } },
    },
  });

describe('notifier end to end', () => {
  afterAll(() => undefined);

  it('tells the decider on Telegram with buttons, and Approve moves the item on', async () => {
    await put({
      [notifyPath.telegram('alice')]: { chatId: 42, username: null, linkedAt: 1 },
      [notifyPath.prefs('alice')]: {
        push: false,
        telegram: true,
        digest: false,
        quiet: { enabled: false, from: '22:00', to: '08:00', tz: 'UTC' },
      },
      [paths.member(W, 'alice')]: { name: 'Alice', email: 'a@x.test', photoURL: null, color: 'c1' },
    });
    const { calls, bot } = fakeTelegram();
    const ports = firestorePorts(db, {
      sendPush: async () => ({ result: 'error' as const, attempts: 0 }),
      sendTelegram: (c, n, a) => bot.send(c, n, a),
      log: () => undefined,
    });
    const engine = new Engine(ports);
    const stop = watchAll(
      db,
      engine,
      () => void engine.sweep(),
      () => undefined,
    );
    try {
      await until(() => calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === 42));
      const msg = calls.find((c) => c.method === 'sendMessage')!.body;
      expect(msg.text).toContain('Needs your approval');
      expect(JSON.stringify(msg.reply_markup)).toContain('/p/p1?item=gated');
      await until(async () => (await db.doc(notifyPath.notified(W, 'g-gated')).get()).exists);
      const mark = (await db.doc(notifyPath.notified(W, 'g-gated')).get()).data()!;
      expect(mark.sent).toContain('alice');
      // The bell (item 3ENs): the arrival is in Alice's history, unread.
      const bell = bellPath.entry('alice', bellId.gate('gated', 'review:0'));
      await until(async () => (await db.doc(bell).get()).exists);
      expect((await db.doc(bell).get()).data()).toMatchObject({
        kind: 'gate',
        itemId: 'gated',
        projectId: 'p1',
        workspaceId: W,
        readAt: null,
      });

      const code = buttonCode(calls, 'a:')!;
      expect(code).toBeTruthy();
      // Someone else's chat cannot press it.
      await press(bot, 99, code);
      expect((await db.doc(I('gated')).get()).data()!.stepId).toBe('review');
      // Alice's chat can.
      await press(bot, 42, code);
      const after = (await db.doc(I('gated')).get()).data()!;
      expect(after.stepId).toBe('publish');
      expect(after.status).toBe('queued');
      const ev = await db
        .collection(`workspaces/${W}/events`)
        .where('type', '==', 'decision.approved')
        .get();
      expect(ev.docs[0]!.data().actor).toMatchObject({ type: 'human', id: 'alice', name: 'Alice' });
      expect(ev.docs[0]!.data().data.via).toBe('telegram');
      const dec = await db
        .collectionGroup('decisions')
        .where('lastEventId', '==', ev.docs[0]!.id)
        .get();
      expect(dec.docs[0]!.data().via).toBe('telegram');
      // A second press finds the item moved on.
      await press(bot, 42, code);
      expect(calls.filter((c) => c.method === 'sendMessage').pop()!.body.text).toContain(
        'no longer waiting',
      );
    } finally {
      stop();
    }
  });

  it('Send back asks for a reason and moves the item to the earlier step', async () => {
    await put({
      [notifyPath.telegram('alice')]: { chatId: 42, username: null, linkedAt: 1 },
      [paths.member(W, 'alice')]: { name: 'Alice', email: 'a@x.test', photoURL: null, color: 'c1' },
      [I('g2')]: atGate(),
    });
    const { calls, bot } = fakeTelegram();
    const code = 'sbcode000001';
    await db.doc(`telegramActions/${code}`).set({
      wid: W,
      pid: 'p1',
      iid: 'g2',
      uid: 'alice',
      gateKey: 'review:0',
      chatId: 42,
      createdAt: Date.now(),
    });
    await press(bot, 42, `s:${code}`);
    const prompt = calls.find((c) => c.body.reply_markup?.force_reply);
    expect(prompt).toBeTruthy();
    const promptId = (await db.doc(`telegramActions/${code}`).get()).data()!
      .promptMessageId as number;
    // Too short: refused and asked again.
    await bot.handle({
      update_id: 2,
      message: {
        message_id: 9,
        chat: { id: 42, type: 'private' },
        text: 'no',
        reply_to_message: { message_id: promptId },
      },
    });
    expect((await db.doc(I('g2')).get()).data()!.stepId).toBe('review');
    await bot.handle({
      update_id: 3,
      message: {
        message_id: 10,
        chat: { id: 42, type: 'private' },
        text: 'The intro is too long',
        reply_to_message: { message_id: promptId },
      },
    });
    const item = (await db.doc(I('g2')).get()).data()!;
    expect(item.stepId).toBe('draft');
    expect(item.sendBackCount).toBe(1);
    const decisions = await db.collection(`workspaces/${W}/projects/p1/decisions`).get();
    expect(decisions.docs.some((d) => d.data().rationale === 'The intro is too long')).toBe(true);
  });

  it('a send back by an agent goes in the bell of the person who created the item', async () => {
    await put({
      [paths.member(W, 'alice')]: { name: 'Alice', email: 'a@x.test', photoURL: null, color: 'c1' },
      [I('sb1')]: itemDoc({ title: 'Launch post' }),
    });
    const engine = new Engine(
      firestorePorts(db, {
        sendPush: async () => ({ result: 'error' as const, attempts: 0 }),
        sendTelegram: async () => false,
        log: () => undefined,
      }),
    );
    const stop = watchAll(
      db,
      engine,
      () => void engine.sweep(),
      () => undefined,
    );
    try {
      await new Promise((r) => setTimeout(r, 500));
      await db.doc(paths.decision(W, 'p1', 'dsb1')).set({
        workspaceId: W,
        projectId: 'p1',
        itemId: 'sb1',
        itemTitle: 'Launch post',
        stepId: 'review',
        outcome: 'sentBack',
        toStepId: 'draft',
        byUid: 'bob',
        rationale: 'Seven e2e failures',
        tags: [],
        at: Timestamp.now(),
        lastEventId: 'dsb1',
      });
      const bell = bellPath.entry('alice', bellId.sentBack('dsb1'));
      await until(async () => (await db.doc(bell).get()).exists);
      expect((await db.doc(bell).get()).data()).toMatchObject({
        kind: 'sentBack',
        itemTitle: 'Launch post',
        stepName: 'Draft',
        text: 'Seven e2e failures',
        readAt: null,
      });
      // Not in the bell of the one who sent it back.
      expect((await db.doc(bellPath.entry('bob', bellId.sentBack('dsb1'))).get()).exists).toBe(
        false,
      );
    } finally {
      stop();
    }
  });

  it('links a chat with a one-time code and unlinks it', async () => {
    const { calls, bot } = fakeTelegram();
    await db
      .doc(notifyPath.telegramLink('linkcode0123456789'))
      .set({ uid: 'bob', createdAt: Date.now() });
    await bot.handle({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 55, type: 'private' },
        from: { id: 55, username: 'bobby' },
        text: '/start linkcode0123456789',
      },
    });
    expect((await db.doc(notifyPath.telegram('bob')).get()).data()).toMatchObject({
      chatId: 55,
      username: 'bobby',
    });
    expect((await db.doc(notifyPath.telegramLink('linkcode0123456789')).get()).exists).toBe(false);
    expect(calls.pop()!.body.text).toContain('Connected');
    // Expired codes link nothing.
    await db
      .doc(notifyPath.telegramLink('oldcode0123456789ab'))
      .set({ uid: 'carol', createdAt: Date.now() - 3_600_000 });
    await bot.handle({
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: 56, type: 'private' },
        text: '/start oldcode0123456789ab',
      },
    });
    expect((await db.doc(notifyPath.telegram('carol')).get()).exists).toBe(false);
    await bot.handle({
      update_id: 3,
      message: { message_id: 3, chat: { id: 55, type: 'private' }, text: '/unlink' },
    });
    expect((await db.doc(notifyPath.telegram('bob')).get()).exists).toBe(false);
  });
});
