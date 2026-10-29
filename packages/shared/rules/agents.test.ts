/**
 * SPEC §5.1 agent rules: scoping, claims (incl. stale takeover), heartbeats, release,
 * progress, completion (one step forward), findings, attachments, questions, run logs.
 */
import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  attach,
  claimItem,
  completeStep,
  endRun,
  heartbeat,
  logLine,
  postMessage,
  raiseFinding,
  releaseClaim,
  reportProgress,
  SERVER_TIME,
  type ItemState,
} from '../src/actions';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  atGate,
  denied,
  eventOp,
  I,
  itemDoc,
  minutesAgo,
  now,
  ok,
  P,
  put,
  snap,
  steps,
  useEmulator,
  W,
} from './harness';

useEmulator();

const project = { steps: steps() };
const queued = itemDoc() as unknown as ItemState;

/** agentA claims p1/i1; returns its runId and the item as it now is. */
async function claimed(uid: string = AGENTS.a, iid = 'i1', stepId = 'draft') {
  const a = as(uid);
  const base = { ...queued, stepId };
  const p = claimItem(a.ctx, { projectId: 'p1', itemId: iid, item: base, runId: `run-${uid}` });
  await a.run(p);
  const item = {
    ...base,
    status: 'working',
    claim: { runId: p.runId, agentUid: uid, heartbeatAt: now() },
  } as ItemState;
  return { a, runId: p.runId, item };
}

describe('agent scoping and revocation', () => {
  it('allows an agent to read an allowed project and its items', async () => {
    const a = as(AGENTS.a);
    await ok(getDoc(doc(a.db, P('p1'))));
    await ok(getDoc(doc(a.db, I('i1'))));
  });
  it('allows a * agent to read every project', async () => {
    await ok(getDoc(doc(as(AGENTS.star).db, I('i1', 'p2'))));
  });
  it('ATTACK: denies an agent reading a project it is not allowed in', async () => {
    const a = as(AGENTS.a);
    await denied(getDoc(doc(a.db, P('p2'))));
    await denied(getDoc(doc(a.db, I('i1', 'p2'))));
  });
  it('ATTACK: denies an agent claiming in a project it is not allowed in', async () => {
    const a = as(AGENTS.a);
    await denied(a.run(claimItem(a.ctx, { projectId: 'p2', itemId: 'i1', item: queued })));
  });
  it('ATTACK: denies a revoked agent every read', async () => {
    const r = as(AGENTS.revoked);
    await denied(getDoc(doc(r.db, paths.workspace(W))));
    await denied(getDoc(doc(r.db, P('p1'))));
    await denied(getDoc(doc(r.db, I('i1'))));
    await denied(getDoc(doc(r.db, paths.agent(W, AGENTS.revoked))));
    await denied(getDoc(doc(r.db, paths.event(W, 'seed'))));
  });
  it('ATTACK: denies a revoked agent every write', async () => {
    const r = as(AGENTS.revoked);
    await denied(r.run(claimItem(r.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
    await denied(r.run([eventOp(r, 'e-rev', { type: 'run.started' })]));
  });
  it('denies an agent reading other workspace data it has no doc in', async () => {
    const a = as(AGENTS.a);
    await denied(getDoc(doc(a.db, paths.workspace('w2'))));
  });
  it('allows an agent its own agent doc and presence stamp, not other agents', async () => {
    const a = as(AGENTS.a);
    await ok(getDoc(doc(a.db, paths.agent(W, AGENTS.a))));
    await denied(getDoc(doc(a.db, paths.agent(W, AGENTS.star))));
    await ok(updateDoc(doc(a.db, paths.agent(W, AGENTS.a)), { lastSeenAt: serverTimestamp() }));
  });
  it('allows presence with the host name; ATTACK: not a long or non-string host', async () => {
    const a = as(AGENTS.a);
    const ref = doc(a.db, paths.agent(W, AGENTS.a));
    await ok(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'laptop' }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'x'.repeat(81) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 5 }));
  });
  it('allows the agent to write its own CLI version with presence; ATTACK: not long, not a number, not without presence, not another agent', async () => {
    const a = as(AGENTS.a);
    const ref = doc(a.db, paths.agent(W, AGENTS.a));
    await ok(
      updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'laptop', cliVersion: '0.2.170' }),
    );
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), cliVersion: 'x'.repeat(41) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), cliVersion: 5 }));
    await denied(updateDoc(ref, { cliVersion: '0.2.170' }));
    await denied(
      updateDoc(doc(a.db, paths.agent(W, AGENTS.star)), {
        lastSeenAt: serverTimestamp(),
        cliVersion: '9.9.9',
      }),
    );
    // A member (not the agent) cannot forge it either.
    for (const who of ['alice', 'bob']) {
      const m = as(who);
      await denied(updateDoc(doc(m.db, paths.agent(W, AGENTS.a)), { cliVersion: '9.9.9' }));
    }
  });
  it('allows the agent its own session and host id with presence (item N0biX); ATTACK: not long, not a number, not without presence, not another agent, not a member', async () => {
    const a = as(AGENTS.a);
    const ref = doc(a.db, paths.agent(W, AGENTS.a));
    const ids = { seenSession: 's'.repeat(24), seenHostId: 'h'.repeat(32) };
    await ok(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'box', ...ids }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenSession: 'x'.repeat(65) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHostId: 'x'.repeat(65) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenSession: 5 }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHostId: 5 }));
    await denied(updateDoc(ref, { seenSession: 'other' }));
    await denied(updateDoc(ref, { seenHostId: 'other' }));
    await denied(
      updateDoc(doc(a.db, paths.agent(W, AGENTS.star)), { lastSeenAt: serverTimestamp(), ...ids }),
    );
    for (const who of ['alice', 'bob', 'owner']) {
      const m = as(who);
      await denied(updateDoc(doc(m.db, paths.agent(W, AGENTS.a)), { seenSession: 'forged' }));
    }
  });
  it('ATTACK: denies an agent widening its own projectIds or un-revoking', async () => {
    const a = as(AGENTS.a);
    await denied(updateDoc(doc(a.db, paths.agent(W, AGENTS.a)), { projectIds: '*' }));
    const r = as(AGENTS.revoked);
    await denied(updateDoc(doc(r.db, paths.agent(W, AGENTS.revoked)), { revokedAt: null }));
  });
});

