/**
 * Card KLCTVnX8: an agent sends an item back to an earlier agent step (agentSendBack). Allowed to
 * an earlier agent step on the path with a reason; refused across a people step, to a skipped or
 * people step, to its own step, without a reason, by an agent that does not hold the item, and on
 * the 4th round. People acting on the item reset the rounds.
 */
import { describe, expect, it } from 'vitest';
import {
  answer,
  approve,
  claimItem,
  moveItem,
  postMessage,
  releaseClaim,
  sendBack,
  type ActionPlan,
  type ItemState,
  type ProjectState,
} from '../src/actions';
import { agentSendBack, stuckQuestion } from '../src/sendback';
import { buildStepIndex, paths, type Step } from '../src/schema';
import { AGENTS, as, denied, gate, I, itemDoc, ok, P, put, snap, useEmulator, W } from './harness';

useEmulator();

/** build → test → review (people) → deploy → verify */
const LIB: Step[] = [
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'test', name: 'Test', kind: 'agent', description: '' },
  { id: 'review', name: 'Review', kind: 'human', description: '', gate: gate() },
  { id: 'deploy', name: 'Deploy', kind: 'agent', description: '' },
  { id: 'verify', name: 'Verify', kind: 'agent', description: '' },
];
const PROJECT: ProjectState = { steps: LIB };

async function seedProject(steps: Step[] = LIB) {
  await put({
    [P('p1')]: {
      ...(await snap(P('p1'))),
      steps,
      stepIndex: buildStepIndex(steps),
    },
  });
}

let runs = 0;
/** Agent A holds item i1 at `stepId` (claimed with a new run). */
async function held(stepId: string, over: Record<string, unknown> = {}) {
  await seedProject();
  await put({ [I('i1')]: itemDoc({ stepId, ...over }) });
  const a = as(AGENTS.a);
  const before = (await snap(I('i1'))) as unknown as ItemState;
  await ok(
    a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: before, runId: `r${++runs}` })),
  );
  return { a, item: (await snap(I('i1'))) as unknown as ItemState };
}

function sendPlan(
  a: ReturnType<typeof as>,
  item: ItemState,
  toStepId: string,
  opts: { project?: ProjectState; reason?: string } = {},
) {
  return agentSendBack(a.ctx, {
    project: opts.project ?? PROJECT,
    projectId: 'p1',
    itemId: 'i1',
    item,
    toStepId,
    reason: opts.reason ?? 'Test fails: the login button does nothing.',
  });
}

/** A plan with one op's data changed (attack batches). */
function tamper(p: ActionPlan, path: string, data: Record<string, unknown>): ActionPlan {
  return {
    ...p,
    ops: p.ops.map((o) => (o.path === path ? { ...o, data: { ...o.data, ...data } } : o)),
  };
}

