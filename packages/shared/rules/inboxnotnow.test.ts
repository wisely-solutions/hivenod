/**
 * Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3): only the member puts a waiting thread out of
 * Today, until a time within 48 hours, about the decision its event names; `updatedAt` stays (the
 * summary stays fresh); not on a thread where nothing waits.
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import { inboxPaths, notNowThread, type ThreadStateOf } from '../src/inbox';
import { AGENTS, as, denied, now, ok, put, snap, useEmulator, W } from './harness';

useEmulator();

const T = inboxPaths.thread(W, 'nn1');
const H = 3_600_000;

async function seed(state = 'needsYou') {
  const at = now();
  await put({
    [T]: {
      memberUid: 'alice',
      subjectId: null,
      state,
      waiting: null,
      question:
        state === 'needsYou'
          ? { text: 'Thursday?', by: AGENTS.a, at, answer: null, answeredAt: null }
          : null,
      title: 'Move the review',
      refs: ['r1'],
      lastMessageAt: at,
      fetchedBy: AGENTS.a,
      createdAt: at,
      updatedAt: at,
      lastEventId: 'e0',
    },
  });
  return at;
}
const thread = async () => (await snap(T)) as unknown as ThreadStateOf;
const plan = async (who = as('alice'), until = new Date(Date.now() + 20 * H), key = 'q1') =>
  notNowThread(who.ctx, { threadId: 'nn1', thread: await thread(), key, until });
const forge = (ops: WriteOp[], over: Record<string, unknown>, ev: Record<string, unknown> = {}) =>
  ops.map((op) =>
    op.path === T
      ? { ...op, data: { ...op.data, ...over } }
      : op.path.includes('/inboxEvents/') && Object.keys(ev).length
        ? { ...op, data: { ...op.data, data: { ...(op.data!.data as object), ...ev } } }
        : op,
  );

describe('Not now', () => {
  it('the member puts a waiting thread out of Today; updatedAt stays', async () => {
    const at = await seed();
    const p = await plan();
    await ok(as('alice').run(p));
    const t = (await snap(T)) as Record<string, { toMillis(): number } & Record<string, unknown>>;
    expect(t.notNow).toMatchObject({ key: 'q1' });
    expect(t.updatedAt!.toMillis()).toBe(at.toMillis());
    const ev = (await snap(inboxPaths.event(W, p.eventId))) as Record<string, unknown>;
    expect(ev).toMatchObject({ type: 'thread.not_now', memberUid: 'alice', threadId: 'nn1' });
  });

  it('also at Your call; not where nothing waits', async () => {
    await seed('yourCall');
    await ok(as('alice').run(await plan()));
    await seed('investigating');
    const alice = as('alice');
    const p = notNowThread(alice.ctx, {
      threadId: 'nn1',
      thread: { ...(await thread()), state: 'needsYou' },
      key: 'q1',
      until: new Date(Date.now() + 20 * H),
    });
    await denied(alice.run(p));
  });

  it('not another member, not an agent', async () => {
    await seed();
    const bob = as('bob');
    const bp = notNowThread(bob.ctx, {
      threadId: 'nn1',
      thread: { ...(await thread()), memberUid: 'bob' },
      key: 'q1',
      until: new Date(Date.now() + 20 * H),
    });
    await denied(bob.run(bp));
    const p = await plan();
    const a = as(AGENTS.a);
    await denied(a.run(p.ops.map((op) => op)));
  });

  it('refuses a far or past time, a key the event does not name, other fields', async () => {
    await seed();
    const alice = as('alice');
    const p = await plan();
    const far = new Date(Date.now() + 49 * H);
    const past = new Date(Date.now() - H);
    for (const over of [
      { notNow: { until: far, key: 'q1', at: (p.ops[0]!.data!.notNow as { at: unknown }).at } },
      { notNow: { until: past, key: 'q1', at: (p.ops[0]!.data!.notNow as { at: unknown }).at } },
      { notNow: { ...(p.ops[0]!.data!.notNow as object), key: '' } },
      { notNow: { ...(p.ops[0]!.data!.notNow as object), extra: 1 } },
      { state: 'investigating' },
      { title: 'Renamed' },
    ])
      await denied(alice.run(forge(p.ops, over)));
    await denied(alice.run(forge(p.ops, {}, { key: 'q2' })));
    await ok(alice.run(p));
  });
});