describe('claims', () => {
  it('allows claiming an unclaimed item at an agent step (starts a run)', async () => {
    const { a, runId } = await claimed();
    await ok(getDoc(doc(a.db, paths.run(W, runId))));
  });
  it('denies claiming an item that is freshly claimed by another agent', async () => {
    await claimed(AGENTS.a);
    const s = as(AGENTS.star);
    await denied(s.run(claimItem(s.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
  });
  it('allows taking over a stale claim (> 10 min without heartbeat)', async () => {
    await put({
      [I('i1')]: itemDoc({
        status: 'working',
        claim: { runId: 'old', agentUid: AGENTS.a, heartbeatAt: minutesAgo(11) },
      }),
    });
    const s = as(AGENTS.star);
    await ok(s.run(claimItem(s.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
  });
  it('denies taking over a claim that is 9 minutes old', async () => {
    await put({
      [I('i1')]: itemDoc({
        status: 'working',
        claim: { runId: 'old', agentUid: AGENTS.a, heartbeatAt: minutesAgo(9) },
      }),
    });
    const s = as(AGENTS.star);
    await denied(s.run(claimItem(s.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
  });
  it('ATTACK: denies claiming an item at a human step', async () => {
    const a = as(AGENTS.a);
    await denied(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'gated', item: queued })));
  });
  it('denies claiming a finding that has not been triaged (a suggestion or an old queued one)', async () => {
    await put({ [I('f1')]: itemDoc({ stepId: 'intake', type: 'finding', status: 'suggested' }) });
    const a = as(AGENTS.a);
    const item = { ...queued, stepId: 'intake' };
    await denied(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'f1', item })));
    await denied(
      a.run(
        claimItem(a.ctx, {
          projectId: 'p1',
          itemId: 'f1',
          item: { ...item, status: 'suggested' } as ItemState,
        }),
      ),
    );
    await put({ [I('f1')]: itemDoc({ stepId: 'intake', type: 'finding' }) });
    await denied(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'f1', item })));
    await put({
      [I('f1')]: itemDoc({
        stepId: 'intake',
        type: 'finding',
        triage: { outcome: 'intake', reason: '', byUid: 'alice', at: now() },
      }),
    });
    await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'f1', item })));
  });
  it('ATTACK: denies a claim written for another agent', async () => {
    const a = as(AGENTS.a);
    const p = claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued });
    const forged = p.ops.map((op) =>
      op.path === I('i1')
        ? {
            ...op,
            data: {
              ...op.data,
              claim: { runId: p.runId, agentUid: AGENTS.star, heartbeatAt: SERVER_TIME },
            },
          }
        : op,
    );
    await denied(a.run(forged));
  });
  it('ATTACK: denies a claim without its run', async () => {
    const a = as(AGENTS.a);
    const p = claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued });
    await denied(a.run(p.ops.filter((op) => !op.path.includes('/runs/'))));
  });
  it('denies a human claiming an item', async () => {
    const h = as('alice');
    const p = claimItem(
      { ...h.ctx, actor: { ...h.ctx.actor, type: 'agent' } },
      {
        projectId: 'p1',
        itemId: 'i1',
        item: queued,
      },
    );
    await denied(h.run(p));
  });
});

