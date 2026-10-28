/**
 * Card zSzW3LXy: agent settings, per-step allowed agents and guardrails.
 * - settings (projects, guardrails, permissions, resume) are admin-only; agents cannot touch them;
 * - per-step allowed agents: only admins and the project's creator change them; a limited step
 *   is claimable by the listed agents only;
 * - the failure streak: kept by the agent in the batch that ends its run, pausing it at the limit;
 *   a paused agent claims nothing until an admin resumes it;
 * - token usage on heartbeats only grows; cache reads are part of tokensIn.
 */
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  claimItem,
  completeStep,
  createAgent,
  endRun,
  heartbeat,
  releaseClaim,
  resumeAgent,
  saveProcess,
  setStepAgents,
  updateAgentSettings,
  type AgentGuardState,
  type ItemState,
} from '../src/actions';
import { buildStepIndex, paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  I,
  itemDoc,
  now,
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

const A = (uid: string) => paths.agent(W, uid);
const queued = itemDoc() as unknown as ItemState;
const project = { steps: steps() };

async function claimed(uid: string = AGENTS.a, runId = `run-${uid}`) {
  const a = as(uid);
  await a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued, runId }));
  const item = {
    ...queued,
    status: 'working',
    claim: { runId, agentUid: uid, heartbeatAt: now() },
  } as ItemState;
  return { a, runId, item };
}

async function agentState(uid: string): Promise<AgentGuardState> {
  const d = await snap(A(uid));
  return d as unknown as AgentGuardState;
}

