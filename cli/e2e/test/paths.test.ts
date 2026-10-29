/**
 * Card st5INNZj, through the Go CLI (`hivenod mcp`), against the emulators and the real rules: an unshaped item is shaping work for
 * any agent on the project; the agent shapes it (agent steps skipped, a people step asked of its
 * deciders), then works it along its path, skipping an agent step ahead and proposing a step.
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { paths } from '@hive/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  I,
  itemDoc,
  now,
  P,
  projectDoc,
  put,
  snap,
  useEmulator,
  W,
} from '../../../packages/shared/rules/harness';
import { GoAgent } from './agentcli';
import { GO, goBinary } from './gobin';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };

const d = GO ? describe : describe.skip;
beforeAll(() => {
  if (GO) goBinary();
}, 300_000);
const clients: GoAgent[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function agent() {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Scout',
      color: '#2F5FD0',
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: token.slice(-4),
      previousAgentUid: null,
      lastEventId: 'seed',
    },
  });
  const c = await GoAgent.start(uid, token);
  clients.push(c);
  return { uid, c };
}

d('per-item paths: shaping and paths from the agent client', () => {
  it('lists an unshaped item as shaping work, even at a step limited to other agents', async () => {
    await put({
      [P('p1')]: projectDoc({}, { stepAgents: { intake: ['someoneElse'] } }),
      [I('u1')]: itemDoc({ stepId: 'intake', status: 'queued', shape: null, title: 'Fix typo' }),
    });
    const { c } = await agent();
    const rows = await c.listWork();
    const row = rows.find((r) => r.itemId === 'u1');
    expect(row).toMatchObject({ job: 'shape', step: 'Shaping' });
    const claimed = await c.claim('u1');
    expect(claimed.job).toBe('shape');
    expect((await snap(paths.run(W, claimed.runId))).job).toBe('shape');
  });

  it('shapes, then works the item along its path', async () => {
    await put({
      [I('u1')]: itemDoc({ stepId: 'intake', status: 'queued', shape: null, title: 'Fix typo' }),
    });
    const { c } = await agent();
    const { runId } = await c.claim('u1');
    const brief = await c.readItem('u1');
    expect(brief.job).toBe('shape');
    expect(brief.path.map((p) => p.id)).toEqual(['intake', 'draft', 'review', 'publish']);
    await expect(c.shape('u1', runId, { skips: { nope: 'x' }, note: 'tiny' })).rejects.toThrow(
      /Unknown step/,
    );
    const shaped = await c.shape('u1', runId, {
      skips: { draft: 'Nothing to write', review: 'A one-word copy fix' },
      note: 'copy fix',
    });
    expect(shaped).toMatchObject({ skipped: ['Draft'], askedToSkip: ['Review'] });
    const item = await snap(I('u1'));
    expect(item.pathSkips).toEqual({ draft: 'Nothing to write' });
    expect(item.pathRequests).toMatchObject({ review: { op: 'drop' } });
    expect(item.shape).toMatchObject({ note: 'copy fix' });
    expect((await snap(paths.run(W, runId))).status).toBe('done');

    // Now it is ordinary work at intake; the path skips Draft.
    const row = (await c.listWork()).find((r) => r.itemId === 'u1');
    expect(row).toMatchObject({ job: null, step: 'Intake' });
    const second = await c.claim('u1');
    await c.skipStep('u1', 'publish', true, 'Nothing to publish');
    await expect(c.skipStep('u1', 'review', true)).rejects.toThrow(/people step/);
    await expect(c.askPathChange('u1', 'publish', 'Not a people step')).rejects.toThrow(
      /agent step/,
    );
    const proposal = await c.proposeStep('u1', {
      name: 'Legal review',
      kind: 'human',
      description: 'Check the terms',
      afterStepId: 'review',
      reason: 'The copy touches the terms of service',
    });
    expect((await snap(paths.stepProposal(W, 'p1', proposal.proposalId))).status).toBe('open');
    const done = await c.complete('u1', second.runId);
    // Draft is skipped: the item lands at the Review gate (its skip is still pending).
    expect(done).toMatchObject({ movedTo: { stepId: 'review' }, waitingForPeople: true });
    expect((await snap(I('u1'))).stepId).toBe('review');
  });
});
