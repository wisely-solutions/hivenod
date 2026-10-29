/**
 * Ask the agent (item w6O2KOw4ys70TQv9I1xD): only the member instructs the home agent (a text or
 * a chip, one new pending entry, append-only, at most 20 kept, not while one waits); only that
 * agent answers, once per instruction; only that agent sets the suggested chips.
 */
import { describe, expect, it } from 'vitest';
import { DELETE_FIELD, SERVER_TIME, type WriteOp } from '../src/actions';
import {
  addInboxMessage,
  answerInstruction,
  inboxPaths,
  instructThread,
  suggestChips,
  type ThreadStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, minutesAgo, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = inboxPaths.thread(W, 'itr1');
const thread = async () => (await snap(T)) as unknown as ThreadStateOf;
const FAR = Date.now() + 3_600_000 * 24;

async function brought() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we move the review to Thursday?',
        threadRef: 'thread-1',
        messageId: 'm-1',
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return a;
}

let n = 0;
async function instruct(who: As = as('alice'), extra: Record<string, unknown> = { text: 'Prep' }) {
  const ctx = { ...who.ctx, newId: () => `ev${++n}` };
  const p = instructThread(ctx, { threadId: 'itr1', thread: await thread(), nowMs: FAR, ...extra });
  return { p, run: () => who.run(p) };
}
async function answer(id: string, who: As = as(AGENTS.a), extra: Record<string, unknown> = {}) {
  return answerInstruction(who.ctx, {
    threadId: 'itr1',
    thread: { ...(await thread()), fetchedBy: who.ctx.actor.id },
    instructionId: id,
    kind: 'note',
    note: 'Here is what I found.',
    ...extra,
  });
}
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));
const evOf = (ops: WriteOp[]) => ops.find((o) => o.path.includes('/inboxEvents/'))!;

