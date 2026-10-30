/**
 * The notifier against the real Firestore emulator: listeners feed the engine, Telegram messages
 * carry decision buttons, a button press approves through the same ActionPlan the app uses, a
 * reply sends back with a reason, and a one-time code links a chat.
 */
import { bellId, bellPath, inboxPaths, notifyPath, paths } from '@hive/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  atGate,
  I,
  itemDoc,
  minutesAgo,
  now as harnessNow,
  put,
  useEmulator,
  W,
} from '../../shared/rules/harness';
import { Engine } from '../src/engine';
import { ReachOut } from '../src/reach';
import { firestoreReachPorts } from '../src/reachStore';
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

describe('reach out end to end (item KZ6O9; Firestore emulator, fake clock)', () => {
  const ago = minutesAgo;
  const run = (itemId: string, startedAt: ReturnType<typeof minutesAgo>, hb = ago(1)) => ({
    agentUid: 'agentA',
    projectId: 'p1',
    itemId,
    stepId: 'draft',
    startedAt,
    heartbeatAt: hb,
    heartbeatEventAt: hb,
    endedAt: null,
    status: 'running',
    costEur: 0,
    tokensIn: 0,
    tokensOut: 0,
    model: null,
    summary: null,
    lastEventId: 'seed',
  });
  const event = (
    itemId: string,
    runId: string,
    type: string,
    at: ReturnType<typeof minutesAgo>,
  ) => ({
    actor: { type: 'agent', id: 'agentA', name: 'Agent A' },
    projectId: 'p1',
    itemId,
    runId,
    type,
    data: {},
    at,
  });
  const people = () => ({
    [notifyPath.telegram('alice')]: { chatId: 43, username: null, linkedAt: 1 },
    [notifyPath.prefs('alice')]: {
      push: false,
      telegram: true,
      digest: false,
      quiet: { enabled: false, from: '22:00', to: '08:00', tz: 'UTC' },
    },
    [paths.member(W, 'alice')]: { name: 'Alice', email: 'a@x.test', photoURL: null, color: 'c1' },
  });

  /** The notifier with reach out on real Firestore, its clock and timers under the test's control. */
  function start() {
    const { calls, bot } = fakeTelegram();
    const engine = new Engine(
      firestorePorts(db, {
        sendPush: async () => ({ result: 'error' as const, attempts: 0 }),
        sendTelegram: (c, n, a) => bot.send(c, n, a),
        log: () => undefined,
      }),
    );
    const skew = { ms: 0 };
    const timers = new Map<number, { at: number; fn: () => void }>();
    let id = 0;
    const real = firestoreReachPorts(db, engine, () => undefined);
    const reach = new ReachOut({
      ...real,
      now: () => Date.now() + skew.ms,
      setTimer: (fn, ms) => {
        timers.set(++id, { at: Date.now() + skew.ms + ms, fn });
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
    });
    /** Runs the timers due now (after moving the clock by `ms`). */
    const advance = (ms = 0) => {
      skew.ms += ms;
      const now = Date.now() + skew.ms;
      for (const [k, t] of [...timers]) {
        if (t.at > now) continue;
        timers.delete(k);
        t.fn();
      }
    };
    const stop = watchAll(
      db,
      engine,
      () => undefined,
      () => undefined,
      reach,
    );
    return { calls, bot, reach, advance, stop: () => (stop(), reach.stop()) };
  }

  it('quiet item: a status request, then silent with one message whose buttons ping and release', async () => {
    await put({
      ...people(),
      [paths.run(W, 'run-s')]: run('quiet', ago(45)),
      [I('quiet')]: itemDoc({
        title: 'Quiet one',
        stepId: 'draft',
        status: 'working',
        updatedAt: ago(45),
        claim: { runId: 'run-s', agentUid: 'agentA', heartbeatAt: ago(1) },
      }),
      // Heartbeats are not activity.
      [paths.event(W, 'hb-s')]: event('quiet', 'run-s', 'run.heartbeat', ago(2)),
      // Busy: a log line 5 minutes ago (not on the item), no status at all.
      [paths.run(W, 'run-l')]: run('logs', ago(60)),
      [paths.logLine(W, 'run-l', 0)]: { at: ago(5), level: 'info', text: 'Running tests' },
      [I('logs')]: itemDoc({
        title: 'Logging one',
        stepId: 'draft',
        status: 'working',
        updatedAt: ago(60),
        claim: { runId: 'run-l', agentUid: 'agentA', heartbeatAt: ago(1) },
      }),
    });
    const { calls, bot, advance, stop } = start();
    const item = async (iid: string) => (await db.doc(I(iid)).get()).data()!;
    try {
      // 45 min quiet: the timer is due at once; Hivenod's status request lands on the item.
      await until(async () => {
        advance();
        return !!(await item('quiet')).statusAsk;
      });
      expect((await item('quiet')).statusAsk).toMatchObject({ runId: 'run-s', byUid: 'hivenod' });
      // The busy one is not asked: its log line was found by the one read at its due time.
      advance();
      await new Promise((r) => setTimeout(r, 500));
      expect((await item('logs')).statusAsk ?? null).toBeNull();
      // No answer in 10 minutes: flagged, and Alice (the next decider) gets one message.
      const toAlice = () =>
        calls.filter((c) => c.method === 'sendMessage' && /is silent on/.test(c.body.text ?? ''));
      await until(async () => {
        advance(11 * 60_000);
        return toAlice().length > 0;
      });
      expect(toAlice()[0]!.body.text).toContain('Agent is silent on "Quiet one"');
      await until(async () => !!(await item('quiet')).silence);
      expect((await item('quiet')).silence).toMatchObject({ runId: 'run-s', agent: 'Agent' });
      const kb = JSON.stringify(toAlice()[0]!.body.reply_markup);
      expect(kb).toContain('Ping again');
      expect(kb).toContain('Release to queue');
      expect(kb).toContain('Stop');
      // Still silent: no second message on the next timers.
      advance(30 * 60_000);
      await new Promise((r) => setTimeout(r, 500));
      expect(toAlice()).toHaveLength(1);

      // Ping again: a fresh status request by Alice (the clock moved 40 min; the emulator's not).
      await db
        .doc(I('quiet'))
        .update({ 'statusAsk.at': Timestamp.fromMillis(Date.now() - 12 * 60_000) });
      await press(bot, 43, buttonCode(calls, 'rp:')!);
      await until(async () => (await item('quiet')).statusAsk?.byUid === 'alice');
      // Release to queue: the claim goes, a note says why, the flag is cleared.
      await press(bot, 43, buttonCode(calls, 'rr:')!);
      await until(async () => (await item('quiet')).status === 'queued');
      const after = await item('quiet');
      expect(after.claim).toBeNull();
      expect(after.silence).toBeNull();
      const notes = await db.collection(`${I('quiet')}/messages`).get();
      expect(notes.docs.map((d) => d.data().text).join(' ')).toMatch(
        /Alice put the item back in the queue from Telegram/,
      );
      // A second press: the item moved on.
      await press(bot, 43, buttonCode(calls, 'rr:')!);
      await until(() =>
        calls.some(
          (c) => c.method === 'answerCallbackQuery' && /moved on/.test(String(c.body.text)),
        ),
      );
    } finally {
      stop();
    }
  });

  it('a stale claim without a live session goes back to the queue with a note', async () => {
    await put({
      [paths.run(W, 'run-x')]: run('stale', ago(90), ago(45)),
      [I('stale')]: itemDoc({
        title: 'Stale one',
        stepId: 'draft',
        status: 'working',
        updatedAt: ago(90),
        claim: { runId: 'run-x', agentUid: 'agentA', heartbeatAt: ago(45) },
      }),
    });
    const { advance, stop } = start();
    try {
      await until(async () => {
        advance();
        return (await db.doc(I('stale')).get()).data()!.status === 'queued';
      });
      const it = (await db.doc(I('stale')).get()).data()!;
      expect(it.claim).toBeNull();
      expect((await db.doc(paths.run(W, 'run-x')).get()).data()!.status).toBe('released');
      const notes = await db.collection(`${I('stale')}/messages`).get();
      expect(notes.docs.map((d) => d.data().text).join(' ')).toMatch(
        /no live session .* Hivenod put the item back in the queue/,
      );
    } finally {
      stop();
    }
  });

  it('a thread step in agent hands: a status request on the outcome, then silent with Ping again · Open', async () => {
    const old = ago(40);
    await put({
      ...people(),
      [inboxPaths.thread(W, 'rt1')]: {
        memberUid: 'alice',
        subjectId: null,
        state: 'investigating',
        waiting: null,
        question: null,
        title: 'Invoice from the printer',
        refs: ['r1'],
        lastMessageAt: old,
        fetchedBy: 'agentA',
        createdAt: old,
        updatedAt: old,
        lastEventId: 'e1',
      },
      [inboxPaths.outcome(W, 'ro1')]: {
        memberUid: 'alice',
        threadId: 'rt1',
        type: 'reply',
        fields: { text: 'Paid, thanks.' },
        state: 'approved',
        note: '',
        proposedBy: 'agentA',
        executor: 'agentA',
        decision: { byUid: 'alice', at: old, edited: false, reason: null },
        result: null,
        createdAt: old,
        updatedAt: old,
        lastEventId: 'e1',
      },
    });
    const { calls, advance, stop } = start();
    const o = async () => (await db.doc(inboxPaths.outcome(W, 'ro1')).get()).data()!;
    try {
      await until(async () => {
        advance();
        return !!(await o()).statusAsk;
      });
      expect((await o()).statusAsk).toMatchObject({ byUid: 'hivenod' });
      await until(async () => {
        advance(11 * 60_000);
        return calls.some(
          (c) => c.method === 'sendMessage' && /is silent on/.test(c.body.text ?? ''),
        );
      });
      const msg = calls.find((c) => /is silent on/.test(c.body.text ?? ''))!.body;
      expect(msg.text).toContain('Agent is silent on "Invoice from the printer"');
      const kb = JSON.stringify(msg.reply_markup);
      expect(kb).toContain('Ping again');
      expect(kb).not.toContain('Release to queue');
      await until(async () => !!(await o()).silence);
      // The thread moving (a note by the agent) clears the flag at the next check.
      await db.doc(inboxPaths.outcome(W, 'ro1')).update({ updatedAt: Timestamp.now() });
      await until(async () => {
        advance();
        return (await o()).silence === null;
      });
    } finally {
      stop();
    }
  });
});