describe('heartbeat, progress, release, end', () => {
  it('allows a quiet heartbeat on own claim within the coalescing window', async () => {
    const { a, runId } = await claimed();
    const hb = heartbeat(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      lastHeartbeatEventAtMs: Date.now(),
    });
    await ok(a.run(hb));
  });
  it('allows a tracked heartbeat once 5 minutes passed, and requires it after 6', async () => {
    const { a, runId } = await claimed();
    const runRef = paths.run(W, runId);
    // pretend the last heartbeat event was 7 minutes ago
    await put({ [runRef]: { ...(await snap(runRef)), heartbeatEventAt: minutesAgo(7) } });
    const quiet = heartbeat(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      lastHeartbeatEventAtMs: Date.now(),
    });
    await denied(a.run(quiet));
    const tracked = heartbeat(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      lastHeartbeatEventAtMs: Date.now() - 7 * 60_000,
    });
    await ok(a.run(tracked));
  });
  it('ATTACK: denies a tracked heartbeat sooner than 5 minutes (event spam)', async () => {
    const { a, runId } = await claimed();
    const tracked = heartbeat(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      lastHeartbeatEventAtMs: 0,
    });
    await denied(a.run(tracked));
  });
  it("ATTACK: denies heartbeating someone else's claim", async () => {
    const { runId } = await claimed(AGENTS.a);
    const s = as(AGENTS.star);
    await denied(
      s.run(
        heartbeat(s.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          runId,
          lastHeartbeatEventAtMs: Date.now(),
        }),
      ),
    );
  });
  it('denies an item heartbeat without the run heartbeat', async () => {
    const { a, runId } = await claimed();
    const hb = heartbeat(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      lastHeartbeatEventAtMs: Date.now(),
    });
    await denied(a.run(hb.ops.filter((op) => op.path === I('i1'))));
  });
  it('allows progress and cost on own claim; denies lowering cost', async () => {
    const { a, item } = await claimed();
    await ok(
      a.run(
        reportProgress(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item,
          progress: { done: 1, total: 3 },
          costEur: 0.4,
        }),
      ),
    );
    await denied(
      a.run(reportProgress(a.ctx, { projectId: 'p1', itemId: 'i1', item, costEur: 0.1 })),
    );
  });
  it('allows releasing own claim; denies releasing another agent’s', async () => {
    const { item } = await claimed(AGENTS.a);
    const s = as(AGENTS.star);
    const forged = { ...item, claim: { ...item.claim!, agentUid: AGENTS.star } };
    await denied(s.run(releaseClaim(s.ctx, { projectId: 'p1', itemId: 'i1', item: forged })));
    const a = as(AGENTS.a);
    await ok(a.run(releaseClaim(a.ctx, { projectId: 'p1', itemId: 'i1', item })));
  });
  it('allows ending own run as failed; denies writing to an ended run', async () => {
    const { a, runId } = await claimed();
    const end = endRun(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      result: { status: 'failed', costEur: 0.1 },
    });
    await ok(a.run(end));
    await denied(
      a.run(
        heartbeat(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          runId,
          lastHeartbeatEventAtMs: Date.now(),
        }),
      ),
    );
  });
  it("ATTACK: denies ending another agent's run", async () => {
    const { runId } = await claimed(AGENTS.a);
    const s = as(AGENTS.star);
    await denied(
      s.run(endRun(s.ctx, { projectId: 'p1', itemId: 'i1', runId, result: { status: 'done' } })),
    );
  });
});

