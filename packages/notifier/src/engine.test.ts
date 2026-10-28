import {
  DEFAULT_NOTIFY_PREFS,
  type BellEntry,
  type Item,
  type Notice,
  type Notified,
  type NotifyPrefs,
  type Project,
} from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { Engine, type InboxWaiting, type Ports, type WaitingItem } from './engine';

const H = 3_600_000;
const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });

function world(over: { prefs?: Record<string, NotifyPrefs>; remindAfterHours?: number } = {}) {
  const t = { now: Date.UTC(2026, 0, 10, 12, 0, 0) };
  const sentPush: { endpoint: string; notice: Notice }[] = [];
  const sentTg: { chatId: number; notice: Notice; hasAction: boolean }[] = [];
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
      sentTg.push({ chatId, notice, hasAction: !!action });
      return true;
    },
    log: () => undefined,
  };
  const project = {
    name: 'Blog',
    memberUids: ['ana', 'bo'],
    steps: [
      { id: 'draft', name: 'Draft', kind: 'agent', description: '' },
      {
        id: 'review',
        name: 'Review',
        kind: 'human',
        description: '',
        gate: {
          deciderUids: ['ana', 'bo'],
          groupIds: [],
          rule: 'any',
          n: 1,
          mustInclude: [],
          rejectPolicy: 'one',
          remindAfterHours: over.remindAfterHours ?? 24,
        },
      },
    ],
  } as unknown as Project;
  const waiting = (arrivedAgo: number, extra: Partial<Item> = {}, gate = {}): WaitingItem => ({
    wid: 'w',
    pid: 'p',
    iid: 'i1',
    project,
    item: {
      title: 'Post',
      stepId: 'review',
      status: 'waiting',
      sendBackCount: 0,
      updatedAt: ts(t.now - arrivedAgo),
      gate: { stepId: 'review', approvals: {}, rejections: {}, ...gate },
      ...extra,
    } as unknown as Item,
  });
  return {
    t,
    ports,
    project,
    waiting,
    sentPush,
    sentTg,
    store,
    deleted,
    bells,
    engine: new Engine(ports),
  };
}

describe('arrival at a gate', () => {
  it('tells each decider once, on every channel they have, with a deep link', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.endpoint).sort()).toEqual(['https://p/ana', 'https://p/bo']);
    expect(w.sentPush[0]!.notice.url).toBe('/p/p?item=i1');
    expect(w.sentPush[0]!.notice.title).toContain('Needs your approval');
    expect(w.sentTg).toHaveLength(1);
    expect(w.sentTg[0]).toMatchObject({ chatId: 7, hasAction: true });
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(2);
    expect(w.sentTg).toHaveLength(1);
  });
  it('skips people who already voted and respects their channel choice', async () => {
    const w = world({ prefs: { ana: { ...DEFAULT_NOTIFY_PREFS, push: false } } });
    w.engine.setWaiting(
      w.waiting(60_000, {}, { approvals: { bo: { at: ts(0), rationale: '' } } }),
      'a',
    );
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(0);
    expect(w.sentTg).toHaveLength(1);
  });
  it('records an old arrival without a message', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(3 * H), 'a');
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(0);
    expect(w.store.get('w/g-i1')!.sent).toEqual(['ana', 'bo']);
  });
  it('a new arrival after a send back is told again', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    w.engine.setWaiting(w.waiting(60_000, { sendBackCount: 1 }), 'a');
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(4);
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
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    expect(w.deleted).toContain('dead');
  });
});

describe('quiet hours', () => {
  const quiet = {
    ...DEFAULT_NOTIFY_PREFS,
    quiet: { enabled: true, from: '11:00', to: '13:00', tz: 'UTC' },
  };
  it('holds the message and sends it when the window ends', async () => {
    const w = world({ prefs: { ana: quiet } });
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.endpoint)).toEqual(['https://p/bo']);
    w.t.now += 2 * H; // 14:00, quiet is over; the engine caches prefs for a minute only
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.endpoint)).toEqual(['https://p/bo', 'https://p/ana']);
  });
  it('sends one summary when many were held', async () => {
    const w = world({ prefs: { ana: quiet } });
    for (let i = 0; i < 5; i++) {
      const x = w.waiting(60_000);
      w.engine.setWaiting({ ...x, iid: `i${i}` }, `k${i}`);
    }
    await w.engine.sweep();
    w.t.now += 2 * H;
    await w.engine.sweep();
    const toAna = w.sentPush.filter((p) => p.endpoint === 'https://p/ana');
    expect(toAna).toHaveLength(1);
    expect(toAna[0]!.notice.title).toBe('5 things need you');
  });
});

