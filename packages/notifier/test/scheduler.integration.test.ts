/**
 * The scheduler against the real Firestore emulator (scheduled tasks, slices 3 and 4): a schedule
 * due now fires exactly one run and one thread with its plan even with two schedulers running and
 * across a restart; a failed step becomes a can't-run ask; Run now retries it; and the Telegram
 * buttons (Run now, Try later in 1 hour / a typed time, Skip) decide through decideRun.
 */
import {
  inboxPaths,
  localClock,
  notifyPath,
  paths,
  runDocId,
  schedulePaths,
  SCHEDULER_BEAT_PATH,
  type Notice,
} from '@hive/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { useEmulator, W } from '../../shared/rules/harness';
import { Scheduler, type RunTelegram } from '../src/scheduler';
import { runIds, schedulerPorts, watchSchedules } from '../src/schedulerStore';
import { TelegramApi, TelegramBot } from '../src/telegram';

useEmulator();

let db: Firestore;
beforeAll(() => {
  db = getFirestore(getApps()[0] ?? initializeApp({ projectId: 'hive-rules-test' }));
});

const L = 'Europe/Lisbon';
/** Writes docs with the Admin SDK (its own Timestamps). */
const put = async (docs: Record<string, Record<string, unknown>>) => {
  for (const [path, data] of Object.entries(docs)) await db.doc(path).set(data);
};
const until = async (f: () => Promise<boolean> | boolean, what = 'condition') => {
  for (let i = 0; i < 150; i++) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Told {
  uid: string;
  notice: Notice;
  action?: RunTelegram;
}

function boot() {
  const told: Told[] = [];
  const s = new Scheduler(
    schedulerPorts(db, {
      log: (l) => (process.env.SCHED_DEBUG ? console.log(l) : undefined),
      tell: async (uid, notice, action) => {
        told.push({ uid, notice, action });
        return 'sent';
      },
    }),
  );
  const stop = watchSchedules(db, s, () => undefined);
  void s.start();
  return {
    s,
    told,
    stop: () => {
      s.stop();
      stop();
    },
  };
}

/** A daily schedule of alice's, due a minute ago (so it fires at once), run by agentA. */
async function seedSchedule(sid = 's1', weekly = false) {
  const now = Date.now();
  const at = localClock(now - 60_000, L);
  const day = new Date(now - 60_000).toLocaleDateString('en-US', {
    timeZone: L,
    weekday: 'short',
  }) as string;
  const iso = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day) + 1;
  await put({
    [paths.member(W, 'alice')]: { name: 'Alice', role: 'member' },
    [`workspaces/${W}/agents/agentA`]: {
      name: 'Hive',
      color: '#000',
      projectIds: '*',
      createdBy: 'owner',
      createdAt: Timestamp.now(),
      revokedAt: null,
      lastSeenAt: Timestamp.fromMillis(now),
      cliVersion: '0.2.300',
      tokenHint: 'x',
      previousAgentUid: null,
      lastEventId: 'seed',
    },
    [schedulePaths.schedule(W, sid)]: {
      memberUid: 'alice',
      agentUid: 'agentA',
      title: 'Inbox clean-up',
      what: 'Archive what is done.',
      rule: weekly ? { freq: 'weekly', weekdays: [iso], at, tz: L } : { freq: 'daily', at, tz: L },
      runTitle: 'Clean-up · {period}',
      steps: [
        { type: 'reply', fields: { text: 'Done for {period}' } },
        { type: 'approval', fields: { what: 'Archive them' } },
      ],
      templateId: null,
      subjectId: null,
      state: 'active',
      activeFrom: Timestamp.fromMillis(now - 5 * 60_000),
      proposal: null,
      replaces: null,
      version: 1,
      createdBy: { type: 'human', id: 'alice' },
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      lastEventId: 'e0',
    },
  });
}

const runsOf = async (sid: string) =>
  (await db.collection(`workspaces/${W}/scheduleRuns`).where('scheduleId', '==', sid).get()).docs;
const threadsOf = async (sid: string) =>
  (
    await db
      .collection(`workspaces/${W}/inboxThreads`)
      .where('schedule.scheduleId', '==', sid)
      .get()
  ).docs;

