/**
 * May act on my word (thread it18ecc2f3446f3b4e29e8f24c): the member's trusted home agent records
 * his decision at a plan's person step (approve, accept, reject, changes) or closes the thread,
 * attributed to him. Without the member's trust, on another agent's thread, for another member,
 * after he revoked it, or without his words: refused. Only the member sets his trust.
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import {
  decidePaths,
  decideOnWord,
  setAgentTrust,
  type DecideOnWordInput,
} from '../src/decideword';
import {
  approveOutcome,
  createMemberThread,
  finishOutcome,
  inboxPaths,
  proposeOutcome,
  proposePlan,
  addInboxMessage,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type SendBackOf,
  type ThreadStateOf,
} from '../src/inbox';
import { paths } from '../src/schema';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const PL = (pid: string) => inboxPaths.plan(W, pid);
const IDS = ['dv1', 'dv2', 'dv3', 'dv4', 'dv5', 'dv6', 'dv7'];
const thread = async (tid = 'nt1') => (await snap(T(tid))) as unknown as ThreadStateOf;
async function load(pid = 'pd1'): Promise<PlanInput & { plan: PlanOf & SendBackOf }> {
  const plan = (await snap(PL(pid))) as unknown as PlanOf & SendBackOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = (await snap(O(id))) as unknown as OutcomeStateOf;
  return { planId: pid, plan, outcomes };
}
const forgeEvent = (ops: WriteOp[], over: Record<string, unknown>) =>
  ops.map((op) =>
    op.path.includes('/inboxEvents/') && op.kind !== 'delete'
      ? { ...op, data: { ...op.data, data: { ...(op.data!.data as object), ...over } } }
      : op,
  );

async function trust(member: string, agent: string, on = true) {
  const m = as(member);
  const current = (await snap(decidePaths.trust(W, member))) as { agents?: string[] };
  await ok(
    m.run(
      setAgentTrust(m.ctx, {
        agentUid: agent,
        on,
        current: current.agents ? { agents: current.agents } : null,
      }),
    ),
  );
}

/** alice's Development thread nt1 (home agent agentA): Shape done, Approve idea at its turn. */
async function atApproveIdea() {
  const alice = as('alice');
  await ok(
    alice.run(
      createMemberThread(alice.ctx, {
        title: 'Dark mode',
        text: 'Add a dark mode to the board',
        agentUid: AGENTS.a,
        template: 'dev',
        threadId: 'nt1',
        planId: 'pd1',
        stepIds: IDS,
      }),
    ),
  );
  await finish(0);
  return alice;
}
async function finish(i: number, a: As = as(AGENTS.a)) {
  const pl = await load();
  const id = pl.plan.steps[i]!;
  await ok(
    a.run(
      finishOutcome(a.ctx, {
        outcomeId: id,
        outcome: pl.outcomes[id]!,
        thread: await thread(),
        status: 'done',
        result: { permalink: 'https://github.com/example/repo/pull/1' },
        plan: pl,
      }),
    ),
  );
}
async function decide(
  a: As,
  decision: DecideOnWordInput['decision'],
  over: Partial<DecideOnWordInput> = {},
) {
  const pl = await load();
  return decideOnWord(a.ctx, {
    decision,
    words: decision === 'changes' ? 'make the toggle bigger' : 'approved',
    threadId: 'nt1',
    thread: await thread(),
    memberName: 'Alice',
    outcomeId: pl.plan.steps[pl.plan.cursor],
    plan: pl,
    ...over,
  });
}

