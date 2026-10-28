/**
 * Card CZwdWD3H: item updates are routed by cheap tests (who writes, whether the claim is
 * cleared, whether the item waits at a gate, the outcome of the decision doc) so each write only
 * pays for the paths that can match it. These attacks try to slip a write into the wrong route.
 */
import { describe, it } from 'vitest';
import {
  approve,
  attach,
  claimItem,
  completeStep,
  reportProgress,
  SERVER_TIME,
  stop,
  updateItem,
  type ActionPlan,
  type ItemState,
  type ProjectState,
} from '../src/actions';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  atGate,
  denied,
  I,
  itemDoc,
  ok,
  P,
  projectDoc,
  put,
  snap,
  steps,
  useEmulator,
  W,
} from './harness';

useEmulator();

const project = { steps: steps() } as ProjectState;
const isDecision = (path: string) => path.includes('/decisions/');
const isEvent = (path: string) => path.includes('/events/');

/** Rewrites a plan's decision doc and event to claim another outcome. */
function relabel(plan: ActionPlan, outcome: string): ActionPlan {
  return {
    ...plan,
    ops: plan.ops.map((op) =>
      isDecision(op.path)
        ? { ...op, data: { ...op.data, outcome, rationale: 'Relabelled by a cheating client' } }
        : isEvent(op.path)
          ? { ...op, data: { ...op.data, type: `decision.${outcome}` } }
          : op,
    ),
  };
}

/** Adds an approved decision doc (and its event type) to a plan that is not a decision. */
function withDecision(plan: ActionPlan, uid: string, itemId: string): ActionPlan {
  const decision = {
    kind: 'set' as const,
    path: paths.decision(W, 'p1', plan.eventId),
    data: {
      workspaceId: W,
      projectId: 'p1',
      itemId,
      itemTitle: 'Post about bees',
      stepId: 'review',
      outcome: 'approved',
      toStepId: null,
      byUid: uid,
      rationale: '',
      tags: [],
      at: SERVER_TIME,
      lastEventId: plan.eventId,
    },
  };
  return {
    ...plan,
    ops: [
      ...plan.ops.map((op) =>
        isEvent(op.path) ? { ...op, data: { ...op.data, type: 'decision.approved' } } : op,
      ),
      decision,
    ],
  };
}

describe('routing: gate decisions', () => {
  it('ATTACK: an approval labelled as a stop or a send back is denied', async () => {
    const a = as('alice');
    const item = (await snap(I('gated'))) as unknown as ItemState;
    const plan = approve(a.ctx, { project, projectId: 'p1', itemId: 'gated', item });
    await denied(a.run(relabel(plan, 'stopped')));
    await denied(a.run(relabel(plan, 'sentBack')));
    await ok(a.run(plan));
  });

  it('ATTACK: a stop labelled as an approval is denied', async () => {
    const a = as('alice');
    const item = (await snap(I('gated'))) as unknown as ItemState;
    const plan = stop(a.ctx, {
      project,
      projectId: 'p1',
      itemId: 'gated',
      item,
      rationale: 'Not doing this any more',
    });
    await denied(a.run(relabel(plan, 'approved')));
    await ok(a.run(plan));
  });

  it('ATTACK: an edit, an attachment or a move cannot ride on a decision event', async () => {
    const a = as('alice');
    const edit = updateItem(a.ctx, { projectId: 'p1', itemId: 'gated', changes: { title: 'x' } });
    await denied(a.run(withDecision(edit, 'alice', 'gated')));
    const file = attach(a.ctx, {
      projectId: 'p1',
      itemId: 'gated',
      kind: 'text',
      name: 'n',
      content: 'x',
    });
    await denied(a.run(withDecision(file, 'alice', 'gated')));
    const move = {
      ...edit,
      ops: edit.ops.map((op) =>
        op.path === I('gated')
          ? { ...op, data: { stepId: 'publish', status: 'queued', gate: null, ...op.data } }
          : op,
      ),
    };
    await denied(a.run(withDecision(move, 'alice', 'gated')));
    // The same edit and attachment without the decision are fine at a gate.
    await ok(a.run(edit));
    await ok(a.run(file));
  });

  it('ATTACK: a decision on an item that is not waiting at a gate is denied', async () => {
    const a = as('alice');
    const item = (await snap(I('gated'))) as unknown as ItemState;
    const plan = approve(a.ctx, { project, projectId: 'p1', itemId: 'gated', item });
    await put({ [I('gated')]: { ...atGate(), status: 'queued' } });
    await denied(a.run(plan));
  });
});

describe('routing: who writes', () => {
  it('ATTACK: people cannot use the agent paths (claim, progress, complete), even admins', async () => {
    for (const uid of ['owner', 'alice']) {
      const h = as(uid);
      const asAgent = { ...h.ctx, actor: { ...h.ctx.actor, type: 'agent' as const } };
      const queued = (await snap(I('i1'))) as unknown as ItemState;
      await denied(h.run(claimItem(asAgent, { projectId: 'p1', itemId: 'i1', item: queued })));
      await put({
        [I('i1')]: itemDoc({
          status: 'working',
          claim: { runId: 'r1', agentUid: uid, heartbeatAt: SERVER_TIME },
        }),
      });
      const held = { ...queued, claim: { runId: 'r1', agentUid: uid } } as unknown as ItemState;
      await denied(
        h.run(reportProgress(asAgent, { projectId: 'p1', itemId: 'i1', item: held, costEur: 1 })),
      );
      await denied(
        h.run(completeStep(asAgent, { project, projectId: 'p1', itemId: 'i1', item: held })),
      );
      await put({ [I('i1')]: itemDoc() });
    }
  });

  it('ATTACK: an agent cannot use the human paths (edit, decide)', async () => {
    await put({ [P('p1')]: projectDoc({ deciderUids: ['alice', AGENTS.a] }) });
    const ag = as(AGENTS.a);
    const asHuman = { ...ag.ctx, actor: { ...ag.ctx.actor, type: 'human' as const } };
    await denied(
      ag.run(updateItem(asHuman, { projectId: 'p1', itemId: 'i1', changes: { title: 'x' } })),
    );
    const item = (await snap(I('gated'))) as unknown as ItemState;
    await denied(ag.run(approve(asHuman, { project, projectId: 'p1', itemId: 'gated', item })));
  });
});

describe('routing: agent writes by claim', () => {
  async function holding() {
    const a = as(AGENTS.a);
    const queued = (await snap(I('i1'))) as unknown as ItemState;
    await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued, runId: 'r1' })));
    return { a, item: (await snap(I('i1'))) as unknown as ItemState };
  }

  it('ATTACK: progress cannot drop the claim; completing cannot keep it', async () => {
    const { a, item } = await holding();
    const progress = reportProgress(a.ctx, { projectId: 'p1', itemId: 'i1', item, costEur: 1 });
    await denied(
      a.run({
        ...progress,
        ops: progress.ops.map((op) =>
          op.path === I('i1') ? { ...op, data: { ...op.data, claim: null } } : op,
        ),
      }),
    );
    const done = completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item });
    await denied(
      a.run({
        ...done,
        ops: done.ops.map((op) =>
          op.path === I('i1') ? { ...op, data: { ...op.data, claim: item.claim } } : op,
        ),
      }),
    );
    await ok(a.run(progress));
  });

  it('an agent that holds the item attaches (the claim-kept route)', async () => {
    const { a, item } = await holding();
    await ok(
      a.run(
        attach(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          kind: 'text',
          name: 'n2',
          content: 'y',
          runId: item.claim!.runId,
        }),
      ),
    );
  });
});
