/**
 * Card BrK0r2FE: Stop work from the UI. A person who may (admins, deciders of any gate of the
 * project) ends an agent's run on an item: Go back (held at its step until Resume, no agent may
 * claim it) or Cancel completely (item stopped). The run ends as `stopped`, not failed, in the
 * same batch, so it works while the agent's CLI is offline.
 */
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  claimItem,
  endRun,
  resumeWork,
  SERVER_TIME,
  stopWork,
  type ItemState,
  type ProjectState,
} from '../src/actions';
import { buildStepIndex, paths, type Step } from '../src/schema';
import { stopGateFor } from '../src/stopwork';
import {
  AGENTS,
  as,
  denied,
  eventOp,
  gate,
  I,
  itemDoc,
  minutesAgo,
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
const queued = itemDoc() as unknown as ItemState;
const R = (rid: string) => paths.run(W, rid);

/** Agent A claims i1 at the Draft step (an agent step). */
async function working(runId = 'r1') {
  const a = as(AGENTS.a);
  await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued, runId })));
  return { a, runId, item: (await snap(I('i1'))) as unknown as ItemState };
}

function stopAs(
  uid: string,
  item: ItemState,
  over: Partial<Parameters<typeof stopWork>[1]> = {},
  proj: ProjectState = project,
) {
  const x = as(uid);
  const gateStepId = stopGateFor(proj, uid, uid === 'owner');
  return x.run(
    stopWork(x.ctx, {
      project: proj,
      projectId: 'p1',
      itemId: 'i1',
      item,
      mode: 'back',
      reason: 'Wrong brief, I will rewrite it first',
      gateStepId,
      run: { costEur: 0, endedAt: null },
      ...over,
    }),
  );
}

const claimBy = (uid: string, item: ItemState) => {
  const x = as(uid);
  return x.run(claimItem(x.ctx, { projectId: 'p1', itemId: 'i1', item }));
};

describe('stop work: go back', () => {
  it('an admin stops it: claim cleared, run stopped (not failed), item on hold; nobody claims it', async () => {
    const { item, runId } = await working();
    await ok(stopAs('owner', item));
    const d = await snap(I('i1'));
    expect(d).toMatchObject({ status: 'queued', claim: null, stepId: 'draft' });
    expect(d.workStopped).toMatchObject({
      mode: 'back',
      byUid: 'owner',
      reason: 'Wrong brief, I will rewrite it first',
      runId,
    });
    const run = await snap(R(runId));
    expect(run).toMatchObject({ status: 'stopped', stoppedBy: { uid: 'owner', name: 'Owner' } });
    expect(run.endedAt).toBeTruthy();
    expect(String(run.summary)).toContain('Stopped by Owner');
    // Not a failure: the agent's failure streak is untouched.
    expect((await snap(paths.agent(W, AGENTS.a))).failStreak).toBeUndefined();
    // The reason reaches the next agent as a note.
    const ev = d.lastEventId as string;
    expect(await snap(paths.message(W, 'p1', 'i1', `${ev}-note`))).toMatchObject({
      kind: 'note',
      text: 'Work stopped: Wrong brief, I will rewrite it first',
    });
    const held = d as unknown as ItemState;
    await denied(claimBy(AGENTS.a, held));
    await denied(claimBy(AGENTS.star, held));
  });

  it('a held item with a stale claim cannot be taken over either', async () => {
    await put({
      [I('i1')]: itemDoc({
        status: 'working',
        claim: { runId: 'old', agentUid: AGENTS.a, heartbeatAt: minutesAgo(30) },
        workStopped: { mode: 'back', byUid: 'owner', at: minutesAgo(31), reason: '', runId: 'x' },
      }),
    });
    await denied(claimBy(AGENTS.star, (await snap(I('i1'))) as unknown as ItemState));
  });

  it('Resume releases it (admin or decider); a member, an agent or an outsider may not', async () => {
    const { item } = await working();
    await ok(stopAs('alice', item));
    const held = (await snap(I('i1'))) as unknown as ItemState;
    const resumeAs = (uid: string, gateStepId: string | null = null) => {
      const x = as(uid);
      return x.run(resumeWork(x.ctx, { projectId: 'p1', itemId: 'i1', item: held, gateStepId }));
    };
    await denied(resumeAs('dave'));
    // ATTACK: naming a gate dave does not decide at, or an agent step.
    await denied(resumeAs('dave', 'review'));
    await denied(resumeAs('dave', 'draft'));
    await denied(resumeAs('eve'));
    const a = as(AGENTS.a);
    await denied(updateDoc(doc(a.db, I('i1')), { workStopped: null }));
    await ok(resumeAs('bob', 'review'));
    const d = await snap(I('i1'));
    expect(d.workStopped).toBeNull();
    expect(d.status).toBe('queued');
    await ok(claimBy(AGENTS.star, d as unknown as ItemState));
  });

  it('an admin resumes without naming a gate', async () => {
    const { item } = await working();
    await ok(stopAs('owner', item));
    const held = (await snap(I('i1'))) as unknown as ItemState;
    const owner = as('owner');
    await ok(owner.run(resumeWork(owner.ctx, { projectId: 'p1', itemId: 'i1', item: held })));
  });
});

