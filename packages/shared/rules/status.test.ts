/**
 * Item AzveC: status checks. Only the agent holding an item writes its status, under its current
 * claim; anyone on the project asks for one on an item an agent is actively working, at most once
 * per 2 minutes; admins and the project's creator set the interval.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { claimItem, updateProject, type ActionPlan, type ItemState } from '../src/actions';
import { askForStatus, reportStatus, setSilenceAfter, setStatusEvery } from '../src/status';
import {
  AGENTS,
  as,
  denied,
  I,
  itemDoc,
  minutesAgo,
  now,
  ok,
  P,
  put,
  snap,
  useEmulator,
} from './harness';

useEmulator();

async function claimed(uid: string = AGENTS.a) {
  const a = as(uid);
  const base = itemDoc() as unknown as ItemState;
  const p = claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: base, runId: `run-${uid}` });
  await a.run(p);
  const item = {
    ...base,
    status: 'working',
    claim: { runId: p.runId, agentUid: uid, heartbeatAt: now() },
  } as ItemState;
  return { a, item, runId: p.runId };
}

/** The plan with the item update's data changed by `f`. */
function withItem(p: ActionPlan, f: (d: Record<string, unknown>) => void): ActionPlan {
  return {
    ...p,
    ops: p.ops.map((o) => {
      if (o.kind !== 'update' || !o.path.includes('/items/')) return o;
      const data = { ...o.data };
      f(data);
      return { ...o, data };
    }),
  };
}

const ask = (who: ReturnType<typeof as>, item: ItemState) =>
  askForStatus(who.ctx, { projectId: 'p1', itemId: 'i1', item, nowMs: Date.now() });

describe('status (item AzveC)', () => {
  it('the holder writes its status; it replaces the previous one', async () => {
    const { a, item } = await claimed();
    await ok(
      a.run(reportStatus(a.ctx, { projectId: 'p1', itemId: 'i1', item, text: 'Tests', pct: 70 })),
    );
    const s = (await snap(I('i1'))).statusUpdate as { text: string; pct: number };
    expect([s.text, s.pct]).toEqual(['Tests', 70]);
    await ok(a.run(reportStatus(a.ctx, { projectId: 'p1', itemId: 'i1', item, text: 'No pct' })));
    expect(((await snap(I('i1'))).statusUpdate as { pct: unknown }).pct).toBe(null);
  });

  it('ATTACK: another agent, another run, a backdated or malformed status is refused', async () => {
    const { a, item } = await claimed();
    const s = as(AGENTS.star);
    const forged = { ...item, claim: { ...item.claim!, agentUid: AGENTS.star } };
    await denied(
      s.run(reportStatus(s.ctx, { projectId: 'p1', itemId: 'i1', item: forged, text: 'mine' })),
    );
    const p = reportStatus(a.ctx, { projectId: 'p1', itemId: 'i1', item, text: 'Build', pct: 10 });
    const st = (f: (x: Record<string, unknown>) => void) =>
      withItem(p, (d) => {
        const x = { ...(d.statusUpdate as Record<string, unknown>) };
        f(x);
        d.statusUpdate = x;
      });
    await denied(a.run(st((x) => (x.runId = 'other-run'))));
    await denied(a.run(st((x) => (x.at = Timestamp.fromMillis(1)))));
    await denied(a.run(st((x) => (x.by = AGENTS.star))));
    await denied(a.run(st((x) => (x.text = 'x'.repeat(201)))));
    await denied(a.run(st((x) => (x.text = ''))));
    await denied(a.run(st((x) => (x.pct = 101))));
    await denied(a.run(st((x) => (x.pct = 1.5))));
    await denied(a.run(st((x) => (x.extra = true))));
    // Not in the same write as anything else.
    await denied(a.run(withItem(p, (d) => (d.progress = { done: 1, total: 2 }))));
    await denied(a.run(withItem(p, (d) => (d.silence = null))));
    await ok(a.run(p));
  });

  it('ATTACK: a person may not write a status', async () => {
    const { a, item } = await claimed();
    const p = reportStatus(a.ctx, { projectId: 'p1', itemId: 'i1', item, text: 'Build' });
    const alice = as('alice');
    await denied(
      alice.run({
        ...p,
        ops: p.ops.map((o) =>
          o.path.includes('/events/')
            ? { ...o, data: { ...o.data, actor: { type: 'human', id: 'alice', name: 'Alice' } } }
            : o,
        ),
      }),
    );
  });
});

