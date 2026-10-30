import {
  DEFAULT_NOTIFY_PREFS,
  type BellEntry,
  type Notice,
  type Notified,
  type NotifyPrefs,
} from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { threadKeyboard } from './telegram';
import { Engine, threadAction, type InboxWaiting, type Ports } from './engine';

const H = 3_600_000;

function world(over: { prefs?: Record<string, NotifyPrefs> } = {}) {
  const t = { now: Date.UTC(2026, 0, 10, 12, 0, 0) };
  const sentPush: { endpoint: string; notice: Notice }[] = [];
  const sentTg: { chatId: number; notice: Notice; hasAction: boolean; action?: unknown }[] = [];
  const store = new Map<string, Notified>();
  const deleted: string[] = [];
  const bells = new Map<string, BellEntry>();
  const ports: Ports = {
    addBell: async (uid, id, entry) => {
      if (!bells.has(`${uid}/${id}`)) bells.set(`${uid}/${id}`, entry);
    },
    now: () => t.now,
    getPrefs: async (uid) => over.prefs?.[uid] ?? DEFAULT_NOTIFY_PREFS,
    getPushSubs: async (uid) =>
      uid === 'nopush'
        ? []
        : [
            {
              id: `${uid}-s`,
              sub: {
                endpoint: `https://p/${uid}`,
                keys: { p256dh: 'a', auth: 'b' },
                label: '',
                createdAt: 0,
              },
            },
          ],
    deletePushSub: async (_u, id) => void deleted.push(id),
    getTelegram: async (uid) => (uid === 'ana' ? { chatId: 7, username: null, linkedAt: 0 } : null),
    getNotified: async (w, k) => store.get(`${w}/${k}`) ?? null,
    setNotified: async (w, k, v) => void store.set(`${w}/${k}`, v),
    sendPush: async (sub, notice) => {
      if (sub.endpoint.endsWith('/gone')) return { result: 'gone', status: 410, attempts: 1 };
      sentPush.push({ endpoint: sub.endpoint, notice });
      return { result: 'ok', status: 201, attempts: 1 };
    },
    sendTelegram: async (chatId, notice, action) => {
      sentTg.push({ chatId, notice, hasAction: !!action, action });
      return true;
    },
    log: () => undefined,
  };
  return {
    t,
    ports,
    thread: (over: Partial<InboxWaiting> = {}): InboxWaiting => ({
      wid: 'w',
      tid: 't1',
      memberUid: 'ana',
      state: 'needsYou',
      title: 'Move the review to Thursday?',
      subjectName: 'Review dates (Payments)',
      text: 'Is Thursday 10:00 fine?',
      byName: 'Payments agent',
      arrival: 'q1',
      sinceMs: t.now - 60_000,
      urgent: false,
      ...over,
    }),
    sentPush,
    sentTg,
    store,
    deleted,
    bells,
    engine: new Engine(ports),
  };
}

describe('quiet hours', () => {
  const quiet = {
    ...DEFAULT_NOTIFY_PREFS,
    quiet: { enabled: true, from: '11:00', to: '13:00', tz: 'UTC' },
  };
  it('holds the message and sends it when the window ends', async () => {
    const w = world({ prefs: { ana: quiet } });
    w.engine.setInbox(w.thread(), 't1');
    w.engine.setInbox(w.thread({ tid: 't2', memberUid: 'bo' }), 't2');
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.endpoint)).toEqual(['https://p/bo']);
    expect(w.bells.size).toBe(2); // the bell is not held
    w.t.now += 2 * H; // 14:00, quiet is over; the engine caches prefs for a minute only
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.endpoint)).toEqual(['https://p/bo', 'https://p/ana']);
  });
  it('sends one summary when many were held', async () => {
    const w = world({ prefs: { ana: quiet } });
    for (let i = 0; i < 5; i++) w.engine.setInbox(w.thread({ tid: `t${i}` }), `k${i}`);
    await w.engine.sweep();
    w.t.now += 2 * H;
    await w.engine.sweep();
    const toAna = w.sentPush.filter((p) => p.endpoint === 'https://p/ana');
    expect(toAna).toHaveLength(1);
    expect(toAna[0]!.notice.title).toBe('5 things need you');
  });
});