describe('agent send-back', () => {
  it('sends back to an earlier agent step: the item arrives there with the reason as a note', async () => {
    const { a, item } = await held('test');
    const p = sendPlan(a, item, 'build');
    await ok(a.run(p));
    const d = await snap(I('i1'));
    expect(d).toMatchObject({ stepId: 'build', status: 'queued', claim: null, agentSendBacks: 1 });
    const note = await snap(paths.message(W, 'p1', 'i1', `${p.eventId}-note`));
    expect(note).toMatchObject({
      kind: 'note',
      text: 'Test fails: the login button does nothing.',
    });
    expect(await snap(paths.run(W, item.claim!.runId))).toMatchObject({ status: 'done' });
    expect(await snap(paths.event(W, p.eventId))).toMatchObject({
      type: 'item.sentBack',
      data: { fromStepId: 'test', toStepId: 'build', round: 1 },
    });
  });

  it('is refused across a people step (even when the client thinks there is none)', async () => {
    const { a, item } = await held('verify');
    expect(() => sendPlan(a, item, 'test')).toThrow(/across people/);
    const lie: ProjectState = {
      steps: LIB.map((s) => (s.id === 'review' ? { ...s, kind: 'agent' as const } : s)),
    };
    await denied(a.run(sendPlan(a, item, 'test', { project: lie })));
    // Within the agent steps after the gate it is fine.
    await ok(a.run(sendPlan(a, item, 'deploy')));
  });

  it('may pass a people step the item skips', async () => {
    const { a, item } = await held('verify', {
      gateSkips: { review: 'not needed' },
      pathSkips: {},
    });
    await ok(a.run(sendPlan(a, item, 'build')));
    expect((await snap(I('i1'))).stepId).toBe('build');
  });

  it('is refused to a skipped step, a people step, its own step or a later step', async () => {
    const { a, item } = await held('test', { pathSkips: { build: 'no build needed' } });
    expect(() => sendPlan(a, item, 'build')).toThrow(/not on this item's path/);
    await denied(a.run(sendPlan(a, { ...item, pathSkips: {} }, 'build')));
    const { a: b, item: atVerify } = await held('verify');
    const gateAsAgent: ProjectState = {
      steps: LIB.map((s) => (s.id === 'review' ? { ...s, kind: 'agent' as const } : s)),
    };
    await denied(b.run(sendPlan(b, atVerify, 'review', { project: gateAsAgent })));
    expect(() => sendPlan(b, atVerify, 'verify')).toThrow(/step the item is at/);
    const { a: c, item: atBuild } = await held('build');
    const reversed: ProjectState = { steps: [LIB[1]!, LIB[0]!, ...LIB.slice(2)] };
    await denied(c.run(sendPlan(c, atBuild, 'test', { project: reversed })));
  });

  it('needs a reason', async () => {
    const { a, item } = await held('test');
    expect(() => sendPlan(a, item, 'build', { reason: '   ' })).toThrow(/reason/);
    const p = sendPlan(a, item, 'build');
    await denied(
      a.run(tamper(p, paths.event(W, p.eventId), { data: { toStepId: 'build', reason: '' } })),
    );
    await ok(a.run(p));
  });

  it('at most 12 steps may lie in between (the rules budget)', async () => {
    const long: Step[] = Array.from({ length: 15 }, (_, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      kind: 'agent' as const,
      description: '',
    }));
    await seedProject(long);
    await put({ [I('i1')]: itemDoc({ stepId: 's14' }) });
    const a = as(AGENTS.a);
    const before = (await snap(I('i1'))) as unknown as ItemState;
    await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: before, runId: 'rl' })));
    const item = (await snap(I('i1'))) as unknown as ItemState;
    const project = { steps: long };
    expect(() => sendPlan(a, item, 's0', { project })).toThrow(/too far back/);
    const near = { steps: [long[0]!, ...long.slice(2), long[1]!] }; // s0 looks 12 steps back
    await denied(a.run(sendPlan(a, item, 's0', { project: near })));
    await ok(a.run(sendPlan(a, item, 's1', { project })));
  });

  it('only by the agent that holds the item', async () => {
    const { item } = await held('test');
    const star = as(AGENTS.star);
    const forged = { ...item, claim: { ...item.claim!, agentUid: AGENTS.star } };
    await denied(star.run(sendPlan(star, forged as ItemState, 'build')));
  });

  it('the 4th round is refused; the agent holds the item for people instead', async () => {
    const { a, item } = await held('test', { agentSendBacks: 3 });
    expect(() => sendPlan(a, item, 'build')).toThrow(/needs people/);
    const p = sendPlan(a, { ...item, agentSendBacks: 2 }, 'build');
    await denied(a.run(tamper(p, I('i1'), { agentSendBacks: 4 })));
    await denied(a.run(p)); // 3 again: not one more than before
    // The hold: a question, then a release that names it.
    await ok(
      a.run(
        postMessage(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          kind: 'question',
          text: stuckQuestion(['one', 'two', 'three'], 'four'),
          runId: item.claim!.runId,
          messageId: 'stuck',
        }),
      ),
    );
    await ok(a.run(releaseClaim(a.ctx, { projectId: 'p1', itemId: 'i1', item, holdFor: 'stuck' })));
    const d = await snap(I('i1'));
    expect(d).toMatchObject({ stepId: 'test', awaitingAnswer: { questionId: 'stuck' } });
    // A person's answer ends the hold and resets the rounds.
    const alice = as('alice');
    await ok(
      alice.run(
        answer(alice.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: d as unknown as ItemState,
          questionId: 'stuck',
          text: 'Use the old login flow.',
        }),
      ),
    );
    expect(await snap(I('i1'))).toMatchObject({ awaitingAnswer: null, agentSendBacks: 0 });
  });

  it('people reset the rounds: approve, send back, move', async () => {
    await seedProject();
    const atReview = itemDoc({
      stepId: 'review',
      status: 'waiting',
      gate: { stepId: 'review', approvals: {}, rejections: {} },
      agentSendBacks: 2,
    });
    const alice = as('alice');
    await put({ [I('i1')]: atReview });
    let item = (await snap(I('i1'))) as unknown as ItemState;
    await ok(
      alice.run(approve(alice.ctx, { project: PROJECT, projectId: 'p1', itemId: 'i1', item })),
    );
    expect(await snap(I('i1'))).toMatchObject({ stepId: 'deploy', agentSendBacks: 0 });

    await put({ [I('i1')]: atReview });
    item = (await snap(I('i1'))) as unknown as ItemState;
    await ok(
      alice.run(
        sendBack(alice.ctx, {
          project: PROJECT,
          projectId: 'p1',
          itemId: 'i1',
          item,
          toStepId: 'build',
          rationale: 'Not what we asked for',
        }),
      ),
    );
    expect(await snap(I('i1'))).toMatchObject({ stepId: 'build', agentSendBacks: 0 });

    await put({ [I('i1')]: itemDoc({ stepId: 'test', agentSendBacks: 2 }) });
    item = (await snap(I('i1'))) as unknown as ItemState;
    await ok(
      alice.run(
        moveItem(alice.ctx, {
          project: PROJECT,
          projectId: 'p1',
          itemId: 'i1',
          item,
          toStepId: 'build',
        }),
      ),
    );
    expect(await snap(I('i1'))).toMatchObject({ stepId: 'build', agentSendBacks: 0 });
  });

  it('nobody else changes the rounds', async () => {
    await seedProject();
    await put({ [I('i1')]: itemDoc({ stepId: 'test', agentSendBacks: 2 }) });
    const item = (await snap(I('i1'))) as unknown as ItemState;
    const alice = as('alice');
    const p = moveItem(alice.ctx, {
      project: PROJECT,
      projectId: 'p1',
      itemId: 'i1',
      item,
      toStepId: 'build',
    });
    await denied(alice.run(tamper(p, I('i1'), { agentSendBacks: 5 })));
    // An agent's ordinary claim cannot touch them either.
    const a = as(AGENTS.a);
    const c = claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item, runId: 'r9' });
    await denied(a.run(tamper(c, I('i1'), { agentSendBacks: 0 })));
  });
});