/** agentA's doc as seeded (allowed in p1), plus overrides. */
function agentA(over: Record<string, unknown> = {}) {
  return {
    name: 'Agent',
    color: '#2F5FD0',
    projectIds: ['p1'],
    createdBy: 'owner',
    createdAt: now(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
    ...over,
  };
}

/** Resets i1 to a fresh queued item so the next run can claim it. */
const requeue = () => put({ [I('i1')]: itemDoc() });

describe('agent settings', () => {
  it('lets an admin set projects and guardrails; old docs with a token limit or permissions still read', async () => {
    const owner = as('owner');
    await ok(
      owner.run(
        updateAgentSettings(owner.ctx, {
          agentUid: AGENTS.a,
          name: 'Agent',
          projectIds: ['p1', 'p2'],
          guardrails: { maxFailedRuns: 5 },
        }),
      ),
    );
    const d = await snap(A(AGENTS.a));
    expect(d.guardrails).toEqual({ maxFailedRuns: 5 });
    expect(d.permissions).toBeUndefined();
    // An old agent doc (card rifzGl8M): stored token limit and allow-list are ignored, not broken,
    // and an admin can still save its projects.
    await put({
      [A(AGENTS.a)]: agentA({
        guardrails: { maxFailedRuns: 2, maxTokensPerItem: 250_000 },
        permissions: ['runCommands'],
      }),
    });
    await ok(
      owner.run(
        updateAgentSettings(owner.ctx, { agentUid: AGENTS.a, name: 'Agent', projectIds: ['p1'] }),
      ),
    );
  });
  it('ATTACK: denies a member, an agent itself, and out-of-range values', async () => {
    const alice = as('alice');
    await denied(
      alice.run(
        updateAgentSettings(alice.ctx, {
          agentUid: AGENTS.a,
          name: 'Agent',
          guardrails: { maxFailedRuns: 3 },
        }),
      ),
    );
    const a = as(AGENTS.a);
    await denied(
      updateDoc(doc(a.db, A(AGENTS.a)), {
        guardrails: { maxFailedRuns: 20, maxTokensPerItem: 100_000_000 },
      }),
    );
    await denied(updateDoc(doc(a.db, A(AGENTS.a)), { permissions: ['runCommands'] }));
    const owner = as('owner');
    for (const guardrails of [{ maxFailedRuns: 0 }, { maxFailedRuns: 21 }])
      await denied(
        owner.run(updateAgentSettings(owner.ctx, { agentUid: AGENTS.a, name: 'A', guardrails })),
      );
  });
  it('creates an agent with settings, never already paused', async () => {
    const owner = as('owner');
    await ok(
      owner.run(
        createAgent(owner.ctx, {
          agentUid: 'agentNew',
          name: 'New',
          color: 'agent-1',
          projectIds: ['p1'],
          tokenHint: 'abcd',
          guardrails: { maxFailedRuns: 2 },
        }),
      ),
    );
    const p = createAgent(owner.ctx, {
      agentUid: 'agentPaused',
      name: 'New',
      color: 'agent-1',
      projectIds: ['p1'],
      tokenHint: 'abcd',
    });
    (p.ops[0]!.data as Record<string, unknown>).pausedAt = null;
    await denied(owner.run(p));
  });
});

describe('per-step allowed agents', () => {
  it('a step limited to agent X is claimable by X only; an empty list means any agent', async () => {
    await put({ [P('p1')]: projectDoc({}, { stepAgents: { draft: [AGENTS.star] } }) });
    const a = as(AGENTS.a);
    await denied(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
    const s = as(AGENTS.star);
    await ok(s.run(claimItem(s.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));

    await put({ [P('p1')]: projectDoc({}, { stepAgents: { draft: [] } }), [I('i1')]: itemDoc() });
    await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
  });
  it('limits on other steps do not matter', async () => {
    await put({ [P('p1')]: projectDoc({}, { stepAgents: { publish: [AGENTS.star] } }) });
    const a = as(AGENTS.a);
    await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
  });
  it('admins and the project creator set the limits; other members cannot', async () => {
    const owner = as('owner');
    await ok(
      owner.run(
        setStepAgents(owner.ctx, {
          projectId: 'p1',
          steps: steps(),
          stepAgents: { draft: [AGENTS.a] },
        }),
      ),
    );
    expect((await snap(P('p1'))).stepAgents).toEqual({ draft: [AGENTS.a] });

    const alice = as('alice');
    await denied(
      alice.run(
        setStepAgents(alice.ctx, {
          projectId: 'p1',
          steps: steps(),
          stepAgents: { draft: [AGENTS.a, AGENTS.star] },
        }),
      ),
    );
    await denied(
      alice.run(setStepAgents(alice.ctx, { projectId: 'p1', steps: steps(), stepAgents: {} })),
    );
    // A member who created the project may.
    await put({ [P('p1')]: projectDoc({}, { createdBy: 'alice' }) });
    await ok(
      alice.run(
        setStepAgents(alice.ctx, {
          projectId: 'p1',
          steps: steps(),
          stepAgents: { draft: [AGENTS.star] },
        }),
      ),
    );
  });
  it('a member editing the process keeps the limits, and may drop the limit of a step it removes', async () => {
    await put({
      [P('p1')]: projectDoc({}, { stepAgents: { draft: [AGENTS.a], publish: [AGENTS.a] } }),
    });
    const alice = as('alice');
    const s = steps();
    // Rename a step, limits unchanged.
    const renamed = s.map((x) => (x.id === 'draft' ? { ...x, name: 'Write' } : x));
    await ok(
      alice.run(
        saveProcess(alice.ctx, {
          projectId: 'p1',
          steps: renamed,
          before: s,
          stepAgents: { draft: [AGENTS.a], publish: [AGENTS.a] },
        }),
      ),
    );
    // Remove the publish step: its limit goes with it.
    const fewer = renamed.filter((x) => x.id !== 'publish');
    await ok(
      alice.run(
        saveProcess(alice.ctx, {
          projectId: 'p1',
          steps: fewer,
          before: renamed,
          stepAgents: { draft: [AGENTS.a], publish: [AGENTS.a] },
        }),
      ),
    );
    expect((await snap(P('p1'))).stepAgents).toEqual({ draft: [AGENTS.a] });
    // ATTACK: dropping the limit of a step that stays.
    await denied(
      alice.run(
        saveProcess(alice.ctx, { projectId: 'p1', steps: fewer, before: fewer, stepAgents: {} }),
      ),
    );
  });
});

describe('per-step allowed agents on a long process', () => {
  it('a member saving a 30-step process with limits stays within the rules budget', async () => {
    const long = [
      ...steps(),
      ...Array.from({ length: 26 }, (_, i) => ({
        id: `x${i}`,
        name: `X${i}`,
        kind: 'agent' as const,
        description: '',
      })),
    ];
    const stepAgents = { draft: [AGENTS.a], x25: [AGENTS.star] };
    await put({
      [P('p1')]: projectDoc({}, { steps: long, stepIndex: buildStepIndex(long), stepAgents }),
    });
    const next = long.map((st) => (st.id === 'x24' ? { ...st, name: 'Renamed' } : st));
    const dave = as('dave');
    await ok(
      dave.run(saveProcess(dave.ctx, { projectId: 'p1', steps: next, before: long, stepAgents })),
    );
  });
});

describe('failure streak and pause', () => {
  async function failRun(runId: string) {
    await requeue();
    const { a } = await claimed(AGENTS.a, runId);
    const agent = await agentState(AGENTS.a);
    return a.run(
      endRun(a.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        runId,
        result: { status: 'failed' },
        agent,
      }),
    );
  }

  it('3 failed runs in a row pause the agent; a paused agent cannot claim; an admin resumes it', async () => {
    await ok(failRun('r1'));
    await ok(failRun('r2'));
    expect((await snap(A(AGENTS.a))).failStreak).toBe(2);
    expect((await snap(A(AGENTS.a))).pausedAt ?? null).toBeNull();
    await ok(failRun('r3'));
    const d = await snap(A(AGENTS.a));
    expect(d.failStreak).toBe(3);
    expect(d.pausedAt).toBeTruthy();
    expect(d.pausedReason).toBe('3 failed runs in a row');

    await requeue();
    const a = as(AGENTS.a);
    await denied(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
    // ATTACK: the agent cannot resume itself.
    await denied(
      updateDoc(doc(a.db, A(AGENTS.a)), { pausedAt: null, pausedReason: null, failStreak: 0 }),
    );
    // A member cannot resume it either.
    const alice = as('alice');
    await denied(alice.run(resumeAgent(alice.ctx, { agentUid: AGENTS.a, name: 'Agent' })));

    const owner = as('owner');
    await ok(owner.run(resumeAgent(owner.ctx, { agentUid: AGENTS.a, name: 'Agent' })));
    expect((await snap(A(AGENTS.a))).failStreak).toBe(0);
    await ok(a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued })));
  });

  it('honours the agent’s own limit, and a done run resets the streak', async () => {
    await put({
      [A(AGENTS.a)]: agentA({ guardrails: { maxFailedRuns: 1, maxTokensPerItem: 500_000 } }),
    });
    await ok(failRun('r1'));
    expect((await snap(A(AGENTS.a))).pausedAt).toBeTruthy();

    await put({ [A(AGENTS.a)]: agentA({ pausedAt: null, failStreak: 2 }) });
    await requeue();
    const { a, item } = await claimed(AGENTS.a, 'r-done');
    await ok(
      a.run(
        completeStep(a.ctx, {
          project,
          projectId: 'p1',
          itemId: 'i1',
          item,
          agent: await agentState(AGENTS.a),
        }),
      ),
    );
    expect((await snap(A(AGENTS.a))).failStreak).toBe(0);
  });

  it('a run given back for a question (released) does not count; one stopped by the token limit does', async () => {
    const { a, item } = await claimed(AGENTS.a, 'r-rel');
    const agent = await agentState(AGENTS.a);
    const plan = releaseClaim(a.ctx, { projectId: 'p1', itemId: 'i1', item, agent });
    expect(plan.ops.some((o) => o.path === A(AGENTS.a))).toBe(false);
    await ok(a.run(plan));

    const c2 = await claimed(AGENTS.a, 'r-limit');
    await ok(
      c2.a.run(
        releaseClaim(c2.a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: c2.item,
          status: 'failed',
          result: {
            tokensIn: 900_000,
            tokensCached: 300_000,
            tokensOut: 1_000,
            summary: 'Token limit',
          },
          agent: await agentState(AGENTS.a),
        }),
      ),
    );
    expect((await snap(A(AGENTS.a))).failStreak).toBe(1);
    const run = await snap(paths.run(W, 'r-limit'));
    expect(run).toMatchObject({ status: 'failed', tokensIn: 900_000, tokensCached: 300_000 });
    expect((await snap(I('i1'))).claim).toBeNull();
  });

  it('ATTACK: the agent cannot skip, fake or undo its streak', async () => {
    const { a, runId } = await claimed(AGENTS.a, 'r1');
    const plan = endRun(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      result: { status: 'failed' },
      agent: { failStreak: 1 }, // claims a higher streak than stored (0): +2
    });
    await denied(a.run(plan));
    // Lowering it without ending a run, or with a failed run.
    await put({ [A(AGENTS.a)]: agentA({ failStreak: 2 }) });
    await denied(updateDoc(doc(a.db, A(AGENTS.a)), { failStreak: 0 }));
    const reset = endRun(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      result: { status: 'failed' },
    });
    reset.ops.push({
      kind: 'update',
      path: A(AGENTS.a),
      data: { failStreak: 0, lastEventId: reset.eventId },
    });
    await denied(a.run(reset));
    // Reaching the limit without pausing is refused.
    const noPause = endRun(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      result: { status: 'failed' },
    });
    noPause.ops.push({
      kind: 'update',
      path: A(AGENTS.a),
      data: { failStreak: 3, lastEventId: noPause.eventId },
    });
    await denied(a.run(noPause));
    // Another agent's streak: never.
    const s = as(AGENTS.star);
    await denied(updateDoc(doc(s.db, A(AGENTS.a)), { failStreak: 0 }));
  });

  it('finishing a live run as a paused agent keeps the streak and the pause (card wvLiSoy8)', async () => {
    await requeue();
    const { a, item } = await claimed(AGENTS.a, 'r-live');
    // An admin-visible pause lands while the run is live.
    await put({
      [A(AGENTS.a)]: agentA({
        pausedAt: serverTimestamp(),
        pausedReason: '3 failed runs in a row',
        failStreak: 3,
      }),
    });
    const complete = (agent: Awaited<ReturnType<typeof agentState>>) =>
      completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item, agent });
    const plan = complete(await agentState(AGENTS.a));
    expect(plan.ops.some((o) => o.path === A(AGENTS.a))).toBe(false);
    await ok(a.run(plan));
    const d = await snap(A(AGENTS.a));
    expect(d.failStreak).toBe(3);
    expect(d.pausedAt).toBeTruthy();
  });

  it('ATTACK: a paused agent cannot reset its own streak by finishing a run', async () => {
    await requeue();
    const { a, item } = await claimed(AGENTS.a, 'r-forge');
    await put({
      [A(AGENTS.a)]: agentA({ pausedAt: serverTimestamp(), pausedReason: 'x', failStreak: 3 }),
    });
    // Forge the pre-change client: an agent state without the pause makes the plan reset the streak.
    const plan = completeStep(a.ctx, {
      project,
      projectId: 'p1',
      itemId: 'i1',
      item,
      agent: { failStreak: 3 },
    });
    await denied(a.run(plan));
  });

  it('ATTACK: an admin cannot pause an agent by hand (revoke is the stop switch)', async () => {
    const owner = as('owner');
    const p = resumeAgent(owner.ctx, { agentUid: AGENTS.a, name: 'Agent' });
    (p.ops[0]!.data as Record<string, unknown>).pausedAt = serverTimestamp();
    await denied(owner.run(p));
  });
});