describe('ask the agent: the member instructs', () => {
  it('a text or a chip, pending; not again while pending; again once answered', async () => {
    await brought();
    const first = await instruct();
    await ok(first.run());
    const t = (await snap(T)) as Record<string, any>;
    expect(t.instructions[first.p.eventId]).toMatchObject({
      text: 'Prep',
      chip: null,
      by: 'alice',
      state: 'pending',
      answer: null,
    });
    expect(t.instruct).toMatchObject({ state: 'pending', id: first.p.eventId });
    // A second while pending: the rules refuse it (the action is told it is far later).
    await denied((await instruct()).run());
    await ok(as(AGENTS.a).run(await answer(first.p.eventId)));
    await ok((await instruct(as('alice'), { chip: 'summarize' })).run());
  });
  it('again after 30 minutes without an answer', async () => {
    await brought();
    const first = await instruct();
    await ok(first.run());
    await put({
      [T]: {
        ...(await snap(T)),
        instruct: { state: 'pending', id: first.p.eventId, at: minutesAgo(31) },
      },
    });
    await ok((await instruct()).run());
  });
  it('not another member, not an agent, not a forged entry', async () => {
    await brought();
    const bob = as('bob');
    const bp = instructThread(bob.ctx, {
      threadId: 'itr1',
      thread: { ...(await thread()), memberUid: 'bob' },
      text: 'Mine now',
    });
    await denied(bob.run(bp));
    await denied(bob.run(forge(bp.ops, T, {})));
    const { p } = await instruct();
    const id = p.eventId;
    const entry = p.ops[0]!.data[`instructions.${id}`] as Record<string, unknown>;
    // By someone else, answered already, with both text and chip, a recheck chip, too long.
    for (const over of [
      { by: 'bob' },
      { state: 'answered' },
      { chip: 'summarize' },
      { text: null, chip: 'recheck' },
      { text: 'x'.repeat(501) },
      { extra: 1 },
    ])
      await denied(
        as('alice').run(forge(p.ops, T, { [`instructions.${id}`]: { ...entry, ...over } })),
      );
    // The same with an event that agrees: still refused.
    for (const over of [
      { text: null, chip: 'recheck' },
      { text: null, chip: 'dance' },
      { text: 'x'.repeat(501), chip: null },
      { text: '', chip: null },
    ])
      await denied(
        as('alice').run(
          p.ops.map((o) =>
            o.path === T
              ? { ...o, data: { ...o.data, [`instructions.${id}`]: { ...entry, ...over } } }
              : o.path.includes('/inboxEvents/')
                ? { ...o, data: { ...o.data, data: over } }
                : o,
          ),
        ),
      );
    // The event says something else.
    const ev = evOf(p.ops);
    await denied(
      as('alice').run(
        p.ops.map((o) =>
          o === ev ? { ...o, data: { ...o.data, data: { text: 'Other', chip: null } } } : o,
        ),
      ),
    );
    // instruct not pointing at it.
    await denied(
      as('alice').run(forge(p.ops, T, { instruct: { state: 'done', id, at: SERVER_TIME } })),
    );
    // An entry under another id than the event's.
    await denied(
      as('alice').run(
        p.ops.map((o) =>
          o.path === T
            ? {
                ...o,
                data: {
                  ...Object.fromEntries(
                    Object.entries(o.data).filter(([k]) => k !== `instructions.${id}`),
                  ),
                  'instructions.zz': entry,
                },
              }
            : o,
        ),
      ),
    );
    await ok(as('alice').run(p));
  });
  it('append-only: no removal or rewrite of earlier ones; at 20, exactly one goes', async () => {
    await brought();
    const first = await instruct();
    await ok(first.run());
    await ok(as(AGENTS.a).run(await answer(first.p.eventId)));
    // Drop the earlier one while adding (only allowed at 20).
    const { p } = await instruct();
    await denied(
      as('alice').run(forge(p.ops, T, { [`instructions.${first.p.eventId}`]: DELETE_FIELD })),
    );
    await denied(
      as('alice').run(forge(p.ops, T, { [`instructions.${first.p.eventId}.state`]: 'pending' })),
    );
    // 20 kept: the action drops the oldest answered one.
    const t = (await snap(T)) as Record<string, any>;
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++)
      many[`old${String(i).padStart(2, '0')}`] = {
        ...t.instructions[first.p.eventId],
        at: minutesAgo(100 - i),
      };
    await put({ [T]: { ...t, instructions: many } });
    const full = await instruct();
    expect(full.p.ops[0]!.data['instructions.old00']).toBe(DELETE_FIELD);
    // Keeping all 21 is refused, dropping two too.
    await denied(
      as('alice').run(
        full.p.ops.map((o) =>
          o.path === T
            ? {
                ...o,
                data: Object.fromEntries(
                  Object.entries(o.data).filter(([k]) => k !== 'instructions.old00'),
                ),
              }
            : o,
        ),
      ),
    );
    await denied(as('alice').run(forge(full.p.ops, T, { 'instructions.old01': DELETE_FIELD })));
    await ok(full.run());
    expect(Object.keys(((await snap(T)) as any).instructions)).toHaveLength(20);
  });
});

