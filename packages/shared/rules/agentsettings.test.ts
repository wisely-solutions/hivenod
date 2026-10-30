/**
 * Card zSzW3LXy: agent settings and guardrails.
 * - settings (projects (legacy), guardrails, permissions, resume) are admin-only; agents cannot
 *   touch them. Per-step agents, run failure streaks and token usage went with Projects (OE8Fm
 *   slice 11).
 */
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { createAgent, resumeAgent, updateAgentSettings } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, now, ok, put, snap, useEmulator, W } from './harness';

useEmulator();

const A = (uid: string) => paths.agent(W, uid);

/** agentA's doc as seeded, plus overrides. */
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
  it('an admin resumes an agent that paused itself; ATTACK: an admin cannot pause one by hand, the agent cannot resume itself', async () => {
    await put({
      [A(AGENTS.a)]: agentA({
        failStreak: 3,
        pausedAt: now(),
        pausedReason: 'Paused after 3 failed runs',
      }),
    });
    const a = as(AGENTS.a);
    await denied(
      updateDoc(doc(a.db, A(AGENTS.a)), { pausedAt: null, pausedReason: null, failStreak: 0 }),
    );
    const owner = as('owner');
    await ok(owner.run(resumeAgent(owner.ctx, { agentUid: AGENTS.a, name: 'Agent' })));
    const d = await snap(A(AGENTS.a));
    expect(d.pausedAt).toBeNull();
    expect(d.failStreak).toBe(0);
    const p = resumeAgent(owner.ctx, { agentUid: AGENTS.a, name: 'Agent' });
    (p.ops[0]!.data as Record<string, unknown>).pausedAt = serverTimestamp();
    await denied(owner.run(p));
  });
  it('ATTACK: the agent cannot change its own failure streak or pause (runs went with Projects)', async () => {
    const a = as(AGENTS.a);
    await denied(updateDoc(doc(a.db, A(AGENTS.a)), { failStreak: 0 }));
    await denied(
      updateDoc(doc(a.db, A(AGENTS.a)), { pausedAt: serverTimestamp(), pausedReason: 'x' }),
    );
  });
});