describe('scheduler end to end', () => {
  it('fires one run and one thread with its plan, with two schedulers and across a restart', async () => {
    await seedSchedule();
    const a = boot();
    const b = boot();
    try {
      await until(async () => (await threadsOf('s1')).length > 0, 'the run thread');
      await sleep(1500);
      const runs = await runsOf('s1');
      const threads = await threadsOf('s1');
      expect(runs.length).toBe(1);
      expect(threads.length).toBe(1);
      const run = runs[0]!.data();
      expect(run).toMatchObject({
        state: 'fired',
        attempts: 1,
        memberUid: 'alice',
        agentUid: 'agentA',
      });
      const t = threads[0]!;
      const ids = runIds('s1', run.key, 2, 1);
      expect(t.id).toBe(ids.threadId);
      expect(t.data()).toMatchObject({
        memberUid: 'alice',
        fetchedBy: 'agentA',
        title: `Clean-up · ${run.period}`,
        schedule: { scheduleId: 's1', runKey: run.key },
      });
      const plan = (await db.doc(inboxPaths.plan(W, ids.planId)).get()).data()!;
      expect(plan).toMatchObject({ state: 'active', cursor: 0, steps: ids.stepIds });
      const [s1, s2] = await Promise.all(
        ids.stepIds.map((o) => db.doc(inboxPaths.outcome(W, o)).get()),
      );
      expect(s1!.data()).toMatchObject({
        state: 'approved',
        executor: 'agentA',
        fields: { text: `Done for ${run.period}` },
      });
      expect(s2!.data()).toMatchObject({ state: 'proposed', type: 'approval' });
      const created = await db
        .collection(`workspaces/${W}/inboxEvents`)
        .where('type', '==', 'thread.created')
        .get();
      expect(created.docs.length).toBe(1);
      expect((await db.doc(SCHEDULER_BEAT_PATH).get()).data()?.beatAt).toBeDefined();
    } finally {
      a.stop();
      b.stop();
    }
    // A restart: the new scheduler finds the period's run and fires nothing.
    const c = boot();
    try {
      await sleep(2000);
      expect((await runsOf('s1')).length).toBe(1);
      expect((await threadsOf('s1')).length).toBe(1);
    } finally {
      c.stop();
    }
  });

  it('a failed step is asked about; Run now retries it on the same thread', async () => {
    await seedSchedule('s1', true);
    const a = boot();
    try {
      await until(async () => (await threadsOf('s1')).length > 0, 'the run thread');
      const run = (await runsOf('s1'))[0]!;
      const ids = runIds('s1', run.data().key, 2, 1);
      // The agent reports step 1 failed: the plan blocks (as outcome_done failed does).
      await db.doc(inboxPaths.outcome(W, ids.stepIds[0]!)).update({
        state: 'failed',
        result: {
          text: null,
          permalink: null,
          itemId: null,
          error: 'the portal was down',
          by: 'agentA',
          at: Timestamp.now(),
        },
      });
      await db
        .doc(inboxPaths.plan(W, ids.planId))
        .update({ state: 'blocked', updatedAt: Timestamp.now() });
      await until(async () => (await run.ref.get()).data()?.state === 'cantRun', 'cantRun');
      expect((await run.ref.get()).data()!.why).toEqual({
        code: 'failed',
        text: 'Hive could not do it: the portal was down',
      });
      // Weekly: asked once, at once.
      await until(
        () => a.told.some((x) => x.notice.title === "Weekly run didn't happen"),
        'the ask',
      );
      const ask = a.told.find((x) => x.notice.title === "Weekly run didn't happen")!;
      expect(ask.notice.body).toContain('Why: Hive could not do it: the portal was down');
      expect(ask.action).toMatchObject({ kind: 'run', uid: 'alice', runs: [{ runId: run.id }] });
      expect((await run.ref.get()).data()!.ask).toMatchObject({ level: 'normal', n: 1 });
      // Run now (as the web or Telegram writes it): the step is retried, the run fires again.
      await run.ref.update({
        state: 'runNow',
        decision: { choice: 'runNow', by: 'alice', at: Timestamp.now(), via: 'web' },
      });
      await until(async () => (await run.ref.get()).data()?.state === 'fired', 'fired again');
      expect((await run.ref.get()).data()!.attempts).toBe(2);
      await until(
        async () => (await db.doc(inboxPaths.plan(W, ids.planId)).get()).data()?.state === 'active',
        'plan active',
      );
      expect((await db.doc(inboxPaths.outcome(W, ids.stepIds[0]!)).get()).data()!.state).toBe(
        'approved',
      );
      expect((await threadsOf('s1')).length).toBe(1);
    } finally {
      a.stop();
    }
  });

  it('Run now on a run that could not start fires its thread', async () => {
    await seedSchedule();
    // Off was on at its time: the run exists as cantRun, with no thread.
    await put({
      [schedulePaths.off(W, 'alice')]: {
        all: true,
        agents: [],
        since: Timestamp.now(),
        updatedAt: Timestamp.now(),
        lastEventId: 'x',
      },
    });
    const a = boot();
    try {
      await until(async () => (await runsOf('s1')).length > 0, 'the run');
      const run = (await runsOf('s1'))[0]!;
      expect(run.data()).toMatchObject({ state: 'cantRun', why: { code: 'off' }, threadId: null });
      expect((await threadsOf('s1')).length).toBe(0);
      await db.doc(schedulePaths.off(W, 'alice')).delete();
      await run.ref.update({
        state: 'runNow',
        decision: { choice: 'runNow', by: 'alice', at: Timestamp.now(), via: 'web' },
      });
      await until(async () => (await threadsOf('s1')).length === 1, 'the thread');
      expect((await run.ref.get()).data()).toMatchObject({ state: 'fired', attempts: 1 });
    } finally {
      a.stop();
    }
  });
});