describe('reminders', () => {
  it('fire once after remindAfterHours and set remindedAt', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(25 * H), 'a'); // old: arrival recorded silently
    await w.engine.sweep();
    expect(w.sentPush.map((p) => p.notice.title)).toEqual([
      'Still waiting: Post',
      'Still waiting: Post',
    ]);
    expect(w.store.get('w/g-i1')!.remindedAt).toBe(w.t.now);
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(2);
  });
  it('do not fire before the time or when remindAfterHours is 0', async () => {
    const early = world();
    early.engine.setWaiting(early.waiting(5 * H), 'a');
    await early.engine.sweep();
    expect(early.sentPush).toHaveLength(0);
    const off = world({ remindAfterHours: 0 });
    off.engine.setWaiting(off.waiting(90 * H), 'a');
    await off.engine.sweep();
    expect(off.sentPush).toHaveLength(0);
  });
  it('are not marked sent when nobody could be reached', async () => {
    const w = world({
      prefs: {
        ana: { ...DEFAULT_NOTIFY_PREFS, push: false, telegram: false },
        bo: { ...DEFAULT_NOTIFY_PREFS, push: false, telegram: false },
      },
    });
    w.engine.setWaiting(w.waiting(30 * H), 'a');
    await w.engine.sweep();
    expect(w.store.get('w/g-i1')!.remindedAt).toBeNull();
  });
});

describe('questions', () => {
  it('tell the project people once with a link to the item', async () => {
    const w = world();
    w.engine.setQuestion(
      {
        wid: 'w',
        pid: 'p',
        iid: 'i9',
        mid: 'm1',
        project: w.project,
        itemTitle: 'Post',
        text: 'Which tone?',
        atMs: w.t.now - 1000,
      },
      'q',
    );
    await w.engine.sweep();
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(2);
    expect(w.sentPush[0]!.notice).toMatchObject({ url: '/p/p?item=i9' });
    expect(w.sentPush[0]!.notice.title).toContain('Question');
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
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    expect(w.store.get('w/g-i1')!.sent).toEqual([]);
    expect(logs.some((l) => l.includes('push error uid=ana sub=ana-s status=503'))).toBe(true);
    // Telegram (ana only) went out once and is not repeated on the retry.
    expect(w.sentTg).toHaveLength(1);
    w.ports.sendPush = ok;
    await w.engine.sweep();
    expect(w.store.get('w/g-i1')!.sent.sort()).toEqual(['ana', 'bo']);
    expect(w.sentTg).toHaveLength(1);
    expect(w.sentPush).toHaveLength(2);
    expect(logs.some((l) => l.includes('push ok uid=bo sub=bo-s status=201'))).toBe(true);
  });
  it('gives up after a few sweeps instead of retrying forever', async () => {
    const w = world();
    w.ports.sendPush = async () => fail;
    w.engine.setWaiting(w.waiting(60_000), 'a');
    for (let i = 0; i < 5; i++) await w.engine.sweep();
    expect(w.store.get('w/g-i1')!.sent.sort()).toEqual(['ana', 'bo']);
  });
  it('does not mark a reminder sent while push fails', async () => {
    const w = world({ prefs: { ana: { ...DEFAULT_NOTIFY_PREFS, telegram: false } } });
    w.engine.setWaiting(
      w.waiting(25 * H, {}, { approvals: { bo: { at: ts(0), rationale: '' } } }),
      'a',
    );
    w.ports.sendPush = async () => fail;
    await w.engine.sweep();
    expect(w.store.get('w/g-i1')!.remindedAt).toBeNull();
  });
});