describe('ask the agent: the home agent answers', () => {
  async function asked() {
    await brought();
    const first = await instruct();
    await ok(first.run());
    return first.p.eventId;
  }
  it('once; another agent cannot; the member cannot', async () => {
    const id = await asked();
    await denied(as(AGENTS.star).run(await answer(id, as(AGENTS.star))));
    await ok(as(AGENTS.a).run(await answer(id, as(AGENTS.a), { kind: 'outcome', refId: 'o1' })));
    const t = (await snap(T)) as Record<string, any>;
    expect(t.instructions[id]).toMatchObject({
      state: 'answered',
      answer: { kind: 'outcome', refId: 'o1', note: 'Here is what I found.' },
    });
    expect(t.instruct.state).toBe('done');
    // Twice: the action refuses; forged as pending, the rules too.
    const again = answerInstruction(as(AGENTS.a).ctx, {
      threadId: 'itr1',
      thread: {
        ...(await thread()),
        instructions: { [id]: { state: 'pending' } },
      } as ThreadStateOf,
      instructionId: id,
      kind: 'ask',
    });
    await denied(as(AGENTS.a).run(again));
  });
  it('the answer is checked: kind, ref, note, its event, the instruction unchanged', async () => {
    const id = await asked();
    const a = as(AGENTS.a);
    const p = await answer(id);
    const k = `instructions.${id}.answer`;
    const ans = p.ops[0]!.data[k] as Record<string, unknown>;
    for (const over of [
      { kind: 'shrug' },
      { kind: 'outcome' },
      { kind: 'ask', refId: 'x' },
      { note: 'x'.repeat(501) },
      { note: null },
      { at: null },
      { extra: 1 },
    ])
      await denied(a.run(forge(p.ops, T, { [k]: { ...ans, ...over } })));
    await denied(a.run(forge(p.ops, T, { [`instructions.${id}.text`]: 'Rewritten' })));
    await denied(a.run(forge(p.ops, T, { [`instructions.${id}.state`]: 'pending' })));
    await denied(a.run(forge(p.ops, T, { 'instruct.state': 'pending' })));
    // The event names another kind.
    const ev = evOf(p.ops);
    await denied(
      a.run(
        p.ops.map((o) =>
          o === ev
            ? { ...o, data: { ...o.data, data: { ...(o.data.data as object), kind: 'ask' } } }
            : o,
        ),
      ),
    );
    await ok(a.run(p));
  });
  it('the answer touches no other instruction', async () => {
    const id = await asked();
    const a = as(AGENTS.a);
    await ok(a.run(await answer(id)));
    const second = await instruct();
    await ok(second.run());
    const p = await answer(second.p.eventId);
    await denied(a.run(forge(p.ops, T, { [`instructions.${id}.answer.note`]: 'Rewritten' })));
    await ok(a.run(p));
  });
  it('an older instruction: the latest request stays pending', async () => {
    const id = await asked();
    await put({
      [T]: {
        ...(await snap(T)),
        instruct: { state: 'pending', id: 'later', at: minutesAgo(1) },
      },
    });
    const a = as(AGENTS.a);
    const p = await answer(id);
    expect(p.ops[0]!.data['instruct.state']).toBeUndefined();
    await denied(a.run(forge(p.ops, T, { 'instruct.state': 'done' })));
    await ok(a.run(p));
  });
});

describe('ask the agent: suggested chips', () => {
  it('only the home agent; 0-5 known chips, once each', async () => {
    await brought();
    const go = async (who: As, chips: string[]) =>
      suggestChips(who.ctx, {
        threadId: 'itr1',
        thread: { ...(await thread()), fetchedBy: who.ctx.actor.id },
        chips,
      });
    const a = as(AGENTS.a);
    await ok(a.run(await go(a, ['summarize', 'recheck'])));
    expect(((await snap(T)) as any).suggestedChips).toEqual(['summarize', 'recheck']);
    await denied(as(AGENTS.star).run(await go(as(AGENTS.star), ['summarize'])));
    const p = await go(a, ['follow_up']);
    await denied(a.run(forge(p.ops, T, { suggestedChips: ['dance'] })));
    await denied(a.run(forge(p.ops, T, { suggestedChips: ['follow_up', 'follow_up'] })));
    await denied(
      a.run(
        forge(p.ops, T, {
          suggestedChips: [
            'prepare_meeting',
            'recheck',
            'follow_up',
            'summarize',
            'draft_reply',
            'x',
          ],
        }),
      ),
    );
    await denied(a.run(forge(p.ops, T, { suggestedChips: 'summarize' })));
    // The member cannot set them.
    const alice = as('alice');
    await denied(
      alice.run(
        p.ops.map((o) => ({
          ...o,
          data: o.path.includes('/inboxEvents/')
            ? { ...o.data, actor: { type: 'human', id: 'alice', name: 'Alice' } }
            : o.data,
        })),
      ),
    );
    await ok(a.run(await go(a, [])));
  });
});