describe('push failures', () => {
  const fail = { result: 'error' as const, status: 503, detail: 'unavailable', attempts: 3 };
  it('does not mark the arrival sent while every push fails, and logs each send', async () => {
    const w = world();
    const logs: string[] = [];
    w.ports.log = (l) => void logs.push(l);
    const ok = w.ports.sendPush;
    w.ports.sendPush = async () => fail;
    w.engine.setInbox(w.thread(), 't1');
    await w.engine.sweep();
    expect(w.store.get('w/i-t1')!.sent).toEqual([]);
    expect(logs.some((l) => l.includes('push error uid=ana sub=ana-s status=503'))).toBe(true);
    // Telegram (ana only) went out once and is not repeated on the retry.
    expect(w.sentTg).toHaveLength(1);
    w.ports.sendPush = ok;
    await w.engine.sweep();
    expect(w.store.get('w/i-t1')!.sent).toEqual(['ana']);
    expect(w.sentTg).toHaveLength(1);
    expect(w.sentPush).toHaveLength(1);
    expect(logs.some((l) => l.includes('push ok uid=ana sub=ana-s status=201'))).toBe(true);
  });
  it('forgets dead push endpoints', async () => {
    const w = world();
    w.ports.getPushSubs = async () => [
      {
        id: 'dead',
        sub: {
          endpoint: 'https://p/gone',
          keys: { p256dh: 'a', auth: 'b' },
          label: '',
          createdAt: 0,
        },
      },
    ];
    w.engine.setInbox(w.thread(), 't1');
    await w.engine.sweep();
    expect(w.deleted).toContain('dead');
  });
  it('gives up after a few sweeps instead of retrying forever', async () => {
    const w = world();
    w.ports.sendPush = async () => fail;
    w.engine.setInbox(w.thread(), 't1');
    for (let i = 0; i < 5; i++) await w.engine.sweep();
    expect(w.store.get('w/i-t1')!.sent).toEqual(['ana']);
  });
});