describe('completing a step', () => {
  it('allows moving exactly one step forward (draft → review opens the gate)', async () => {
    const { a, item } = await claimed();
    await ok(
      a.run(
        completeStep(a.ctx, {
          project,
          projectId: 'p1',
          itemId: 'i1',
          item,
          result: { costEur: 0.2 },
        }),
      ),
    );
    const after = await snap(I('i1'));
    if (after.stepId !== 'review' || after.status !== 'waiting')
      throw new Error('did not reach the gate');
  });
  it('clears the progress ring when the step completes', async () => {
    await put({ [I('i1')]: itemDoc({ progress: { done: 1, total: 3 } }) });
    const { a, item } = await claimed();
    await ok(a.run(completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item })));
    const after = await snap(I('i1'));
    if (after.progress !== null) throw new Error('progress was kept after completion');
  });
  it('allows finishing the last agent step (status done)', async () => {
    await put({ [I('i1')]: itemDoc({ stepId: 'publish' }) });
    const { a, item } = await claimed(AGENTS.a, 'i1', 'publish');
    await ok(a.run(completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item })));
  });
  it('ATTACK: denies an agent skipping the gate (draft → publish)', async () => {
    const { a, item } = await claimed();
    const p = completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item });
    const skip = p.ops.map((op) =>
      op.path === I('i1')
        ? { ...op, data: { ...op.data, stepId: 'publish', status: 'queued', gate: null } }
        : op,
    );
    await denied(a.run(skip));
  });
  it('ATTACK: denies arriving at the gate with approvals pre-filled', async () => {
    const { a, item } = await claimed();
    const p = completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item });
    const forged = p.ops.map((op) =>
      op.path === I('i1')
        ? {
            ...op,
            data: {
              ...op.data,
              gate: {
                stepId: 'review',
                approvals: { alice: { at: SERVER_TIME, rationale: '' } },
                rejections: {},
              },
            },
          }
        : op,
    );
    await denied(a.run(forged));
  });
  it('ATTACK: denies an agent moving an item backwards', async () => {
    const { a, item } = await claimed();
    const p = completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item });
    const back = p.ops.map((op) =>
      op.path === I('i1')
        ? { ...op, data: { ...op.data, stepId: 'intake', status: 'queued', gate: null } }
        : op,
    );
    await denied(a.run(back));
  });
  it('ATTACK: denies an agent moving an item out of a human step', async () => {
    // Even holding a (forged-in) claim on it, an agent cannot move an item at a human gate.
    await put({
      [I('gated')]: { ...atGate(), claim: { runId: 'r', agentUid: AGENTS.a, heartbeatAt: now() } },
    });
    const a = as(AGENTS.a);
    const p = completeStep(a.ctx, {
      project: {
        steps: project.steps.map((s) => ({ ...s, kind: 'agent' as const, gate: undefined })),
      },
      projectId: 'p1',
      itemId: 'gated',
      item: {
        ...queued,
        stepId: 'review',
        claim: { runId: 'r', agentUid: AGENTS.a, heartbeatAt: now() },
      } as ItemState,
    });
    await denied(a.run(p.ops.filter((op) => !op.path.includes('/runs/'))));
  });
  it('denies completing without holding the claim', async () => {
    const a = as(AGENTS.a);
    const p = completeStep(a.ctx, {
      project,
      projectId: 'p1',
      itemId: 'i1',
      item: {
        ...queued,
        claim: { runId: 'r', agentUid: AGENTS.a, heartbeatAt: now() },
      } as ItemState,
    });
    await denied(a.run(p.ops.filter((op) => !op.path.includes('/runs/'))));
  });
});

