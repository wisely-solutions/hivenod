/**
 * `hivenod run claude` acceptance (card MkUwvyWs) against the real Auth and Firestore emulators and
 * the real rules, with a fake Claude that talks to the real one-item MCP server (`hivenod mcp --run`
 * from the built dist/cli.js): pair -> claim -> work -> tokens/model on the run -> complete ->
 * next item after a person approves; a question releases and holds the item; 3 failures pause the
 * agent; a big run is never stopped; revoke stops it; a step limited to another agent is not taken.
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import {
  answer,
  approve,
  REVOKED_RUN_SUMMARY,
  revokeAgent,
  resumeWork,
  stopWork,
  pairingPath,
  pairingCompletion,
  paths,
  sealToken,
  type ItemState,
  type ProjectState,
} from '@hive/shared';
import { toFirestoreValue } from '@hive/shared/firestore';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doc, getDoc, Timestamp, updateDoc, type Firestore } from 'firebase/firestore';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  getEnv,
  I,
  itemDoc,
  minutesAgo,
  now,
  P,
  projectDoc,
  put,
  useEmulator,
  W,
} from '../../shared/rules/harness';
import { HiveClient } from '../src/client';
import { pairTerminal } from '../src/pair';
import { EXIT, Runner } from '../src/runner';
import { ADAPTERS } from '../src/clis';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };
const PKG = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PKG, 'dist/cli.js');
const FAKE = join(PKG, 'test/fixtures/fake-claude.mjs');

beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: PKG, stdio: 'ignore' });
  process.env.HIVENOD_PROJECT_ID = 'hive-rules-test';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= AUTH_HOST;
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
  process.env.HIVENOD_HOME = mkdtempSync(join(tmpdir(), 'hive-home-'));
  process.env.FAKE_MCP = '1';
  delete process.env.HIVENOD_TOKEN;
}, 60_000);

const clients: HiveClient[] = [];
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_MCP = '1';
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function newAgent(extra: Record<string, unknown> = {}) {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Writer',
      color: '#2F5FD0',
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: 'a7f3',
      previousAgentUid: null,
      lastEventId: 'seed',
      ...extra,
    },
  });
  return { uid, token };
}

async function connect(token: string) {
  const c = await HiveClient.connect({
    token,
    projectId: 'hive-rules-test',
    authEmulator: AUTH_HOST,
  });
  clients.push(c);
  return c;
}

function runner(c: HiveClient, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const r = new Runner({
    client: c,
    hiveCommand: [process.execPath, DIST],
    cliCommand: FAKE,
    once: true,
    waitSliceMs: 3000,
    terminal: { line: (s) => lines.push(s) },
    ...extra,
  });
  return { r, lines };
}

async function read(path: string) {
  let out: Record<string, unknown> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    out = (await c.firestore().doc(path).get()).data() ?? {};
  });
  return out;
}
async function list(path: string) {
  const out: Record<string, Record<string, unknown>> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    (await c.firestore().collection(path).get()).forEach((d) => (out[d.id] = d.data()));
  });
  return out;
}
const runs = async () => Object.values(await list(`workspaces/${W}/runs`));

describe('hivenod run claude (emulators, fake Claude over the real MCP server)', () => {
  it('pairs: the code shown in the terminal, confirmed by an admin, gives it a working token', async () => {
    const said: string[] = [];
    const { uid, token } = await createAgentIdentity(options, W, {
      authEmulatorUrl: `http://${AUTH_HOST}`,
    });
    const pairing = pairTerminal({ cli: 'claude', say: (l) => said.push(l), timeoutMs: 20_000 });
    // The admin's browser: read the request by the code, create the agent, seal, complete.
    await expect.poll(() => said.join('\n'), { timeout: 10_000 }).toMatch(/confirm the code/);
    const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said.join('\n'))!.slice(1).join('');
    expect(said.join('\n')).toContain(`/agents/connect?code=${code.slice(0, 4)}-${code.slice(4)}`);
    const owner = as('owner');
    const req = await getDoc(doc(owner.db, pairingPath(code)));
    expect(req.data()).toMatchObject({ status: 'pending', cli: 'claude' });
    await put({
      [paths.agent(W, uid)]: {
        name: 'Writer (laptop)',
        color: '#2F5FD0',
        projectIds: ['p1'],
        createdBy: 'owner',
        createdAt: now(),
        revokedAt: null,
        lastSeenAt: null,
        tokenHint: 'a7f3',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    });
    const sealed = await sealToken(token, req.data()!.publicKey as string, code);
    await updateDoc(
      doc(owner.db as Firestore, pairingPath(code)),
      toFirestoreValue(
        pairingCompletion({
          workspaceId: W,
          agentUid: uid,
          agentName: 'Writer (laptop)',
          pairedBy: 'owner',
          sealed,
        }),
      ) as Record<string, unknown>,
    );
    const paired = await pairing;
    expect(paired).toMatchObject({
      code,
      workspaceId: W,
      agentUid: uid,
      agentName: 'Writer (laptop)',
    });
    expect(paired.token).toBe(token);
    const c = await connect(paired.token);
    expect(c.whoami().name).toBe('Writer (laptop)');
    await c.deletePairing(code);
    expect(await read(pairingPath(code))).toEqual({});
  });

  it('cancelling a pairing (Ctrl+C) deletes its pending doc (card PXOzcYeG)', async () => {
    const said: string[] = [];
    const ac = new AbortController();
    const pairing = pairTerminal({
      cli: 'claude',
      say: (l) => said.push(l),
      timeoutMs: 20_000,
      signal: ac.signal,
    });
    const settled = expect(pairing).rejects.toThrow(/cancelled/);
    await expect.poll(() => said.join('\n'), { timeout: 10_000 }).toMatch(/confirm the code/);
    const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said.join('\n'))!.slice(1).join('');
    expect(Object.keys(await read(pairingPath(code))).length).toBeGreaterThan(0);
    ac.abort();
    await settled;
    expect(await read(pairingPath(code))).toEqual({});
  });

  it('a pairing that expires deletes its pending doc (card PXOzcYeG)', async () => {
    const said: string[] = [];
    await expect(
      pairTerminal({ cli: 'claude', say: (l) => said.push(l), timeoutMs: 1500 }),
    ).rejects.toThrow(/expired/);
    const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said.join('\n'))!.slice(1).join('');
    expect(await read(pairingPath(code))).toEqual({});
  });

  it('claims, works through the MCP server, reports tokens + model, completes; next item after approval', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'done';
    const first = runner(c);
    expect(await first.r.run()).toBe(EXIT.ok);
    const item = await read(I('i1'));
    expect(item).toMatchObject({ stepId: 'review', status: 'waiting', claim: null });
    const [run] = await runs();
    expect(run).toMatchObject({
      agentUid: uid,
      itemId: 'i1',
      status: 'done',
      tokensIn: 13200,
      tokensCached: 11000,
      tokensOut: 400,
      model: 'claude-test-1',
      summary: 'Drafted the post.',
    });
    // The run's cost comes from Claude's result (total_cost_usd 0.05), in EUR; the item adds it.
    expect(run!.costEur).toBeGreaterThan(0.03);
    expect(item.costEur).toBe(run!.costEur);
    const runId = Object.keys(await list(`workspaces/${W}/runs`))[0]!;
    const log = Object.values(await list(`workspaces/${W}/runs/${runId}/log`));
    expect(log.map((l) => l.text)).toContain('fake read Post about bees');
    expect(first.lines.join('\n')).toMatch(
      /✓ Finished step Draft .* moved to Review \(waiting for people\)/,
    );

    // A person approves the gate: the item reaches the next agent step and is picked up.
    const alice = as('alice');
    const project = (await read(P('p1'))) as unknown as ProjectState;
    await alice.run(
      approve(alice.ctx, {
        project,
        projectId: 'p1',
        itemId: 'i1',
        item: item as unknown as ItemState,
        rationale: 'Good',
      }),
    );
    const second = runner(c);
    expect(await second.r.run()).toBe(EXIT.ok);
    expect(second.lines.join('\n')).toContain('step Publish');
    expect(await read(I('i1'))).toMatchObject({ status: 'done' });
  });

  it('a question releases the item at once and holds it until people answer', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'ask';
    const r = runner(c);
    expect(await r.r.run()).toBe(EXIT.ok);
    const item = await read(I('i1'));
    expect(item).toMatchObject({ status: 'queued', claim: null, stepId: 'draft' });
    const hold = item.awaitingAnswer as { questionId: string; reason?: string };
    expect(hold.questionId).toBeTruthy();
    expect(hold.reason).toBeUndefined();
    const q = (await list(`workspaces/${W}/projects/p1/items/i1/messages`))[hold.questionId];
    expect(q).toMatchObject({
      kind: 'question',
      text: 'Annual or monthly first?',
      answered: false,
    });
    expect((await runs())[0]).toMatchObject({ status: 'released' });
    expect(r.lines.join('\n')).toContain('? Question sent to Hivenod: “Annual or monthly first?”');
    expect((await c.listWork()).map((w) => w.itemId)).not.toContain('i1');

    const alice = as('alice');
    await alice.run(
      answer(alice.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        item: item as unknown as ItemState,
        questionId: hold.questionId,
        text: 'Annual first',
      }),
    );
    process.env.FAKE_CLAUDE_MODE = 'done';
    const again = runner(c);
    expect(await again.r.run()).toBe(EXIT.ok);
    expect(await read(I('i1'))).toMatchObject({ stepId: 'review' });
  });

  it('three failed runs in a row pause the agent and stop the session', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'fail';
    const r = runner(c, { once: false });
    expect(await r.r.run()).toBe(EXIT.paused);
    const all = await runs();
    expect(all).toHaveLength(3);
    expect(all.every((x) => x.status === 'failed')).toBe(true);
    expect(await read(paths.agent(W, uid))).toMatchObject({ failStreak: 3 });
    expect((await read(paths.agent(W, uid))).pausedAt).toBeTruthy();
    expect(await read(I('i1'))).toMatchObject({ status: 'queued', claim: null });
  }, 60_000);

  it('revoking the agent stops the CLI within a heartbeat and ends the session', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const r = runner(c, { heartbeatMs: 500, usageCheckMs: 200, killGraceMs: 500 });
    const done = r.r.run();
    await expect.poll(async () => (await read(I('i1'))).claim, { timeout: 15_000 }).toBeTruthy();
    // The admin revokes in Hivenod: the same batch ends the open run and gives the item back
    // (tester finding 1: the run used to stay "running" forever).
    const runId = (await read(I('i1'))).claim as { runId: string };
    const owner = as('owner');
    await owner.run(
      revokeAgent(owner.ctx, {
        agentUid: uid,
        openRuns: [{ runId: runId.runId, projectId: 'p1', itemId: 'i1', holdsItem: true }],
      }),
    );
    expect(await done).toBe(EXIT.revoked);
    expect(r.lines.join('\n')).toContain('revoked');
    expect(await read(paths.run(W, runId.runId))).toMatchObject({
      status: 'failed',
      summary: REVOKED_RUN_SUMMARY,
    });
    expect(await read(I('i1'))).toMatchObject({ claim: null, status: 'queued' });
  }, 30_000);

  it('Stop work, Go back: the CLI stops within seconds, the run is stopped (no failure), the item is held until Resume (BrK0r2FE)', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'hang';
    // Heartbeats are slow on purpose: the live watch of the run must be what stops it.
    const r = runner(c, { heartbeatMs: 60_000, usageCheckMs: 60_000, killGraceMs: 500 });
    const done = r.r.run();
    await expect.poll(async () => (await read(I('i1'))).claim, { timeout: 15_000 }).toBeTruthy();
    const item = (await read(I('i1'))) as unknown as ItemState;
    const runId = (item.claim as { runId: string }).runId;
    const alice = as('alice');
    const stoppedAt = Date.now();
    await alice.run(
      stopWork(alice.ctx, {
        project: { steps: (await read(P('p1'))).steps } as ProjectState,
        projectId: 'p1',
        itemId: 'i1',
        item,
        mode: 'back',
        reason: 'Wrong brief',
        gateStepId: 'review',
        run: { costEur: 0, endedAt: null },
      }),
    );
    expect(await done).toBe(EXIT.ok);
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect(r.lines.join('\n')).toContain('Stopped by Alice');
    expect(await read(paths.run(W, runId))).toMatchObject({
      status: 'stopped',
      stoppedBy: { uid: 'alice' },
    });
    expect((await read(paths.agent(W, uid))).failStreak ?? 0).toBe(0);
    const held = await read(I('i1'));
    expect(held).toMatchObject({ status: 'queued', claim: null, workStopped: { mode: 'back' } });
    // No agent takes it: not listed, and claim by id is refused with a clear message.
    expect(await c.listWork({ projectId: 'p1' })).toEqual([]);
    await expect(c.claim('i1', 'p1')).rejects.toThrow(/on hold/);
    // Resume releases it.
    await alice.run(
      resumeWork(alice.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        item: held as unknown as ItemState,
        gateStepId: 'review',
      }),
    );
    expect((await c.listWork({ projectId: 'p1' })).map((w) => w.itemId)).toEqual(['i1']);
  }, 30_000);

  it('Stop work while the CLI is offline ends the claim on the server; a later heartbeat says so (BrK0r2FE)', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const { runId } = await c.claim('i1', 'p1');
    c.untrackRun(runId);
    const item = (await read(I('i1'))) as unknown as ItemState;
    const owner = as('owner');
    await owner.run(
      stopWork(owner.ctx, {
        project: { steps: (await read(P('p1'))).steps } as ProjectState,
        projectId: 'p1',
        itemId: 'i1',
        item,
        mode: 'cancel',
        run: { costEur: 0, endedAt: null },
      }),
    );
    expect(await read(I('i1'))).toMatchObject({ status: 'stopped', claim: null });
    await expect(c.heartbeat(runId)).rejects.toThrow(/People stopped this work/);
    await expect(c.complete('i1', runId, {}, 'p1')).rejects.toThrow(/People stopped this work/);
  }, 30_000);

  it('taking over a stale claim ends the old agent run (it does not stay running)', async () => {
    const a = await newAgent();
    const b = await newAgent();
    const ca = await connect(a.token);
    const { runId: oldRun } = await ca.claim('i1', 'p1');
    ca.untrackRun(oldRun);
    // A's terminal died: no heartbeat for 11 minutes.
    const stale = Timestamp.fromMillis(Date.now() - 11 * 60_000);
    await put({
      [I('i1')]: {
        ...(await read(I('i1'))),
        claim: { runId: oldRun, agentUid: a.uid, heartbeatAt: stale },
      },
      [paths.run(W, oldRun)]: {
        ...(await read(paths.run(W, oldRun))),
        heartbeatAt: stale,
        heartbeatEventAt: stale,
      },
    });
    const cb = await connect(b.token);
    process.env.FAKE_CLAUDE_MODE = 'done';
    expect(await runner(cb).r.run()).toBe(EXIT.ok);
    expect(await read(paths.run(W, oldRun))).toMatchObject({ status: 'released' });
    expect(await read(I('i1'))).toMatchObject({ stepId: 'review' });
  }, 30_000);

  it('shows online while it waits and offline once it stops', async () => {
    const { uid, token } = await newAgent();
    await put({ [I('i1')]: itemDoc({ stepId: 'review', status: 'waiting' }) });
    const c = await connect(token);
    const r = runner(c, { waitSliceMs: 500, signal: AbortSignal.timeout(2500) });
    const done = r.r.run();
    await expect
      .poll(async () => (await read(paths.agent(W, uid))).lastSeenAt, { timeout: 10_000 })
      .toBeTruthy();
    expect(await done).toBe(EXIT.interrupted);
    const agent = await read(paths.agent(W, uid));
    expect(agent.signedOutAt).toBeTruthy();
    expect((agent.signedOutAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(
      (agent.lastSeenAt as Timestamp).toMillis(),
    );
  }, 30_000);

  it('one terminal per agent: a second terminal is refused while the first is alive (card wvLiSoy8)', async () => {
    const { token, uid } = await newAgent();
    const first = await connect(token);
    await first.markSeen();
    const second = await connect(token);
    await second.refreshAgent();
    expect(() => second.checkNoOtherTerminal()).toThrow(
      /already running in another terminal \(.+, last seen .+\)\. Stop it first, or create another agent/,
    );
    // The first terminal stopped (signed out): the second may start.
    await first.markOffline();
    await second.refreshAgent();
    expect(() => second.checkNoOtherTerminal()).not.toThrow();
    // Nothing was claimed or written by the refusal.
    expect((await read(paths.agent(W, uid))).failStreak ?? 0).toBe(0);
  }, 30_000);

  it('one terminal per agent: a crashed first terminal (stale presence) does not block', async () => {
    const { token } = await newAgent({ lastSeenAt: minutesAgo(5), seenHost: 'old-laptop' });
    const c = await connect(token);
    await c.refreshAgent();
    expect(() => c.checkNoOtherTerminal()).not.toThrow();
    const { token: t2 } = await newAgent({ lastSeenAt: minutesAgo(1), seenHost: 'old-laptop' });
    const c2 = await connect(t2);
    await c2.refreshAgent();
    expect(() => c2.checkNoOtherTerminal()).toThrow(/old-laptop/);
  }, 30_000);

  it('--project: a project the agent cannot use is a clear error at once', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    await expect(c.checkProject('p2')).rejects.toThrow(/cannot use the project "p2".*Blog/);
    expect(await c.checkProject('Blog')).toBe('p1');
    const r = runner(c, { projectId: 'p2', once: false });
    expect(await r.r.run()).toBe(EXIT.error);
    expect(r.lines.join('\n')).toMatch(/✗ This agent cannot use the project "p2"/);
  }, 30_000);

  it('does not take a step limited to another agent', async () => {
    const { token } = await newAgent();
    await put({ [P('p1')]: projectDoc({}, { stepAgents: { draft: ['someoneElse'] } }) });
    await put({ [I('i1')]: itemDoc() });
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'done';
    const r = runner(c, { waitSliceMs: 1000, signal: AbortSignal.timeout(4000) });
    expect(await r.r.run()).toBe(EXIT.interrupted);
    expect(await runs()).toHaveLength(0);
    expect(await read(I('i1'))).toMatchObject({ claim: null, stepId: 'draft' });
  }, 30_000);
  // A run far over any token limit completes normally; its usage is shown (card rifzGl8M).
  it('a run over 500k new tokens completes normally and its usage is recorded', async () => {
    // An old agent doc with a small stored limit: ignored.
    const { token } = await newAgent({ guardrails: { maxFailedRuns: 3, maxTokensPerItem: 5000 } });
    const c = await connect(token);
    process.env.FAKE_CLAUDE_MODE = 'done';
    process.env.FAKE_BIG = '1';
    try {
      const r = runner(c, { usageCheckMs: 200 });
      expect(await r.r.run()).toBe(EXIT.ok);
      const [run] = await runs();
      expect(run).toMatchObject({ status: 'done' });
      expect((run!.tokensIn as number) - ((run!.tokensCached as number) ?? 0)).toBeGreaterThan(
        500_000,
      );
      expect(await read(I('i1'))).toMatchObject({ claim: null });
      expect(r.lines.join('\n')).not.toMatch(/limit/i);
    } finally {
      delete process.env.FAKE_BIG;
    }
  }, 30_000);
});

describe('hivenod run codex / copilot (EXPERIMENTAL; emulators, fake CLIs over the real MCP server)', () => {
  for (const cli of ['codex', 'copilot'] as const) {
    it(`${cli}: claims, works through the MCP server, reports tokens + model, completes`, async () => {
      const { uid, token } = await newAgent();
      const c = await connect(token);
      process.env.FAKE_CLI_MODE = 'done';
      process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-home-'));
      try {
        const { r, lines } = runner(c, {
          adapter: ADAPTERS[cli],
          cliCommand: join(PKG, `test/fixtures/fake-${cli}.mjs`),
        });
        expect(await r.run()).toBe(EXIT.ok);
        expect(lines.join('\n')).toMatch(/✓ Finished step Draft .* moved to Review/);
      } finally {
        delete process.env.FAKE_CLI_MODE;
        delete process.env.CODEX_HOME;
      }
      expect(await read(I('i1'))).toMatchObject({
        stepId: 'review',
        status: 'waiting',
        claim: null,
      });
      const [run] = await runs();
      expect(run).toMatchObject({
        agentUid: uid,
        status: 'done',
        tokensIn: 5000,
        tokensCached: 3000,
        tokensOut: 250,
        model: `gpt-test-${cli}`,
        summary: 'Drafted the post.',
      });
      const runId = Object.keys(await list(`workspaces/${W}/runs`))[0]!;
      const log = Object.values(await list(`workspaces/${W}/runs/${runId}/log`));
      expect(log.map((l) => l.text)).toContain('fake read Post about bees');
    });
  }
});