describe('inbox threads (item 4PEHr)', () => {
  const thread = (w: ReturnType<typeof world>, over: Partial<InboxWaiting> = {}): InboxWaiting => ({
    wid: 'w',
    tid: 't1',
    memberUid: 'ana',
    state: 'needsYou',
    title: 'Move the review to Thursday?',
    subjectName: 'Review dates (Payments)',
    text: 'Is Thursday 10:00 fine?',
    byName: 'Payments agent',
    arrival: 'q1',
    sinceMs: w.t.now - 60_000,
    urgent: false,
    ...over,
  });

  it('a question tells its member alone, once, on the bell, push and Telegram', async () => {
    const w = world();
    w.engine.setInbox(thread(w), 't1');
    await w.engine.sweep();
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.endpoint)).toEqual(['https://p/ana']);
    expect(w.sentPush[0]!.notice.url).toBe('/inbox/w/t/t1');
    expect(w.sentPush[0]!.notice.title).toBe('Needs you: Move the review to Thursday?');
    expect(w.sentTg).toEqual([expect.objectContaining({ chatId: 7, hasAction: false })]);
    const bell = [...w.bells.entries()];
    expect(bell).toHaveLength(1);
    expect(bell[0]![0]).toBe('ana/i-t1-q1');
    expect(bell[0]![1]).toMatchObject({
      kind: 'inboxAsk',
      projectId: 'inbox',
      itemId: 't1',
      projectName: 'Inbox · Review dates (Payments)',
      actorName: 'Payments agent',
    });
  });

  it('a new round (Your call after the answer) is a new arrival', async () => {
    const w = world();
    w.engine.setInbox(thread(w), 't1');
    await w.engine.sweep();
    w.engine.setInbox(thread(w, { state: 'yourCall', arrival: 'c2', text: 'Reply, Snooze' }), 't1');
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.notice.title)).toEqual([
      'Needs you: Move the review to Thursday?',
      'Your call: Move the review to Thursday?',
    ]);
    expect([...w.bells.values()].map((b) => b.kind)).toEqual(['inboxAsk', 'inboxCall']);
  });

  it('an old arrival goes to the bell only; nobody else is ever told', async () => {
    const w = world();
    w.engine.setInbox(thread(w, { sinceMs: w.t.now - 3 * H }), 't1');
    w.engine.setInbox(null, 't1');
    w.engine.setInbox(thread(w, { sinceMs: w.t.now - 3 * H }), 't1');
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(0);
    expect([...w.bells.keys()]).toEqual(['ana/i-t1-q1']);
  });

  it('quiet hours hold it back, but an urgent thread goes out at once', async () => {
    const quiet = {
      ...DEFAULT_NOTIFY_PREFS,
      quiet: { enabled: true, from: '11:00', to: '13:00', tz: 'UTC' },
    };
    const w = world({ prefs: { ana: quiet } });
    w.engine.setInbox(thread(w), 't1');
    w.engine.setInbox(thread(w, { tid: 't2', urgent: true, arrival: 'q9' }), 't2');
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.notice.title)).toEqual([
      'Urgent · Needs you: Move the review to Thursday?',
    ]);
  });
});
describe('decision points on threads (slice 3, design 9b)', () => {
  const gate = {
    kind: 'step' as const,
    key: 's:p1:o2',
    planId: 'p1',
    outcomeId: 'o2',
    gate: true,
    number: 4,
    total: 6,
    type: 'approval',
    what: 'Ship it?',
  };
  const summary = {
    headline: 'Release 175 is ready',
    ask: 'Ship release 175 to hivenod.com?',
    answer: 'Everything passed: 612 of 612 checks',
    recAction: 'Approve',
    confidence: 'high',
  };
  const thread = (w: ReturnType<typeof world>, over: Partial<InboxWaiting> = {}): InboxWaiting => ({
    wid: 'w',
    tid: 't1',
    memberUid: 'ana',
    state: 'yourCall',
    title: 'Release 175',
    subjectName: 'Hivenod',
    text: 'Ship it? · step 4 of 6',
    byName: 'Hive',
    arrival: gate.key,
    sinceMs: w.t.now - 60_000,
    urgent: false,
    ask: gate,
    summary,
    summaryFresh: true,
    agentName: 'Hive',
    ...over,
  });

  it('the one-liner on top, the recommendation under it, the quick actions on Telegram', async () => {
    const w = world();
    w.engine.setInbox(thread(w), 't1');
    await w.engine.sweep();
    expect(w.sentPush[0]!.notice).toMatchObject({
      title: 'Ship release 175 to hivenod.com?',
      body: 'Hive recommends Approve · confidence high',
      url: '/inbox/w/t/t1',
    });
    expect(w.sentTg[0]!.notice.title).toBe('Ship release 175 to hivenod.com?');
    expect(w.sentTg[0]!.action).toEqual({
      kind: 'thread',
      wid: 'w',
      tid: 't1',
      uid: 'ana',
      arrival: 's:p1:o2',
      ask: 'step',
      options: [],
    });
  });

  it('without a fresh summary: the app line, still with the buttons', async () => {
    const w = world();
    w.engine.setInbox(thread(w, { summaryFresh: false }), 't1');
    await w.engine.sweep();
    expect(w.sentPush[0]!.notice.title).toBe('Your call: Release 175');
    expect(w.sentPush[0]!.notice.body).toBe('Hivenod · Ship it? · step 4 of 6');
    expect(w.sentTg[0]!.hasAction).toBe(true);
  });

  it('waits for the summary that follows a change, then tells once', async () => {
    const w = world();
    w.engine.setInbox(thread(w, { summaryFresh: false, holdUntil: w.t.now + 30_000 }), 't1');
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(0);
    expect(w.bells.size).toBe(0);
    w.engine.setInbox(thread(w), 't1');
    await w.engine.sweep();
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.notice.title)).toEqual(['Ship release 175 to hivenod.com?']);
  });

  it('the next step at its turn is a new arrival; a blocked plan has no quick actions', async () => {
    const w = world();
    w.engine.setInbox(thread(w), 't1');
    await w.engine.sweep();
    const next = { ...gate, key: 's:p1:o3', outcomeId: 'o3', number: 5 };
    w.engine.setInbox(thread(w, { ask: next, arrival: next.key }), 't1');
    await w.engine.sweep();
    expect(w.sentTg).toHaveLength(2);
    const retry = { kind: 'retry' as const, key: 'r:p1:4', planId: 'p1', number: 5, total: 6 };
    expect(threadAction(thread(w, { ask: retry, arrival: retry.key }))).toBeUndefined();
  });

  it('a question offers its answers as buttons', () => {
    const w = world();
    const q = {
      kind: 'question' as const,
      key: 'q1',
      text: 'Which day?',
      options: ['Thu', 'Fri', 'Mon'],
    };
    const a = threadAction(thread(w, { state: 'needsYou', ask: q, arrival: 'q1' }))!;
    expect(threadKeyboard('CODE', a, 'https://app/x')).toEqual([
      [
        { text: 'Thu', callback_data: 'to0:CODE' },
        { text: 'Fri', callback_data: 'to1:CODE' },
      ],
      [{ text: 'Mon', callback_data: 'to2:CODE' }],
      [
        { text: 'Reply', callback_data: 'tr:CODE' },
        { text: 'Not now', callback_data: 'tn:CODE' },
      ],
      [{ text: 'Open', url: 'https://app/x' }],
    ]);
    expect(threadKeyboard('CODE', threadAction(thread(w))!, 'https://app/x')).toEqual([
      [
        { text: 'Approve', callback_data: 'ta:CODE' },
        { text: 'Not now', callback_data: 'tn:CODE' },
      ],
      [
        { text: 'Ask for changes', callback_data: 'tc:CODE' },
        { text: 'Open', url: 'https://app/x' },
      ],
    ]);
  });
});