describe('findings, attachments, questions, logs', () => {
  it('allows the claiming agent to raise a suggestion, recording its run', async () => {
    const { a, item, runId } = await claimed();
    const p = raiseFinding(a.ctx, {
      project,
      projectId: 'p1',
      parentItemId: 'i1',
      parent: item,
      title: 'Broken link',
      details: 'Found on /about',
    });
    await ok(a.run(p));
    expect(await snap(I(p.itemId))).toMatchObject({
      status: 'suggested',
      stepId: 'intake',
      sourceRunId: runId,
      claim: null,
      gate: null,
    });
  });
  it('allows any agent allowed on the project to raise a suggestion without holding the item', async () => {
    const s = as(AGENTS.star);
    const p = raiseFinding(s.ctx, {
      project,
      projectId: 'p1',
      parentItemId: 'i1',
      parent: queued,
      title: 'Footer link is broken',
      details: '',
    });
    await ok(s.run(p));
    expect(await snap(I(p.itemId))).toMatchObject({ status: 'suggested', sourceRunId: null });
  });
  it('ATTACK: denies a suggestion filed as work, past the first step, with a borrowed run, on a missing item or out of scope', async () => {
    const { item } = await claimed(AGENTS.a);
    const s = as(AGENTS.star);
    const base = () =>
      raiseFinding(s.ctx, {
        project,
        projectId: 'p1',
        parentItemId: 'i1',
        parent: { title: 'x', claim: null },
        title: 'x',
        details: 'y',
      });
    const patched = (over: Record<string, unknown>) => {
      const p = base();
      return {
        ...p,
        ops: p.ops.map((op) =>
          op.path.includes('/items/') ? { ...op, data: { ...op.data, ...over } } : op,
        ),
      };
    };
    // as claimable work
    await denied(s.run(patched({ status: 'queued' })));
    // past the first step
    await denied(s.run(patched({ stepId: 'publish' })));
    // claiming another agent's run
    await denied(s.run(patched({ sourceRunId: item.claim!.runId })));
    // about an item that does not exist
    await denied(s.run(patched({ parentItemId: 'nope' })));
    // in a project the agent may not use
    const a = as(AGENTS.a);
    await denied(
      a.run(
        raiseFinding(a.ctx, {
          project,
          projectId: 'p2',
          parentItemId: 'i1',
          parent: { title: 'x', claim: null },
          title: 'x',
          details: 'y',
        }),
      ),
    );
  });
  it('allows the claiming agent to attach; denies others and oversize', async () => {
    const { a, runId } = await claimed();
    await ok(
      a.run(
        attach(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          kind: 'html',
          name: 'report.html',
          content: '<h1>Hi</h1>',
          runId,
        }),
      ),
    );
    await ok(
      a.run(
        attach(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          kind: 'link',
          name: 'big.pdf',
          url: 'https://example.com/big.pdf',
          runId,
        }),
      ),
    );
    const s = as(AGENTS.star);
    await denied(
      s.run(
        attach(s.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          kind: 'text',
          name: 'x',
          content: 'x',
          runId,
        }),
      ),
    );
    const big = attach(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      kind: 'text',
      name: 'x',
      content: 'x',
      runId,
    });
    const oversized = big.ops.map((op) =>
      op.path.includes('/attachments/')
        ? { ...op, data: { ...op.data, content: 'x'.repeat(921_601), bytes: 921_601 } }
        : op,
    );
    await denied(a.run(oversized));
  });
  it('counts attachments on the item (card 05PEkpwG): +1 per attach, never anything else', async () => {
    const { a, runId } = await claimed();
    const input = {
      projectId: 'p1',
      itemId: 'i1',
      kind: 'text' as const,
      name: 'n',
      content: 'x',
      runId,
    };
    await ok(a.run(attach(a.ctx, input)));
    expect((await snap(I('i1'))).attachmentCount).toBe(1);
    await ok(a.run(attach(a.ctx, input)));
    expect((await snap(I('i1'))).attachmentCount).toBe(2);
    // ATTACK: bumping the counter by 5 alongside an attachment, or on its own.
    const jump = attach(a.ctx, input);
    const bumped = jump.ops.map((op) =>
      op.path === I('i1') ? { ...op, data: { ...op.data, attachmentCount: 9 } } : op,
    );
    await denied(a.run(bumped));
    await denied(a.run(jump.ops.filter((op) => !op.path.includes('/attachments/'))));
  });
  it('allows the claiming agent to ask a question; denies an agent posting an answer', async () => {
    const { a } = await claimed();
    await ok(
      a.run(
        postMessage(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          kind: 'question',
          text: 'Which audience?',
        }),
      ),
    );
    const p = postMessage(a.ctx, { projectId: 'p1', itemId: 'i1', kind: 'note', text: 'x' });
    const ans = p.ops.map((op) =>
      op.path.includes('/messages/') ? { ...op, data: { ...op.data, kind: 'answer' } } : op,
    );
    await denied(a.run(ans));
  });
  it('allows log lines 0..499 on own open run; denies 500, others and edits', async () => {
    const { a, runId } = await claimed();
    await ok(a.run([logLine(a.ctx, { runId, n: 0, level: 'info', text: 'start' })]));
    await ok(a.run([logLine(a.ctx, { runId, n: 499, level: 'warn', text: 'last' })]));
    const tooMany = {
      ...logLine(a.ctx, { runId, n: 1, level: 'info', text: 'x' }),
      path: paths.run(W, runId) + '/log/500',
    };
    await denied(a.run([tooMany]));
    const s = as(AGENTS.star);
    await denied(s.run([logLine(s.ctx, { runId, n: 2, level: 'info', text: 'x' })]));
    await denied(updateDoc(doc(a.db, paths.logLine(W, runId, 0)), { text: 'rewritten' }));
  });
});
