/**
 * Card KLCTVnX8, through the Go CLI (`hivenod mcp`), against the emulators and the real rules: an agent sends an item back to an
 * earlier agent step with send_back (the reason reaches the next agent in read_item), is refused
 * across a people step, and after 3 rounds holds the item for people instead; a person's answer
 * resets the rounds. add_note leaves a note on the item it holds.
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { answer, buildStepIndex, paths, type ItemState, type Step } from '@hive/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  gate,
  getEnv,
  I,
  itemDoc,
  now,
  P,
  projectDoc,
  put,
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

/** build → test → review (people) → ship */
const LIB: Step[] = [
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'test', name: 'Test', kind: 'agent', description: '' },
  { id: 'review', name: 'Review', kind: 'human', description: '', gate: gate() },
  { id: 'ship', name: 'Ship', kind: 'agent', description: '' },
];

async function agent() {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Tester',
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
    [P('p1')]: projectDoc({}, { steps: LIB, stepIndex: buildStepIndex(LIB) }),
  });
  const c = await GoAgent.start(uid, token);
  clients.push(c);
  return c;
}

async function item(path: string) {
  let d: Record<string, unknown> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    d = (await c.firestore().doc(path).get()).data() ?? {};
  });
  return d;
}

d('send_back and add_note', () => {
  it('sends back with a reason the next agent reads; refuses across people', async () => {
    const c = await agent();
    await put({ [I('i1')]: itemDoc({ stepId: 'test' }) });
    const { runId } = await c.claim('i1');
    await expect(c.sendBack('i1', runId, 'review', 'nope nope')).rejects.toThrow(/earlier step/);
    expect(await c.addNote('i1', 'Started testing')).toMatchObject({
      messageId: expect.any(String),
    });
    const r = await c.sendBack('i1', runId, 'build', 'The login test fails', { costEur: 0.1 });
    expect(r).toMatchObject({
      sentBack: true,
      movedTo: { stepId: 'build' },
      round: 1,
      roundsLeft: 2,
    });
    expect(await item(I('i1'))).toMatchObject({
      stepId: 'build',
      status: 'queued',
      claim: null,
      agentSendBacks: 1,
    });
    const read = await c.readItem('i1');
    expect(read.agentSendBacks).toMatchObject({
      rounds: 1,
      history: [{ fromStepId: 'test', toStepId: 'build', reason: 'The login test fails' }],
    });
    expect(read.messages.map((m) => m.text)).toEqual(
      expect.arrayContaining(['Started testing', 'The login test fails']),
    );
    // Across the people step: from ship back to test.
    await put({ [I('i2')]: itemDoc({ stepId: 'ship' }) });
    const r2 = await c.claim('i2');
    await expect(c.sendBack('i2', r2.runId, 'test', 'redo it')).rejects.toThrow(/across people/);
  });

  it('the 4th round holds the item for people; their answer resets it', async () => {
    const c = await agent();
    await put({ [I('i1')]: itemDoc({ stepId: 'test', agentSendBacks: 3 }) });
    const { runId } = await c.claim('i1');
    const r = await c.sendBack('i1', runId, 'build', 'Still failing');
    expect(r).toMatchObject({ sentBack: false, heldForPeople: true });
    const held = await item(I('i1'));
    expect(held).toMatchObject({
      stepId: 'test',
      claim: null,
      awaitingAnswer: { agentUid: c.uid },
    });
    const qid = (held.awaitingAnswer as { questionId: string }).questionId;
    const q = await item(paths.message(W, 'p1', 'i1', qid));
    expect(q).toMatchObject({ kind: 'question' });
    expect(String(q.text)).toMatch(/^Agents sent this back 3 times/);
    expect(String(q.text)).toContain('This time: Still failing');
    expect(await c.listWork()).toEqual([]);
    const alice = as('alice');
    await alice.run(
      answer(alice.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        item: held as unknown as ItemState,
        questionId: qid,
        text: 'Skip the flaky test',
      }),
    );
    expect(await item(I('i1'))).toMatchObject({ awaitingAnswer: null, agentSendBacks: 0 });
    expect((await c.listWork()).map((w) => w.itemId)).toEqual(['i1']);
  });
});