describe('stop work: cancel completely', () => {
  it('a decider of the gate stops the item for good', async () => {
    const { item, runId } = await working();
    await ok(stopAs('alice', item, { mode: 'cancel', reason: '' }));
    const d = await snap(I('i1'));
    expect(d).toMatchObject({ status: 'stopped', claim: null });
    expect(d.workStopped).toMatchObject({ mode: 'cancel', byUid: 'alice', reason: '' });
    expect(await snap(R(runId))).toMatchObject({ status: 'stopped' });
    await denied(claimBy(AGENTS.a, d as unknown as ItemState));
    // Resume is only for a held item.
    const alice = as('alice');
    await denied(
      alice.run([
        {
          kind: 'update',
          path: I('i1'),
          data: { workStopped: null, updatedAt: SERVER_TIME, lastEventId: 'e-res' },
        },
        eventOp(alice, 'e-res', {
          itemId: 'i1',
          type: 'item.resumed',
          data: { gateStepId: 'review' },
        }),
      ]),
    );
  });

  it('a decider of another gate of the project may stop it too (João, Q23)', async () => {
    // spec (gate: carol) -> draft (agent) -> review (gate: alice, bob) -> publish
    const s: Step[] = [
      {
        id: 'spec',
        name: 'Spec',
        kind: 'human',
        description: '',
        gate: gate({ deciderUids: ['carol'] }),
      },
      ...steps({ deciderUids: ['alice', 'bob'] }).slice(1),
    ];
    const two = { steps: s } as ProjectState;
    await put({
      [P('p1')]: projectDoc({}, { steps: two.steps, stepIndex: buildStepIndex(two.steps) }),
    });
    const { item } = await working();
    // dave decides nowhere.
    await denied(stopAs('dave', item, {}, two));
    await denied(stopAs('dave', item, { gateStepId: 'spec' }, two));
    expect(stopGateFor(two, 'carol', false)).toBe('spec');
    await ok(stopAs('carol', item, { mode: 'cancel' }, two));
  });
});