describe('May act on my word: the setting', () => {
  it('the member turns it on and off for one agent; off by default', async () => {
    expect(await snap(decidePaths.trust(W, 'alice'))).toEqual({});
    await trust('alice', AGENTS.a);
    await trust('alice', AGENTS.star);
    expect(await snap(decidePaths.trust(W, 'alice'))).toMatchObject({
      agents: [AGENTS.a, AGENTS.star],
    });
    await trust('alice', AGENTS.a, false);
    expect(await snap(decidePaths.trust(W, 'alice'))).toMatchObject({ agents: [AGENTS.star] });
  });
  it('an agent can never set it, on itself or for anyone; nor another member', async () => {
    const alice = as('alice');
    const p = setAgentTrust(alice.ctx, { agentUid: AGENTS.a, on: true });
    // The agent replays the member's own batch, then writes it as itself.
    await denied(as(AGENTS.a).run(p));
    const a = as(AGENTS.a);
    const forged = setAgentTrust(
      { ...a.ctx, actor: { ...a.ctx.actor, type: 'human' } },
      {
        agentUid: AGENTS.a,
        on: true,
      },
    );
    await denied(a.run(forged));
    await denied(
      a.run(
        forged.ops.map((op) =>
          op.path === decidePaths.trust(W, AGENTS.a)
            ? { ...op, path: decidePaths.trust(W, 'alice') }
            : op,
        ),
      ),
    );
    // The member's own batch, written as the agent (actor and all).
    await denied(
      a.run(
        p.ops.map((op) =>
          op.path.includes('/inboxEvents/') && op.kind !== 'delete'
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'Agent' } } }
            : op,
        ),
      ),
    );
    // Bob cannot write Alice's list: neither her batch nor his own aimed at her doc.
    await denied(as('bob').run(p));
    const bob = as('bob');
    const his = setAgentTrust(bob.ctx, { agentUid: AGENTS.a, on: true });
    await denied(
      bob.run(
        his.ops.map((op) =>
          op.path === decidePaths.trust(W, 'bob')
            ? { ...op, path: decidePaths.trust(W, 'alice') }
            : op,
        ),
      ),
    );
    // Alice's list holds only lists; no other keys.
    await denied(
      alice.run(
        p.ops.map((op) =>
          op.path === decidePaths.trust(W, 'alice') && op.kind !== 'delete'
            ? { ...op, data: { ...op.data, agents: AGENTS.a } }
            : op,
        ),
      ),
    );
  });
  it('only the member and the organization’s agents read it', async () => {
    await trust('alice', AGENTS.a);
    const { getDoc, doc } = await import('firebase/firestore');
    await ok(getDoc(doc(as('alice').db, decidePaths.trust(W, 'alice'))));
    await ok(getDoc(doc(as(AGENTS.a).db, decidePaths.trust(W, 'alice'))));
    await denied(getDoc(doc(as('bob').db, decidePaths.trust(W, 'alice'))));
    await denied(getDoc(doc(as(AGENTS.revoked).db, decidePaths.trust(W, 'alice'))));
  });
});