describe('the Telegram buttons of a run', () => {
  function fakeBot() {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let nextId = 100;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: nextId++ } }) };
    }) as unknown as typeof fetch;
    const bot = new TelegramBot(
      new TelegramApi('T', fetchImpl),
      db,
      'https://app.test',
      () => Date.now(),
      () => undefined,
    );
    return { calls, bot };
  }
  const codeOf = (calls: { body: Record<string, unknown> }[], prefix: string) => {
    const rows = calls.flatMap(
      (c) =>
        (c.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] })
          ?.inline_keyboard ?? [],
    );
    return rows
      .flat()
      .map((b) => b.callback_data ?? '')
      .filter((d) => d.startsWith(prefix))
      .pop()!;
  };
  const press = (bot: TelegramBot, data: string) =>
    bot.handle({
      update_id: 1,
      callback_query: {
        id: 'cb',
        from: { id: 42 },
        data,
        message: { message_id: 5, chat: { id: 42 } },
      },
    });
  const lastText = (calls: { method: string; body: Record<string, unknown> }[]) =>
    String(
      [...calls].reverse().find((c) => c.method === 'sendMessage' || c.body.text)?.body.text ?? '',
    );

  async function cantRun(id: string) {
    const now = Timestamp.now();
    await put({
      [paths.member(W, 'alice')]: { name: 'Alice', role: 'member' },
      [notifyPath.telegram('alice')]: { chatId: 42, username: null, linkedAt: 1 },
      [notifyPath.prefs('alice')]: {
        push: false,
        telegram: true,
        digest: false,
        quiet: { enabled: false, from: '22:00', to: '08:00', tz: L },
      },
      [schedulePaths.run(W, id)]: {
        memberUid: 'alice',
        scheduleId: 's1',
        agentUid: 'agentA',
        key: '2026-11',
        period: 'Nov 2026',
        dueAt: now,
        title: 'Send invoices',
        state: 'cantRun',
        why: { code: 'offline', text: 'Hive was offline.' },
        threadId: null,
        attempts: 0,
        laterAt: null,
        firedAt: null,
        startedAt: null,
        endedAt: null,
        ask: null,
        decision: null,
        scheduleVersion: 1,
        createdAt: now,
        updatedAt: now,
        lastEventId: 'e0',
      },
    });
  }
  const send = (bot: TelegramBot, id: string) =>
    bot.send(
      42,
      { title: "Important · Monthly run didn't happen", body: 'Why: Hive was offline.', url: '/' },
      {
        kind: 'run',
        uid: 'alice',
        runs: [{ wid: W, runId: id, title: 'Send invoices' }],
      },
    );

  it('Skip, then a second tap says when it was decided', async () => {
    const id = runDocId('s1', '2026-11');
    await cantRun(id);
    const { calls, bot } = fakeBot();
    await send(bot, id);
    const keyboard = (calls[0]!.body.reply_markup as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    expect(keyboard.map((r) => r.map((b) => b.text))).toEqual([
      ['Run now', 'Try later'],
      ['Skip this one', 'Open'],
    ]);
    const skip = codeOf(calls, 'xs:');
    await press(bot, skip);
    const run = (await db.doc(schedulePaths.run(W, id)).get()).data()!;
    expect(run).toMatchObject({
      state: 'skipped',
      decision: { choice: 'skip', by: 'alice', via: 'telegram' },
    });
    expect(lastText(calls)).toBe('Skipped “Send invoices” for Nov 2026.');
    await press(bot, codeOf(calls, 'xn:'));
    const alert = calls.filter((c) => c.method === 'answerCallbackQuery').pop()!;
    expect(String(alert.body.text)).toMatch(/^Decided at \d\d:\d\d \(Skip\)\.$/);
  });

  it('Try later: in 1 hour, or a typed time', async () => {
    const id = runDocId('s1', '2026-11');
    await cantRun(id);
    const { calls, bot } = fakeBot();
    await send(bot, id);
    await press(bot, codeOf(calls, 'xl:'));
    expect(lastText(calls)).toBe('Try “Send invoices” again when?');
    const before = Date.now();
    await press(bot, codeOf(calls, 'xh:'));
    const run = (await db.doc(schedulePaths.run(W, id)).get()).data()!;
    expect(run.state).toBe('later');
    expect(run.laterAt.toMillis()).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
    expect(run.laterAt.toMillis()).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000);

    // A typed time: "tomorrow 10:00".
    const id2 = runDocId('s1', '2026-12');
    await cantRun(id2);
    await send(bot, id2);
    await press(bot, codeOf(calls, 'xl:'));
    await press(bot, codeOf(calls, 'xp:'));
    expect(lastText(calls)).toContain('Reply with a time');
    await bot.handle({
      update_id: 2,
      message: {
        message_id: 9,
        chat: { id: 42, type: 'private' },
        text: 'next year',
        reply_to_message: { message_id: nextPrompt(calls) },
      },
    });
    expect(lastText(calls)).toContain('could not read that time');
    await bot.handle({
      update_id: 3,
      message: {
        message_id: 10,
        chat: { id: 42, type: 'private' },
        text: 'tomorrow 10:00',
        reply_to_message: { message_id: nextPrompt(calls) },
      },
    });
    const r2 = (await db.doc(schedulePaths.run(W, id2)).get()).data()!;
    expect(r2.state).toBe('later');
    expect(localClock(r2.laterAt.toMillis(), L)).toBe('10:00');
    expect(lastText(calls)).toMatch(/^I’ll try “Send invoices” again .* at 10:00\.$/);
  });

  it('Run now', async () => {
    const id = runDocId('s1', '2026-11');
    await cantRun(id);
    const { calls, bot } = fakeBot();
    await send(bot, id);
    await press(bot, codeOf(calls, 'xn:'));
    expect((await db.doc(schedulePaths.run(W, id)).get()).data()).toMatchObject({
      state: 'runNow',
      decision: { choice: 'runNow' },
    });
    expect(lastText(calls)).toBe('Running “Send invoices” now.');
  });
});

/** The message id of the force-reply prompt (the fake API numbers messages from 100). */
function nextPrompt(calls: { method: string; body: Record<string, unknown> }[]): number {
  const i = calls.findIndex((c) => String(c.body.text ?? '').includes('Reply with a time'));
  return 100 + i;
}