describe('stop work: attacks', () => {
  it('a member who decides nowhere, an outsider and an agent cannot stop work', async () => {
    const { item, runId } = await working();
    await denied(stopAs('dave', item));
    await denied(stopAs('dave', item, { gateStepId: 'review' }));
    await denied(stopAs('dave', item, { gateStepId: 'draft' }));
    await denied(stopAs('eve', item, { gateStepId: 'review' }));
    // ATTACK: an agent (any, even the one holding it) writes the stop by hand.
    const star = as(AGENTS.star);
    await denied(
      star.run([
        {
          kind: 'update',
          path: I('i1'),
          data: {
            claim: null,
            status: 'queued',
            workStopped: { mode: 'back', byUid: AGENTS.star, at: SERVER_TIME, reason: '', runId },
            costEur: 0,
            updatedAt: SERVER_TIME,
            lastEventId: 'e-stop',
          },
        },
        {
          kind: 'update',
          path: R(runId),
          data: {
            status: 'stopped',
            endedAt: SERVER_TIME,
            stoppedBy: { uid: AGENTS.star, name: 'x' },
            summary: 'x',
            lastEventId: 'e-stop',
          },
        },
        eventOp(star, 'e-stop', {
          itemId: 'i1',
          runId,
          type: 'item.workStopped',
          data: { mode: 'back' },
        }),
      ]),
    );
    expect(await snap(I('i1'))).toMatchObject({ status: 'working' });
  });

  it('the run must end in the same batch, as stopped by the person', async () => {
    const { item, runId } = await working();
    const owner = as('owner');
    const p = stopWork(owner.ctx, {
      project,
      projectId: 'p1',
      itemId: 'i1',
      item,
      mode: 'back',
      run: { costEur: 0, endedAt: null },
    });
    // Without the run's end, the item would point at a run that still runs.
    await denied(owner.run(p.ops.filter((o) => o.path !== R(runId))));
    // ATTACK: ending it as failed (would count toward the agent's pause), or in someone else's name.
    const tamper = (data: Record<string, unknown>) =>
      p.ops.map((o) => (o.path === R(runId) ? { ...o, data: { ...o.data, ...data } } : o));
    await denied(owner.run(tamper({ status: 'failed' })));
    await denied(owner.run(tamper({ stoppedBy: { uid: 'alice', name: 'Alice' } })));
    // ATTACK: the hold says cancel while the item stays queued.
    const item2 = p.ops.map((o) =>
      o.path === I('i1')
        ? {
            ...o,
            data: {
              ...o.data,
              workStopped: { ...(o.data!.workStopped as object), mode: 'cancel' },
            },
          }
        : o,
    );
    await denied(owner.run(item2));
    await ok(owner.run(p));
  });

  it('a person cannot end a run as stopped without stopping its item', async () => {
    const { runId } = await working();
    const owner = as('owner');
    await denied(
      owner.run([
        {
          kind: 'update',
          path: R(runId),
          data: {
            status: 'stopped',
            endedAt: SERVER_TIME,
            stoppedBy: { uid: 'owner', name: 'Owner' },
            summary: 'x',
            lastEventId: 'e-x',
          },
        },
        eventOp(owner, 'e-x', {
          itemId: 'i1',
          runId,
          type: 'item.workStopped',
          data: { mode: 'back' },
        }),
      ]),
    );
  });

  it('nothing to stop on an item nobody holds, or at a gate', async () => {
    const owner = as('owner');
    expect(() =>
      stopWork(owner.ctx, { project, projectId: 'p1', itemId: 'i1', item: queued, mode: 'back' }),
    ).toThrow(/No agent/);
    const gated = (await snap(I('gated'))) as unknown as ItemState;
    expect(() =>
      stopWork(owner.ctx, { project, projectId: 'p1', itemId: 'gated', item: gated, mode: 'back' }),
    ).toThrow(/No agent/);
  });

  it('after the stop the agent can no longer end or use its run', async () => {
    const { a, item, runId } = await working();
    await ok(stopAs('owner', item));
    await denied(
      a.run(endRun(a.ctx, { projectId: 'p1', itemId: 'i1', runId, result: { status: 'failed' } })),
    );
    await denied(updateDoc(doc(a.db, R(runId)), { heartbeatAt: serverTimestamp() }));
  });

  it('a run that already ended (done, claim kept) is left alone; the claim is still cleared', async () => {
    const { a, item, runId } = await working();
    await ok(
      a.run(endRun(a.ctx, { projectId: 'p1', itemId: 'i1', runId, result: { status: 'done' } })),
    );
    await ok(stopAs('owner', item, { mode: 'cancel', run: { costEur: 0, endedAt: new Date() } }));
    expect(await snap(R(runId))).toMatchObject({ status: 'done' });
    expect(await snap(I('i1'))).toMatchObject({ status: 'stopped', claim: null });
  });
});