describe('token usage', () => {
  it('a heartbeat may carry growing usage; cache reads are part of tokensIn', async () => {
    const { a, runId } = await claimed();
    const beat = (usage: {
      tokensIn: number;
      tokensOut: number;
      tokensCached?: number;
      model?: string;
    }) =>
      heartbeat(a.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        runId,
        lastHeartbeatEventAtMs: Date.now(),
        usage,
      });
    await ok(
      a.run(beat({ tokensIn: 1000, tokensOut: 100, tokensCached: 600, model: 'claude-opus-5-5' })),
    );
    expect(await snap(paths.run(W, runId))).toMatchObject({
      tokensIn: 1000,
      tokensOut: 100,
      tokensCached: 600,
      model: 'claude-opus-5-5',
    });
    await ok(a.run(beat({ tokensIn: 2000, tokensOut: 150, tokensCached: 900 })));
    // ATTACK: counters going down, or more cached than input.
    await denied(a.run(beat({ tokensIn: 1500, tokensOut: 150, tokensCached: 900 })));
    const raw = beat({ tokensIn: 2000, tokensOut: 150 });
    (raw.ops[0]!.data as Record<string, unknown>).tokensCached = 2500;
    await denied(a.run(raw));
  });
  it('a heartbeat may carry the cost so far, and it only grows', async () => {
    const { a, runId } = await claimed();
    const beat = (costEur: number) =>
      heartbeat(a.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        runId,
        lastHeartbeatEventAtMs: Date.now(),
        usage: { tokensIn: 10, tokensOut: 1, costEur },
      });
    await ok(a.run(beat(0.25)));
    expect(await snap(paths.run(W, runId))).toMatchObject({ costEur: 0.25 });
    await ok(a.run(beat(0.4)));
    // ATTACK: the cost going down, or not a number.
    await denied(a.run(beat(0.1)));
    const raw = beat(0.5);
    (raw.ops[0]!.data as Record<string, unknown>).costEur = 'free';
    await denied(a.run(raw));
  });
  it('ending a run records cached tokens, never more than the input', async () => {
    const { a, runId } = await claimed();
    const p = endRun(a.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      runId,
      result: { status: 'done', tokensIn: 100, tokensOut: 10, tokensCached: 40 },
    });
    (p.ops[0]!.data as Record<string, unknown>).tokensCached = 400;
    await denied(a.run(p));
    await ok(
      a.run(
        endRun(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          runId,
          result: { status: 'done', tokensIn: 100, tokensOut: 10, tokensCached: 40 },
        }),
      ),
    );
  });
});

