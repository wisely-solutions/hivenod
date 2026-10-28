/**
 * Card zSzW3LXy (rework, tester R72 finding A): after a guardrail stops a run (the token limit)
 * and asks people, the item is held (item.awaitingAnswer) until the question is answered.
 * - nobody claims a held item: the same agent, another agent, nor a takeover of a stale claim;
 * - the hold names an open question the releasing agent asked on that item, set in the release;
 * - answering that question clears it (in the answer's batch); an admin may clear it by hand.
 */
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  answer,
  claimItem,
  clearHold,
  postMessage,
  releaseClaim,
  type ItemState,
} from '../src/actions';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  I,
  itemDoc,
  minutesAgo,
  now,
  ok,
  put,
  snap,
  useEmulator,
  W,
} from './harness';

useEmulator();

const queued = itemDoc() as unknown as ItemState;
const M = (mid: string) => paths.message(W, 'p1', 'i1', mid);

async function claimed(uid: string, runId: string) {
  const a = as(uid);
  await a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued, runId }));
  const item = {
    ...queued,
    status: 'working',
    claim: { runId, agentUid: uid, heartbeatAt: now() },
  } as ItemState;
  return { a, runId, item };
}

/** Agent A hits the token limit: question, then release as failed with the hold. */
async function stopped(questionId = 'q1') {
  const { a, runId, item } = await claimed(AGENTS.a, 'r-limit');
  await ok(
    a.run(
      postMessage(a.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        kind: 'question',
        text: 'Token limit reached. Go on?',
        runId,
        messageId: questionId,
      }),
    ),
  );
  const plan = releaseClaim(a.ctx, {
    projectId: 'p1',
    itemId: 'i1',
    item,
    status: 'failed',
    holdFor: questionId,
  });
  await ok(a.run(plan));
  return { a, item: (await snap(I('i1'))) as unknown as ItemState };
}

const claimBy = (uid: string, item: ItemState = queued) => {
  const x = as(uid);
  return x.run(claimItem(x.ctx, { projectId: 'p1', itemId: 'i1', item }));
};