describe('ask for status (item AzveC)', () => {
  it('a member asks on an actively worked item; again only after 2 minutes', async () => {
    const { item, runId } = await claimed();
    const dave = as('dave'); // a plain member of p1, never a decider
    await ok(dave.run(ask(dave, item)));
    const a1 = (await snap(I('i1'))).statusAsk as { byUid: string; runId: string };
    expect([a1.byUid, a1.runId]).toEqual(['dave', runId]);
    // Within 2 minutes: refused (the action says so; the rules too).
    const asked = { ...item, statusAsk: { runId, byUid: 'dave', at: now() } } as ItemState;
    expect(() => ask(dave, asked)).toThrow(/2 minutes/);
    await denied(dave.run(ask(dave, item)));
    // Older than 2 minutes: fine again.
    await put({
      [I('i1')]: {
        ...(await snap(I('i1'))),
        statusAsk: { runId, byUid: 'dave', at: minutesAgo(3) },
      },
    });
    await ok(as('alice').run(ask(as('alice'), item)));
  });

  it('ATTACK: not on an item that is parked, waiting, stale, unclaimed, or for someone else', async () => {
    const { item, runId } = await claimed();
    const alice = as('alice');
    const p = ask(alice, item);
    const current = await snap(I('i1'));
    const set = async (over: Record<string, unknown>) =>
      put({ [I('i1')]: { ...current, ...over } });
    await set({ parked: { runId, reason: 'release', at: now() } });
    await denied(alice.run(p));
    await set({
      parked: null,
      awaitingAnswer: { questionId: 'q1', agentUid: AGENTS.a, at: now() },
    });
    await denied(alice.run(p));
    await set({
      awaitingAnswer: null,
      claim: { runId, agentUid: AGENTS.a, heartbeatAt: minutesAgo(11) },
    });
    await denied(alice.run(p));
    await set({ claim: null, status: 'queued' });
    await denied(alice.run(p));
    await set({ claim: { runId, agentUid: AGENTS.a, heartbeatAt: now() }, status: 'working' });
    // Another person's name, another run, a backdated ask, or more fields.
    const st = (f: (x: Record<string, unknown>) => void) =>
      withItem(p, (d) => {
        const x = { ...(d.statusAsk as Record<string, unknown>) };
        f(x);
        d.statusAsk = x;
      });
    await denied(alice.run(st((x) => (x.byUid = 'bob'))));
    await denied(alice.run(st((x) => (x.runId = 'other'))));
    await denied(alice.run(st((x) => (x.at = Timestamp.fromMillis(1)))));
    await denied(alice.run(st((x) => (x.note = 'hi'))));
    await denied(alice.run(withItem(p, (d) => (d.title = 'renamed'))));
    // Someone outside the project.
    const eve = as('eve');
    await denied(eve.run(ask(eve, item)));
    await ok(alice.run(p));
  });

  it('ATTACK: an agent may not ask for a status', async () => {
    const { a, item } = await claimed();
    const alice = as('alice');
    const p = ask(alice, item);
    await denied(
      a.run({
        ...p,
        ops: p.ops.map((o) =>
          o.path.includes('/events/')
            ? { ...o, data: { ...o.data, actor: { type: 'agent', id: AGENTS.a, name: 'A' } } }
            : withItem({ ...p, ops: [o] }, (d) => {
                (d.statusAsk as Record<string, unknown>).byUid = AGENTS.a;
              }).ops[0]!,
        ),
      }),
    );
  });
});

describe('the project setting statusEvery (item AzveC)', () => {
  it("admins and the project's creator set it; other members and agents cannot", async () => {
    const d = as('dave');
    await denied(d.run(setStatusEvery(d.ctx, { projectId: 'p1', every: 15 })));
    const o = as('owner');
    await ok(o.run(setStatusEvery(o.ctx, { projectId: 'p1', every: 15 })));
    expect((await snap(P('p1'))).statusEvery).toBe(15);
    await ok(o.run(setStatusEvery(o.ctx, { projectId: 'p1', every: 0 })));
    expect((await snap(P('p1'))).statusEvery).toBe(0);
    const bad = setStatusEvery(o.ctx, { projectId: 'p1', every: 60 });
    await denied(
      o.run({
        ...bad,
        ops: bad.ops.map((op) =>
          op.path === P('p1') ? { ...op, data: { ...op.data, statusEvery: 45 } } : op,
        ),
      }),
    );
    const a = as(AGENTS.a);
    await denied(
      a.run({
        ops: [{ kind: 'update', path: P('p1'), data: { statusEvery: 60, lastEventId: 'seed' } }],
      }),
    );
  });

  it('the project edit form saves it with the name', async () => {
    const o = as('owner');
    await ok(
      o.run(
        updateProject(o.ctx, {
          projectId: 'p1',
          name: 'Blog',
          emoji: '📝',
          description: '',
          statusEvery: 60,
        }),
      ),
    );
    expect((await snap(P('p1'))).statusEvery).toBe(60);
    const d = as('dave');
    await denied(
      d.run(
        updateProject(d.ctx, {
          projectId: 'p1',
          name: 'Blog',
          emoji: '📝',
          description: '',
          statusEvery: 15,
        }),
      ),
    );
  });
});

describe('the project setting silenceAfter (item AzveC)', () => {
  it("admins and the project's creator set it (20, 40, 60, 120 or 0); others cannot", async () => {
    const d = as('dave');
    await denied(d.run(setSilenceAfter(d.ctx, { projectId: 'p1', after: 20 })));
    const o = as('owner');
    await ok(o.run(setSilenceAfter(o.ctx, { projectId: 'p1', after: 20 })));
    expect((await snap(P('p1'))).silenceAfter).toBe(20);
    await ok(o.run(setSilenceAfter(o.ctx, { projectId: 'p1', after: 0 })));
    expect((await snap(P('p1'))).silenceAfter).toBe(0);
    const bad = setSilenceAfter(o.ctx, { projectId: 'p1', after: 60 });
    await denied(
      o.run({
        ...bad,
        ops: bad.ops.map((op) =>
          op.path === P('p1') ? { ...op, data: { ...op.data, silenceAfter: 30 } } : op,
        ),
      }),
    );
    const a = as(AGENTS.a);
    await denied(
      a.run({
        ops: [{ kind: 'update', path: P('p1'), data: { silenceAfter: 60, lastEventId: 'seed' } }],
      }),
    );
  });

  it('the project edit form saves it with the name', async () => {
    const o = as('owner');
    await ok(
      o.run(
        updateProject(o.ctx, {
          projectId: 'p1',
          name: 'Blog',
          emoji: '📝',
          description: '',
          silenceAfter: 120,
        }),
      ),
    );
    expect((await snap(P('p1'))).silenceAfter).toBe(120);
  });
});