describe('Remote Control link on a run (card OPpbi0MS)', () => {
  const url = 'https://claude.ai/code/session_0182WrAGXy2pVKtBowTsTfYe';
  const sessionId = '09817820-8d33-4efd-9b86-5272eb25da0d';

  it('the run’s agent sets it once, while the run is open', async () => {
    const { a, runId } = await claimed();
    const run = doc(a.db, paths.run(W, runId));
    await ok(updateDoc(run, { remote: { url, sessionId } }));
    expect(await snap(paths.run(W, runId))).toMatchObject({ remote: { url, sessionId } });
    // Once only: it cannot be swapped for another link later.
    await denied(
      updateDoc(run, {
        remote: { url: 'https://claude.ai/code/session_AAAAAAAAAAAA', sessionId },
      }),
    );
    // Ending the run keeps it.
    await ok(
      a.run(
        endRun(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          runId,
          result: { status: 'done', tokensIn: 1, tokensOut: 1 },
        }),
      ),
    );
    expect(await snap(paths.run(W, runId))).toMatchObject({ status: 'done', remote: { url } });
  });

  it('ATTACK: any other link, extra fields, other fields with it, another agent, an ended run', async () => {
    const { a, runId } = await claimed();
    const run = doc(a.db, paths.run(W, runId));
    for (const bad of [
      'https://evil.example/code/session_0182WrAGXy2pVKtBowTsTfYe',
      'https://claude.ai/code/session_0182WrAGXy2pVKtBowTsTfYe/../x',
      'https://claude.ai.evil.example/code/session_0182WrAGXy2pVKtBowTsTfYe',
      'javascript:alert(1)//https://claude.ai/code/session_0182WrAGXy2pVKtBowTsTfYe',
    ])
      await denied(updateDoc(run, { remote: { url: bad, sessionId } }));
    await denied(updateDoc(run, { remote: { url, sessionId, note: 'x' } }));
    await denied(updateDoc(run, { remote: { url, sessionId }, tokensIn: 5 }));
    await denied(
      updateDoc(doc(as(AGENTS.star).db, paths.run(W, runId)), { remote: { url, sessionId } }),
    );
    await ok(
      a.run(
        endRun(a.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          runId,
          result: { status: 'failed', tokensIn: 1, tokensOut: 1 },
        }),
      ),
    );
    await denied(updateDoc(run, { remote: { url, sessionId } }));
  });
});