describe('held for an answer', () => {
  it('the token-limit release holds the item; nobody can claim it by id', async () => {
    await stopped();
    const d = await snap(I('i1'));
    expect(d.claim).toBeNull();
    expect(d.status).toBe('queued');
    expect(d.awaitingAnswer).toMatchObject({ questionId: 'q1', agentUid: AGENTS.a });
    await denied(claimBy(AGENTS.a));
    await denied(claimBy(AGENTS.star));
  });

  it('a stale claim on a held item cannot be taken over either', async () => {
    await put({
      [I('i1')]: itemDoc({
        status: 'working',
        claim: { runId: 'old', agentUid: AGENTS.a, heartbeatAt: minutesAgo(30) },
        awaitingAnswer: { questionId: 'q1', agentUid: AGENTS.a, at: minutesAgo(31) },
      }),
    });
    await denied(claimBy(AGENTS.star));
    await denied(claimBy(AGENTS.a));
  });

  it('answering the question clears the hold; then any allowed agent may claim', async () => {
    const { item } = await stopped();
    const alice = as('alice');
    await ok(
      alice.run(
        answer(alice.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item,
          questionId: 'q1',
          text: 'Go on.',
        }),
      ),
    );
    const d = await snap(I('i1'));
    expect(d.awaitingAnswer).toBeNull();
    expect(d.status).toBe('queued');
    await ok(claimBy(AGENTS.star));
  });

  it('answering another question keeps the hold', async () => {
    const { item } = await stopped('q1');
    // An older open question on the same item (seeded).
    await put({
      [M('q0')]: {
        workspaceId: W,
        projectId: 'p1',
        itemId: 'i1',
        by: { type: 'agent', id: AGENTS.a },
        kind: 'question',
        text: 'Earlier question',
        at: now(),
        answered: false,
        replyTo: null,
        lastEventId: 'seed',
      },
    });
    const alice = as('alice');
    // The action leaves the item alone for another question.
    await ok(
      alice.run(
        answer(alice.ctx, { projectId: 'p1', itemId: 'i1', item, questionId: 'q0', text: 'Fine.' }),
      ),
    );
    expect((await snap(I('i1'))).awaitingAnswer).toMatchObject({ questionId: 'q1' });
    // ATTACK: clearing the hold with the answer to another question.
    await put({ [M('q0')]: { ...(await snap(M('q0'))), answered: false } });
    const p = answer(alice.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      item: { ...item, awaitingAnswer: { questionId: 'q0' } as never },
      questionId: 'q0',
      text: 'Fine again.',
    });
    await denied(alice.run(p));
  });

  it("a release adds the run's cost to the item (JJ6fYb3b); the cost can never go down", async () => {
    await put({ [I('i1')]: itemDoc() });
    const { a, item } = await claimed(AGENTS.a, 'r-cost');
    const withCost = { ...item, costEur: 0.5 } as ItemState;
    await put({ [I('i1')]: { ...(await snap(I('i1'))), costEur: 0.5 } });
    await ok(
      a.run(
        releaseClaim(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: withCost,
          status: 'failed',
          result: { costEur: 0.15 },
        }),
      ),
    );
    expect((await snap(I('i1'))).costEur).toBeCloseTo(0.65, 6);
    // ATTACK: a release that lowers the item's cost is refused.
    await put({ [I('i1')]: itemDoc() });
    const again = await claimed(AGENTS.a, 'r-cost2');
    await put({ [I('i1')]: { ...(await snap(I('i1'))), costEur: 1 } });
    await denied(
      again.a.run(
        releaseClaim(again.a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: { ...again.item, costEur: 0.2 } as ItemState,
          result: { costEur: 0 },
        }),
      ),
    );
  });

  it('an admin may let agents take it without an answer; a member or an agent may not', async () => {
    const { item } = await stopped();
    const dave = as('dave');
    await denied(dave.run(clearHold(dave.ctx, { projectId: 'p1', itemId: 'i1', item })));
    const a = as(AGENTS.a);
    await denied(updateDoc(doc(a.db, I('i1')), { awaitingAnswer: null }));
    const owner = as('owner');
    await ok(owner.run(clearHold(owner.ctx, { projectId: 'p1', itemId: 'i1', item })));
    expect((await snap(I('i1'))).awaitingAnswer).toBeNull();
    // The question stays open in "Needs you".
    expect((await snap(M('q1'))).answered).toBe(false);
    await ok(claimBy(AGENTS.a));
  });

  it('a hold carries no reason any more (the token limit is gone; old holds read as questions)', async () => {
    await put({ [I('i1')]: itemDoc() });
    const { a, item } = await claimed(AGENTS.a, 'r-reason');
    await put({
      [M('qt')]: {
        workspaceId: W,
        projectId: 'p1',
        itemId: 'i1',
        by: { type: 'agent', id: AGENTS.a },
        kind: 'question',
        text: 'Q',
        at: now(),
        answered: false,
        replyTo: null,
        lastEventId: 'seed',
      },
    });
    await ok(
      a.run(
        releaseClaim(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item,
          holdFor: 'qt',
          status: 'failed',
        }),
      ),
    );
    const held = (await snap(I('i1'))).awaitingAnswer;
    expect(held).toMatchObject({ questionId: 'qt' });
    expect((held as { reason?: string }).reason).toBeUndefined();
  });

  it('ATTACK: the hold must name an open question the releasing agent asked on this item', async () => {
    let n = 0;
    const release = async (holdFor: string, tweak?: (d: Record<string, unknown>) => void) => {
      await put({ [I('i1')]: itemDoc() });
      const { a, item } = await claimed(AGENTS.a, `r-${holdFor}-${++n}`);
      expect((await snap(I('i1'))).claim).toMatchObject({ agentUid: AGENTS.a });
      const p = releaseClaim(a.ctx, { projectId: 'p1', itemId: 'i1', item, holdFor });
      if (tweak) tweak(p.ops[0]!.data as Record<string, unknown>);
      return a.run(p);
    };
    const seedMessage = (mid: string, over: Record<string, unknown>) =>
      put({
        [M(mid)]: {
          workspaceId: W,
          projectId: 'p1',
          itemId: 'i1',
          by: { type: 'agent', id: AGENTS.a },
          kind: 'question',
          text: 'Q',
          at: now(),
          answered: false,
          replyTo: null,
          lastEventId: 'seed',
          ...over,
        },
      });
    await denied(release('nope'));
    await seedMessage('answered', { answered: true });
    await denied(release('answered'));
    await seedMessage('other', { by: { type: 'agent', id: AGENTS.star } });
    await denied(release('other'));
    await seedMessage('note', { kind: 'note' });
    await denied(release('note'));
    await seedMessage('mine', {});
    // Someone else's name on the hold, or a hold dated in the past.
    await denied(
      release('mine', (d) => {
        (d.awaitingAnswer as Record<string, unknown>).agentUid = AGENTS.star;
      }),
    );
    await denied(
      release('mine', (d) => {
        (d.awaitingAnswer as Record<string, unknown>).at = minutesAgo(5);
      }),
    );
    // The hold may say why (the token limit, set by the wrapper): only known reasons, no extra keys.
    await denied(
      release('mine', (d) => {
        (d.awaitingAnswer as Record<string, unknown>).reason = 'whatever';
      }),
    );
    await denied(
      release('mine', (d) => {
        (d.awaitingAnswer as Record<string, unknown>).extra = 1;
      }),
    );
    await ok(release('mine'));

    // An agent cannot set a hold outside a release, nor on a claim.
    await put({ [I('i1')]: itemDoc() });
    const x = as(AGENTS.a);
    await denied(
      updateDoc(doc(x.db, I('i1')), {
        awaitingAnswer: { questionId: 'mine', agentUid: AGENTS.a, at: serverTimestamp() },
      }),
    );
  });
});