describe('the bell (item 3ENs)', () => {
  it('a new arrival goes in the bell of each decider who has not voted, once', async () => {
    const w = world();
    w.engine.setWaiting(
      w.waiting(60_000, {}, { approvals: { bo: { at: ts(0), rationale: '' } } }),
      'a',
    );
    await w.engine.sweep();
    await w.engine.sweep();
    expect([...w.bells.keys()]).toEqual(['ana/g-i1-review_0']);
    expect(w.bells.get('ana/g-i1-review_0')).toEqual({
      kind: 'gate',
      workspaceId: 'w',
      projectId: 'p',
      itemId: 'i1',
      projectName: 'Blog',
      itemTitle: 'Post',
      stepName: 'Review',
      actorName: '',
      text: '',
      at: w.t.now - 60_000,
      readAt: null,
    });
  });
  it('an old arrival goes in the bell without any pop-up', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(2 * H), 'a');
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(0);
    expect([...w.bells.keys()].sort()).toEqual(['ana/g-i1-review_0', 'bo/g-i1-review_0']);
  });
  it('quiet hours hold the pop-up but not the bell', async () => {
    const quiet = { enabled: true, from: '00:00', to: '23:59', tz: 'UTC' };
    const w = world({
      prefs: {
        ana: { ...DEFAULT_NOTIFY_PREFS, quiet },
        bo: { ...DEFAULT_NOTIFY_PREFS, quiet },
      },
    });
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    expect(w.sentPush).toHaveLength(0);
    expect(w.bells.size).toBe(2);
  });
  it('a send back and a new arrival make a new entry', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    w.engine.setWaiting(w.waiting(1000, { sendBackCount: 1 }), 'a');
    await w.engine.sweep();
    expect([...w.bells.keys()].filter((k) => k.startsWith('ana/'))).toEqual([
      'ana/g-i1-review_0',
      'ana/g-i1-review_1',
    ]);
  });
  it('a restarted notifier does not write the same arrival again', async () => {
    const w = world();
    w.engine.setWaiting(w.waiting(60_000), 'a');
    await w.engine.sweep();
    w.bells.clear();
    const again = new Engine(w.ports);
    again.setWaiting(w.waiting(60_000), 'a');
    await again.sweep();
    expect(w.bells.size).toBe(0);
  });
  it('a question goes in the bell of the project people, with who asked', async () => {
    const w = world();
    w.engine.setQuestion(
      {
        wid: 'w',
        pid: 'p',
        iid: 'i9',
        mid: 'm1',
        project: w.project,
        itemTitle: 'Post',
        text: 'Which tone?',
        atMs: w.t.now - 1000,
        byName: 'Hive',
      },
      'q',
    );
    await w.engine.sweep();
    await w.engine.sweep();
    expect([...w.bells.keys()].sort()).toEqual(['ana/q-m1', 'bo/q-m1']);
    expect(w.bells.get('ana/q-m1')).toMatchObject({
      kind: 'question',
      itemId: 'i9',
      actorName: 'Hive',
      text: 'Which tone?',
    });
  });
  it('a send back tells the person who created the item, not the one who sent it', async () => {
    const w = world();
    const decision = {
      wid: 'w',
      pid: 'p',
      did: 'd1',
      project: w.project,
      itemId: 'i1',
      itemTitle: 'Post',
      outcome: 'sentBack' as const,
      toStepId: 'draft',
      byUid: 'agent1',
      byName: 'Hive',
      text: '7 e2e failures',
      atMs: w.t.now - 500,
      creatorUid: 'ana',
    };
    await w.engine.onDecision(decision);
    expect([...w.bells.keys()]).toEqual(['ana/s-d1']);
    expect(w.bells.get('ana/s-d1')).toMatchObject({
      kind: 'sentBack',
      stepName: 'Draft',
      actorName: 'Hive',
      text: '7 e2e failures',
    });
    w.bells.clear();
    await w.engine.onDecision({ ...decision, did: 'd2', byUid: 'ana', byName: 'Ana' });
    await w.engine.onDecision({ ...decision, did: 'd3', creatorUid: null });
    expect(w.bells.size).toBe(0);
  });
  it('an answer tells the other project people', async () => {
    const w = world();
    await w.engine.onDecision({
      wid: 'w',
      pid: 'p',
      did: 'd9',
      project: w.project,
      itemId: 'i1',
      itemTitle: 'Post',
      outcome: 'answered',
      toStepId: null,
      byUid: 'ana',
      byName: 'Ana',
      text: 'Friendly',
      atMs: w.t.now,
      creatorUid: 'ana',
    });
    expect([...w.bells.keys()]).toEqual(['bo/a-d9']);
    expect(w.bells.get('bo/a-d9')).toMatchObject({ kind: 'answer', actorName: 'Ana' });
    // No pop-ups for these: push and Telegram stay as they are.
    expect(w.sentPush).toHaveLength(0);
    expect(w.sentTg).toHaveLength(0);
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
