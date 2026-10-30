/**
 * The notifier against the real Firestore emulator: Inbox thread listeners feed the engine,
 * Telegram messages carry the thread quick actions, a button press decides through the same
 * ActionPlan the app uses, and a one-time code links a chat. (Projects are gone, design 7.)
 */
import { bellId, bellPath, inboxPaths, notifyPath, paths } from '@hive/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { now as harnessNow, put, useEmulator, W } from '../../shared/rules/harness';
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

  it('an Inbox thread at Your call tells its member alone (item 4PEHr)', async () => {
    const now = harnessNow();
    await put({
      [notifyPath.telegram('alice')]: { chatId: 42, username: null, linkedAt: 1 },
      [notifyPath.telegram('bob')]: { chatId: 43, username: null, linkedAt: 1 },
      [inboxPaths.subject(W, 's1')]: {
        memberUid: 'alice',
        name: 'Review dates (Payments)',
        createdBy: { type: 'agent', id: 'agentA' },
        createdAt: now,
        updatedAt: now,
        lastEventId: 'e0',
      },
      [inboxPaths.thread(W, 'it1')]: {
        memberUid: 'alice',
        subjectId: 's1',
        state: 'yourCall',
        waiting: null,
        question: null,
        title: 'Move the review to Thursday?',
        refs: ['r1'],
        lastMessageAt: now,
        fetchedBy: 'agentA',
        createdAt: now,
        updatedAt: now,
        lastEventId: 'e1',
      },
      [inboxPaths.outcome(W, 'o1')]: {
        memberUid: 'alice',
        threadId: 'it1',
        type: 'reply',
        fields: { text: 'Thursday works.' },
        state: 'proposed',
        note: '',
        proposedBy: 'agentA',
        executor: 'agentA',
        decision: null,
        result: null,
        createdAt: now,
        updatedAt: now,
        lastEventId: 'e1',
      },
    });
    const { calls, bot } = fakeTelegram();
    const engine = new Engine(
      firestorePorts(db, {
        sendPush: async () => ({ result: 'error' as const, attempts: 0 }),
        sendTelegram: (c, n, a) => bot.send(c, n, a),
        log: () => undefined,
      }),
    );
    // One sweep at a time, like main.ts (its kick never runs two sweeps at once).
    let chain = Promise.resolve();
    const stop = watchAll(
      db,
      engine,
      () => {
        chain = chain.then(() => engine.sweep());
      },
      () => undefined,
    );
    try {
      const mine = () =>
        calls.filter(
          (c) => c.method === 'sendMessage' && String(c.body.text).includes('Your call'),
        );
      await until(() => mine().length > 0);
      expect(mine().map((c) => c.body.chat_id)).toEqual([42]);
      expect(String(mine()[0]!.body.text)).toContain('Move the review to Thursday?');
      expect(JSON.stringify(mine()[0]!.body)).toContain(`/inbox/${W}/t/it1`);
      const bell = bellPath.entry('alice', bellId.inbox('it1', `c${now.toMillis()}`));
      await until(async () => (await db.doc(bell).get()).exists);
      expect((await db.doc(bell).get()).data()).toMatchObject({
        kind: 'inboxCall',
        itemId: 'it1',
        projectName: 'Inbox · Review dates (Payments)',
        text: 'Reply',
      });
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

describe('decision points on threads end to end (slice 3, design 9b)', () => {
  const prefs = {
    push: false,
    telegram: true,
    digest: false,
    quiet: { enabled: false, from: '22:00', to: '08:00', tz: 'Europe/Lisbon' },
  };
  const outcome = (over: Record<string, unknown>) => {
    const now = harnessNow();
    return {
      memberUid: 'alice',
      threadId: 'dt1',
      type: 'reply',
      fields: { text: 'Thursday works.' },
      state: 'proposed',
      note: '',
      proposedBy: 'agentA',
      executor: 'agentA',
      decision: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      lastEventId: 'e1',
      ...over,
    };
  };
  const thread = (over: Record<string, unknown> = {}) => {
    const now = harnessNow();
    return {
      memberUid: 'alice',
      subjectId: null,
      state: 'yourCall',
      waiting: null,
      question: null,
      title: 'Release 175',
      refs: ['r1'],
      lastMessageAt: now,
      fetchedBy: 'agentA',
      createdAt: now,
      updatedAt: now,
      lastEventId: 'e1',
      summary: {
        version: 3,
        at: now,
        headline: 'Release 175 is ready',
        ask: 'Ship release 175 to hivenod.com?',
        answer: 'Everything passed: 612 of 612 checks',
        recAction: 'Approve',
        confidence: 'high',
      },
      ...over,
    } as Record<string, unknown>;
  };
  const bare = (over: Record<string, unknown>) => {
    const t = thread(over);
    delete t.summary;
    return t;
  };
  async function start() {
    const { calls, bot } = fakeTelegram();
    const engine = new Engine(
      firestorePorts(db, {
        sendPush: async () => ({ result: 'error' as const, attempts: 0 }),
        sendTelegram: (c, n, a) => bot.send(c, n, a),
        log: () => undefined,
      }),
    );
    let chain = Promise.resolve();
    const stop = watchAll(
      db,
      engine,
      () => {
        chain = chain.then(() => engine.sweep());
      },
      () => undefined,
    );
    return { calls, bot, stop };
  }
  const people = () => ({
    [notifyPath.telegram('alice')]: { chatId: 42, username: null, linkedAt: 1 },
    [notifyPath.prefs('alice')]: prefs,
    [paths.member(W, 'alice')]: { name: 'Alice', email: 'a@x.test', photoURL: null, color: 'c1' },
  });
  const sent = (calls: Call[], has: string) =>
    calls.filter((c) => c.method === 'sendMessage' && String(c.body.text).includes(has));
  const answers = (calls: Call[]) =>
    calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text ?? ''));

  it('a plan gate: the one-liner, Approve passes it as on the web, a second tap is already decided', async () => {
    const now = harnessNow();
    await put({
      ...people(),
      [inboxPaths.thread(W, 'dt1')]: thread(),
      [inboxPaths.plan(W, 'pl1')]: {
        memberUid: 'alice',
        threadId: 'dt1',
        proposedBy: 'agentA',
        steps: ['g1', 'g2'],
        cursor: 0,
        state: 'active',
        note: 'Ship then check',
        createdAt: now,
        updatedAt: now,
        lastEventId: 'e1',
      },
      [inboxPaths.outcome(W, 'g1')]: outcome({
        type: 'approval',
        fields: { what: 'Ship it?' },
        executor: null,
        planId: 'pl1',
      }),
      [inboxPaths.outcome(W, 'g2')]: outcome({
        type: 'approval',
        fields: { what: 'Accept on live?' },
        executor: null,
        planId: 'pl1',
      }),
    });
    const { calls, bot, stop } = await start();
    try {
      await until(() => sent(calls, 'Ship release 175').length > 0);
      const msg = sent(calls, 'Ship release 175')[0]!.body;
      expect(msg.chat_id).toBe(42);
      expect(msg.text).toBe(
        '<b>Ship release 175 to hivenod.com?</b>\nAgent recommends Approve · confidence high',
      );
      const flat = (msg.reply_markup?.inline_keyboard ?? []).flat();
      expect(flat.map((b) => (b as { text?: string }).text)).toEqual([
        'Approve',
        'Not now',
        'Ask for changes',
        'Open',
      ]);
      const code = buttonCode(calls, 'ta:')!;
      await press(bot, 99, code);
      expect((await db.doc(inboxPaths.outcome(W, 'g1')).get()).data()!.state).toBe('proposed');
      await press(bot, 42, code);
      expect((await db.doc(inboxPaths.outcome(W, 'g1')).get()).data()).toMatchObject({
        state: 'done',
        // The gate pins the summary version the one-liner came from (slice 6).
        decision: { byUid: 'alice', summaryVersion: 3 },
      });
      expect((await db.doc(inboxPaths.plan(W, 'pl1')).get()).data()!.cursor).toBe(1);
      const ev = await db
        .collection(`workspaces/${W}/inboxEvents`)
        .where('type', '==', 'outcome.approved')
        .get();
      expect(ev.docs[0]!.data().actor).toMatchObject({ type: 'human', id: 'alice', name: 'Alice' });
      // The second tap: already decided, at the decision's time in Alice's zone.
      await press(bot, 42, code);
      expect(answers(calls).pop()).toMatch(/^Already decided at \d\d:\d\d\.$/);
      expect((await db.doc(inboxPaths.plan(W, 'pl1')).get()).data()!.cursor).toBe(1);
      // The next gate at its turn is a new arrival: held until the agent's new summary comes,
      // then told with it.
      const at = Timestamp.now();
      await db.doc(inboxPaths.thread(W, 'dt1')).update({
        updatedAt: at,
        summary: {
          version: 4,
          at,
          headline: 'Release 175 is live',
          ask: 'Accept release 175 on live?',
          answer: null,
          recAction: 'Approve',
          confidence: 'high',
        },
      });
      await until(() => sent(calls, 'Accept release 175 on live?').length > 0);
      await until(
        () =>
          calls.filter((c) => c.method === 'sendMessage' && /ta:/.test(JSON.stringify(c.body)))
            .length > 1,
      );
    } finally {
      stop();
    }
  });

  it('Not now puts it out of Today; Ask for changes asks the agent to revise', async () => {
    await put({
      ...people(),
      [inboxPaths.thread(W, 'dt1')]: thread({
        title: 'Move the review',
        summary: {
          version: 1,
          at: harnessNow(),
          headline: 'Sam asks to move the review',
          ask: 'Reply to Sam that Thursday works?',
          answer: null,
          recAction: 'Approve',
          confidence: 'medium',
        },
      }),
      [inboxPaths.outcome(W, 'o1')]: outcome({}),
    });
    const { calls, bot, stop } = await start();
    try {
      await until(() => sent(calls, 'Thursday works?').length > 0);
      await press(bot, 42, buttonCode(calls, 'tn:')!);
      const t = (await db.doc(inboxPaths.thread(W, 'dt1')).get()).data()!;
      expect(t.notNow.key).toMatch(/^c\d+$/);
      expect(t.notNow.until.toDate().getUTCHours()).toBeGreaterThanOrEqual(8);
      expect(t.state).toBe('yourCall');
      await press(bot, 42, buttonCode(calls, 'tc:')!);
      const prompt = calls.filter((c) => c.body.reply_markup?.force_reply).pop()!;
      expect(prompt.body.text).toContain('What should change?');
      await bot.handle({
        update_id: 2,
        message: {
          message_id: 77,
          chat: { id: 42, type: 'private' },
          text: 'Say Friday instead',
          reply_to_message: { message_id: 100 + calls.indexOf(prompt) },
        },
      });
      expect((await db.doc(inboxPaths.outcome(W, 'o1')).get()).data()).toMatchObject({
        state: 'revising',
        revise: { instruction: 'Say Friday instead' },
      });
    } finally {
      stop();
    }
  });

  it('a Development gate: Ask for changes sends the plan back to Build with the text', async () => {
    const now = harnessNow();
    await put({
      ...people(),
      [inboxPaths.thread(W, 'dt1')]: thread(),
      [inboxPaths.plan(W, 'pl1')]: {
        memberUid: 'alice',
        threadId: 'dt1',
        proposedBy: 'alice',
        steps: ['s1', 's2', 's3', 's4'],
        cursor: 3,
        state: 'active',
        note: '',
        templateId: 'dev',
        sendBackTo: { s2: 's1', s4: 's3' },
        createdAt: now,
        updatedAt: now,
        lastEventId: 'e1',
      },
      [inboxPaths.outcome(W, 's1')]: outcome({
        type: 'shape',
        fields: {},
        state: 'done',
        planId: 'pl1',
      }),
      [inboxPaths.outcome(W, 's2')]: outcome({
        type: 'approval',
        fields: { what: 'Approve idea' },
        state: 'done',
        executor: null,
        planId: 'pl1',
      }),
      [inboxPaths.outcome(W, 's3')]: outcome({
        type: 'build',
        fields: {},
        state: 'done',
        planId: 'pl1',
      }),
      [inboxPaths.outcome(W, 's4')]: outcome({
        type: 'approval',
        fields: { what: 'Ship it?' },
        executor: null,
        planId: 'pl1',
      }),
    });
    const { calls, bot, stop } = await start();
    try {
      await until(() => sent(calls, 'Ship release 175').length > 0);
      await press(bot, 42, buttonCode(calls, 'tc:')!);
      const prompt = calls.filter((c) => c.body.reply_markup?.force_reply).pop()!;
      await bot.handle({
        update_id: 3,
        message: {
          message_id: 78,
          chat: { id: 42, type: 'private' },
          text: 'The button is too small',
          reply_to_message: { message_id: 100 + calls.indexOf(prompt) },
        },
      });
      await until(async () => (await db.doc(inboxPaths.plan(W, 'pl1')).get()).data()!.cursor === 2);
      expect((await db.doc(inboxPaths.plan(W, 'pl1')).get()).data()).toMatchObject({
        cursor: 2,
        state: 'active',
        sentBack: { n: 1, to: 's3', reason: 'The button is too small', by: 'alice' },
      });
      expect((await db.doc(inboxPaths.outcome(W, 's3')).get()).data()!.state).toBe('approved');
      expect((await db.doc(inboxPaths.outcome(W, 's4')).get()).data()!.state).toBe('proposed');
    } finally {
      stop();
    }
  });

  it("an agent's question: its options are the buttons", async () => {
    const now = harnessNow();
    await put({
      ...people(),
      [inboxPaths.thread(W, 'dt1')]: bare({
        state: 'needsYou',
        title: 'Review date',
        question: {
          text: 'Which day suits you?',
          by: 'agentA',
          at: now,
          answer: null,
          answeredAt: null,
          options: ['Thursday', 'Friday'],
        },
      }),
    });
    const { calls, bot, stop } = await start();
    try {
      await until(() => sent(calls, 'Review date').length > 0);
      await press(bot, 42, buttonCode(calls, 'to1:')!);
      expect((await db.doc(inboxPaths.thread(W, 'dt1')).get()).data()).toMatchObject({
        state: 'investigating',
        question: { answer: 'Friday' },
      });
    } finally {
      stop();
    }
  });
});