describe('May act on my word: decisions', () => {
  it('without the member’s trust the home agent cannot decide the gate', async () => {
    await atApproveIdea();
    await denied(as(AGENTS.a).run(await decide(as(AGENTS.a), 'approve')));
    expect((await snap(O('dv2'))).state).toBe('proposed');
  });

  it('trusted: approve passes the gate, attributed to the member, on his words', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    const a = as(AGENTS.a);
    const p = await decide(a, 'approve');
    await ok(a.run(p));
    expect(await snap(O('dv2'))).toMatchObject({
      state: 'done',
      decision: { byUid: AGENTS.a, edited: false, reason: null },
    });
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 2, state: 'active' });
    const ev = await snap(inboxPaths.event(W, p.eventId));
    expect(ev).toMatchObject({
      type: 'outcome.approved',
      memberUid: 'alice',
      actor: { type: 'agent', id: AGENTS.a },
      data: { onBehalfOf: 'alice', memberName: 'Alice', via: 'terminal', words: 'approved' },
    });
  });

  it('accept passes the last gate (Accept on live): the plan and the thread are done', async () => {
    const alice = await atApproveIdea();
    await trust('alice', AGENTS.a);
    const a = as(AGENTS.a);
    await ok(a.run(await decide(a, 'approve')));
    await finish(2);
    await finish(3);
    const pl = await load();
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: 'dv5',
          outcome: pl.outcomes.dv5!,
          thread: await thread(),
          plan: pl,
        }),
      ),
    );
    await finish(5);
    await ok(a.run(await decide(a, 'accept', { words: 'accepted, looks good live' })));
    expect(await snap(PL('pd1'))).toMatchObject({ state: 'done' });
    expect((await snap(T('nt1'))).state).toBe('done');
  });

  it('reject stops the plan; changes sends it back to Build with the words', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    const a = as(AGENTS.a);
    await ok(a.run(await decide(a, 'changes', { toStep: 0 })));
    expect(await snap(PL('pd1'))).toMatchObject({
      cursor: 0,
      sentBack: { n: 1, by: AGENTS.a, reason: 'make the toggle bigger' },
    });
    await finish(0);
    await ok(a.run(await decide(a, 'reject', { words: 'no, drop it' })));
    expect(await snap(PL('pd1'))).toMatchObject({ state: 'stopped' });
    expect(await snap(O('dv2'))).toMatchObject({
      state: 'rejected',
      decision: { byUid: AGENTS.a, reason: 'no, drop it' },
    });
  });

  it('reject a proposed plan, and close the thread', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    const a = as(AGENTS.a);
    await ok(
      a.run(
        proposePlan(a.ctx, {
          threadId: 'nt1',
          thread: await thread(),
          planId: 'pp2',
          stepIds: ['pq1', 'pq2'],
          steps: [
            { type: 'approval', fields: { what: 'Go?' } },
            { type: 'release', fields: {} },
          ],
        }),
      ),
    );
    const pp2 = await load('pp2');
    await ok(
      a.run(
        decideOnWord(a.ctx, {
          decision: 'reject',
          words: 'that older plan is replaced',
          threadId: 'nt1',
          thread: await thread(),
          memberName: 'Alice',
          outcomeId: 'pq2',
          plan: pp2,
        }),
      ),
    );
    expect(await snap(PL('pp2'))).toMatchObject({ state: 'stopped' });
    await ok(
      a.run(
        decideOnWord(a.ctx, {
          decision: 'close',
          words: 'tidy up',
          threadId: 'nt1',
          thread: await thread(),
          memberName: 'Alice',
        }),
      ),
    );
    expect((await snap(T('nt1'))).state).toBe('done');
  });

  it('revoked: once the member turns it off, the agent cannot decide any more', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    await trust('alice', AGENTS.a, false);
    await denied(as(AGENTS.a).run(await decide(as(AGENTS.a), 'approve')));
  });

  it('not on another agent’s thread, not for another member’s trust, not by a revoked agent', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.star);
    await trust('bob', AGENTS.a);
    // agentStar is trusted by alice but nt1's home agent is agentA.
    const star = as(AGENTS.star);
    const forged = await decide(star, 'approve', {
      thread: { ...(await thread()), fetchedBy: AGENTS.star },
    });
    await denied(star.run(forged));
    // agentA is trusted by bob only.
    await denied(as(AGENTS.a).run(await decide(as(AGENTS.a), 'approve')));
    expect((await snap(O('dv2'))).state).toBe('proposed');
  });

  it('not for a member who left the organization', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    const p = await decide(as(AGENTS.a), 'approve');
    const ws = await snap(paths.workspace(W));
    const roles = { ...(ws.memberRoles as Record<string, string>) };
    delete roles.alice;
    await put({ [paths.workspace(W)]: { ...ws, memberRoles: roles } });
    await denied(as(AGENTS.a).run(p));
  });

  it('not without the words, not by another channel, not with a forged onBehalfOf', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    const a = as(AGENTS.a);
    const p = await decide(a, 'approve');
    await denied(a.run(forgeEvent(p.ops, { words: '' })));
    await denied(a.run(forgeEvent(p.ops, { via: 'telegram' })));
    await denied(a.run(forgeEvent(p.ops, { onBehalfOf: 'bob' })));
    // The plain agent branch never carries onBehalfOf: an untrusted agent's own event type
    // (plan.sent_back, its executor's) cannot borrow the member's say.
    await trust('alice', AGENTS.a, false);
    const sb = await decide(a, 'changes', { toStep: 0 });
    await denied(a.run(sb));
  });

  it('only person steps of a plan: never a single proposal, never an agent step', async () => {
    await atApproveIdea();
    await trust('alice', AGENTS.a);
    const a = as(AGENTS.a);
    // A single reply proposal on another thread: the agent cannot approve it on the word.
    await ok(
      a.run(
        addInboxMessage(a.ctx, {
          messageDocId: 'm9',
          ref: 'r9',
          memberUid: 'alice',
          source: 'mail',
          sender: { name: 'Zoe' },
          text: 'Can we meet?',
          threadRef: 'z',
          messageId: 'z1',
          receivedAt: new Date(),
          newThreadId: 't9',
        }),
      ),
    );
    const pr = proposeOutcome(a.ctx, {
      threadId: 't9',
      thread: await thread('t9'),
      type: 'reply',
      fields: { text: 'Sure' },
      outcomeId: 'o9',
    });
    await ok(a.run(pr));
    const o9 = (await snap(O('o9'))) as unknown as OutcomeStateOf;
    const alice = as('alice');
    const mine = approveOutcome(alice.ctx, {
      outcomeId: 'o9',
      outcome: o9,
      thread: await thread('t9'),
    });
    // The member's approval, replayed by the agent with the word fields.
    const replay = mine.ops.map((op) => {
      if (op.kind === 'delete') return op;
      const d = { ...op.data } as Record<string, unknown>;
      if (op.path.includes('/inboxEvents/')) {
        d.actor = { type: 'agent', id: AGENTS.a, name: 'Agent' };
        d.data = {
          ...(d.data as object),
          onBehalfOf: 'alice',
          memberName: 'Alice',
          via: 'terminal',
          words: 'approved',
        };
      }
      if (d.decision) d.decision = { ...(d.decision as object), byUid: AGENTS.a };
      return { ...op, data: d } as WriteOp;
    });
    await denied(a.run(replay));
    expect(() =>
      decideOnWord(a.ctx, {
        decision: 'approve',
        words: 'approved',
        threadId: 't9',
        thread: {
          memberUid: 'alice',
          subjectId: null,
          state: 'yourCall',
          fetchedBy: AGENTS.a,
          refs: [],
        },
        memberName: 'Alice',
        outcomeId: 'dv3',
      }),
    ).toThrow(/person step/);
  });
});
