/**
 * Contract harness for the Go CLI (item zLwtX2WEEg3mER4CR74g): every scenario runs twice against
 * the real Auth and Firestore emulators and the real rules, once through the TypeScript
 * `hivenod mcp` (in memory) and once through the Go binary (`hivenod mcp` over stdio), from the
 * same fresh world. The tool results and the resulting Firestore documents must be identical once
 * random ids, timestamps and clock values are masked. Needs Go (HIVENOD_GO or `go` on PATH); without
 * it the suite is skipped with a warning.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import {
  createAgent,
  pairingCompletion,
  pairingPath,
  paths,
  sealToken,
  sendBack,
  answerQuestion,
  approveOutcome,
  inboxPaths,
  type OutcomeStateOf,
  type ThreadStateOf,
  type ItemState,
} from '@hive/shared';
import { toFirestoreValue } from '@hive/shared/firestore';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { readCredentials } from '../src/credentials';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  getEnv,
  I,
  itemDoc,
  now,
  P,
  projectDoc,
  put,
  reset,
  snap,
  useEmulator,
  W,
} from '../../shared/rules/harness';
import { HiveClient } from '../src/client';
import { createMcpServer } from '../src/mcp';
import { GO, goBinary } from './gobin';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJECT = 'hive-rules-test';
const options = { apiKey: 'fake-api-key', projectId: PROJECT };

let BIN = '';
beforeAll(() => {
  if (GO) BIN = goBinary();
}, 300_000);

// ---------- the two implementations behind one interface ----------

type Call = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; out: unknown }>;
interface Impl {
  call: Call;
  close: () => Promise<void>;
}

function decode(r: { isError?: boolean; content?: unknown }) {
  const text = (r.content as { type: string; text: string }[] | undefined)?.[0]?.text ?? '';
  let out: unknown = text;
  try {
    out = JSON.parse(text);
  } catch {
    /* an error message */
  }
  return { ok: !r.isError, out };
}

async function viaClient(
  transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport,
) {
  const client = new Client({ name: 'contract', version: '0' });
  await client.connect(transport);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      decode((await client.callTool({ name, arguments: args })) as never),
    close: () => client.close(),
  };
}

async function tsImpl(token: string): Promise<Impl> {
  const { server, close } = createMcpServer(() =>
    HiveClient.connect({ token, projectId: PROJECT, authEmulator: AUTH_HOST }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = await viaClient(b);
  return {
    call: c.call,
    close: async () => {
      await c.close();
      await close();
    },
  };
}

async function goImpl(token: string): Promise<Impl> {
  const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
  const transport = new StdioClientTransport({
    command: BIN,
    args: ['mcp'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      HIVENOD_HOME: home,
      HIVENOD_TOKEN: token,
      HIVENOD_PROJECT_ID: PROJECT,
      HIVENOD_FIREBASE_API_KEY: 'fake-api-key',
      FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
      FIRESTORE_EMULATOR_HOST: FS_HOST,
    },
    stderr: 'inherit',
  });
  const c = await viaClient(transport);
  return {
    call: c.call,
    close: async () => {
      const pid = transport.pid;
      await c.close();
      // Wait for the process to end, so its listeners are gone before the next reset.
      for (const t0 = Date.now(); pid && Date.now() - t0 < 8000;) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

// ---------- the world and its snapshot ----------

async function newAgent(extra: Record<string, unknown> = {}) {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Research agent',
      color: '#2F5FD0',
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: token.slice(-4),
      previousAgentUid: null,
      lastEventId: 'seed',
      ...extra,
    },
  });
  return { uid, token };
}

/** Every document the agent can touch, by collection (rules disabled). */
async function snapshot(uid: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const read = async (path: string) => {
      const snap = await db.collection(path).get();
      const key = mask(path, uid) as string;
      for (const d of snap.docs) (out[key] ??= []).push(mask(d.data(), uid));
      return snap.docs.map((d) => d.id);
    };
    await read(`workspaces/${W}/agents`);
    await read(`workspaces/${W}/events`);
    for (const c of [
      'inboxSubjects',
      'inboxThreads',
      'inboxMessages',
      'inboxOutcomes',
      'inboxEvents',
    ])
      await read(`workspaces/${W}/${c}`);
    await read(`workspaces/${W}/calendar`);
    await read('users/alice/busy');
    await read('agentHomes');
    for (const r of await read(`workspaces/${W}/runs`)) await read(`workspaces/${W}/runs/${r}/log`);
    for (const p of await read(`workspaces/${W}/projects`)) {
      await read(`workspaces/${W}/projects/${p}/decisions`);
      await read(`workspaces/${W}/projects/${p}/stepProposals`);
      for (const i of await read(`workspaces/${W}/projects/${p}/items`)) {
        await read(`workspaces/${W}/projects/${p}/items/${i}/attachments`);
        await read(`workspaces/${W}/projects/${p}/items/${i}/messages`);
      }
    }
  });
  for (const k of Object.keys(out))
    out[k] = out[k]!.map((d) => JSON.stringify(d))
      .sort()
      .map((x) => JSON.parse(x));
  return out;
}

const ID = /\b[A-Za-z0-9]{20}\b/g;
/** Masks what differs between two equal runs: random ids, the agent uid, timestamps, clocks. */
function mask(v: unknown, uid: string): unknown {
  if (typeof v === 'string')
    return v
      .split(uid)
      .join('<agent>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<iso>')
      .replace(ID, '<id>');
  if (typeof v === 'number') return v > 1e12 ? '<ms>' : v;
  if (Array.isArray(v)) return v.map((x) => mask(x, uid));
  if (v && typeof v === 'object') {
    if (typeof (v as { toMillis?: unknown }).toMillis === 'function') return '<ts>';
    return Object.fromEntries(
      Object.entries(v)
        .map(([k, x]) => [mask(k, uid) as string, mask(x, uid)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return v;
}

interface Result {
  calls: unknown[];
  docs: Record<string, unknown[]>;
}

/**
 * Runs a scenario on a fresh world with each implementation and returns both results. `steps`
 * gets a `call` that records each result (masked) and returns it unmasked for the next calls.
 */
async function both(
  scenario: (call: Call, uid: string) => Promise<void>,
  agentExtra: Record<string, unknown> = {},
): Promise<{ ts: Result; go: Result }> {
  const run = async (make: (t: string) => Promise<Impl>): Promise<Result> => {
    await reset();
    const { uid, token } = await newAgent(agentExtra);
    const impl = await make(token);
    const calls: unknown[] = [];
    try {
      await scenario(async (name, args) => {
        const r = await impl.call(name, args);
        calls.push({ tool: name, ...(mask(r, uid) as object) });
        return r;
      }, uid);
    } finally {
      await impl.close();
    }
    return { calls, docs: await snapshot(uid) };
  };
  const ts = await run(tsImpl);
  const go = await run(goImpl);
  return { ts, go };
}

const out = (r: { out: unknown }) => r.out as Record<string, unknown>;

// ---------- scenarios ----------

const d = GO ? describe : describe.skip;

d('Go CLI = TypeScript CLI (MCP tools, emulators, rules)', () => {
  it('claim, log, attach, ask, progress, finding, end run, complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-att-'));
    const html = join(dir, 'report.html');
    writeFileSync(html, '<h1>Bees</h1>');
    const r = await both(async (call) => {
      await call('list_work', {});
      const { runId } = out(await call('claim', { itemId: 'i1' })) as { runId: string };
      await call('read_item', { itemId: 'i1' });
      await call('log', { runId, text: 'Reading the brief' });
      await call('log', { runId, text: 'Drafting', level: 'warn' });
      await call('attach', { itemId: 'i1', source: html });
      await call('attach', { itemId: 'i1', source: 'https://example.com/big.pdf', name: 'Big' });
      await call('ask', { itemId: 'i1', question: 'Which audience?' });
      await call('progress', { itemId: 'i1', done: 1, total: 3 });
      await call('raise_finding', { itemId: 'i1', title: 'Typo', details: 'In the hero' });
      await call('add_note', { itemId: 'i1', text: 'Halfway there' });
      await call('report_usage', { runId, tokensIn: 500, tokensOut: 100, model: 'm' });
      await call('end_run', {
        runId,
        status: 'done',
        costEur: 0.42,
        tokensIn: 1000,
        tokensOut: 200,
        summary: 'Drafted',
      });
      await call('complete', { itemId: 'i1', runId });
      await call('read_item', { itemId: 'i1' });
    });
    // Sanity: the scenario really worked (not two identical failures).
    expect(r.ts.calls.every((c) => (c as { ok: boolean }).ok)).toBe(true);
    expect(r.ts.calls.find((c) => (c as { tool: string }).tool === 'complete')).toMatchObject({
      out: { movedTo: { stepId: 'review' }, status: 'waiting' },
    });
    expect(r.ts.docs['workspaces/w1/runs/<id>/log']).toHaveLength(2);
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('create_item (item DhsO9): created where allowed, with files; refused when off or not its project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-att-'));
    const md = join(dir, 'notes.md');
    writeFileSync(md, '# Steps');
    // The TypeScript side keeps its rate-limit file in a throwaway home too.
    const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
    process.env.HIVENOD_HOME = home;
    try {
      const r = await both(async (call) => {
        // Off (absent) in p1 at first.
        await call('create_item', { project: 'p1', title: 'Too early' });
        await put({ [P('p1')]: projectDoc({}, { agentsMayCreateItems: true }) });
        await put({ [P('p2')]: projectDoc({}, { agentsMayCreateItems: true }) });
        const made = out(
          await call('create_item', {
            project: 'Blog',
            title: '  Checkout times out ',
            description: 'Asked on Telegram.',
            attachments: [md, join(dir, 'missing.md')],
          }),
        ) as { itemId: string };
        await call('list_work', {});
        await call('claim', { itemId: made.itemId });
        // Not its project (p2 allows it, but the agent may use p1 only), unknown, blank title.
        await call('create_item', { project: 'p2', title: 'Elsewhere' });
        await call('create_item', { project: 'Nope', title: 'x' });
        await call('create_item', { project: 'p1', title: '   ' });
      });
      const oks = r.ts.calls.map((c) => (c as { ok: boolean }).ok);
      expect(oks).toEqual([false, true, true, true, false, false, false]);
      expect(r.ts.calls[1]).toMatchObject({ out: { status: 'queued', step: 'Intake' } });
      expect(r.go.calls).toEqual(r.ts.calls);
      expect(r.go.docs).toEqual(r.ts.docs);
    } finally {
      delete process.env.HIVENOD_HOME;
    }
  }, 120_000);

  it('inbox (item 4PEHr): messages, threads, dedup, subjects, notes, questions, outcomes approved by the person', async () => {
    const r = await both(async (call) => {
      const base = {
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we move the review to Thursday?',
        threadRef: 'thread-1',
        receivedAt: '2026-10-28T09:00:00Z',
        permalink: 'https://teams.example.com/m/1',
        replyRef: 'conv:1',
        attachments: [{ name: 'agenda.pdf', url: 'https://files.example.com/a.pdf' }],
      };
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const outcome = async (oid: string) =>
        (await snap(inboxPaths.outcome(W, oid))) as unknown as OutcomeStateOf;
      const t1 = out(await call('inbox_add', base)).threadId as string;
      await call('inbox_add', base); // the same message again: a duplicate
      await call('inbox_add', { ...base, messageId: 'm-2', text: 'Or Friday?' });
      await call('inbox_add', {
        ...base,
        source: 'mail',
        threadRef: '<x@example.com>',
        thread: t1,
      });
      const t2 = out(await call('inbox_add', { ...base, member: 'alice', messageId: 'm-a' }))
        .threadId as string;
      await call('inbox_add', { ...base, member: 'eve', messageId: 'x' });
      await call('inbox_add', { ...base, receivedAt: 'yesterday' });
      await call('inbox_add', { ...base, source: 'Teams', messageId: 'y' });
      await call('inbox_add', { ...base, messageId: 'z', thread: t2 });
      await call('inbox_list', {});
      await call('subject_list', {});
      await call('subject_assign', { threadId: t1, name: 'Review date (Payments)' });
      const sa = out(await call('subject_assign', { threadId: t2, name: 'review date (payments)' }))
        .subjectId as string;
      await call('subject_assign', { threadId: t1, subjectId: sa });
      await call('inbox_note', { threadId: t1, text: 'Checked the calendar: Thursday is free.' });
      await call('inbox_ask', { threadId: t1, question: 'Thursday or Friday?' });
      await owner.run(
        answerQuestion(owner.ctx, { threadId: t1, thread: await thread(t1), answer: 'Thursday' }),
      );
      const o1 = out(
        await call('outcome_propose', {
          threadId: t1,
          type: 'reply',
          fields: { text: 'Thursday works.' },
          note: 'They asked twice',
        }),
      ).outcomeId as string;
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'x', bcc: 'y' },
      });
      await call('outcome_done', { outcomeId: o1, status: 'done' });
      await owner.run(
        approveOutcome(owner.ctx, {
          outcomeId: o1,
          outcome: await outcome(o1),
          thread: await thread(t1),
          fields: { text: 'Thursday 10:00 works.' },
        }),
      );
      await call('inbox_list', {});
      await call('thread_read', { threadId: t1 });
      await call('outcome_done', {
        outcomeId: o1,
        status: 'done',
        result: { permalink: 'https://teams.example.com/m/9' },
      });
      await call('outcome_done', { outcomeId: o1, status: 'done' });
      const o2 = out(
        await call('outcome_propose', {
          threadId: t1,
          type: 'snooze',
          fields: { until: '2020-01-01T00:00:00Z' },
        }),
      ).outcomeId as string;
      await owner.run(
        approveOutcome(owner.ctx, {
          outcomeId: o2,
          outcome: await outcome(o2),
          thread: await thread(t1),
        }),
      );
      await call('inbox_list', {});
      await call('thread_wake', { threadId: t1 });
      await call('thread_wake', { threadId: t1 });
      await call('inbox_add', { ...base, messageId: 'm-3', text: 'Thanks!' });
      await call('thread_read', { threadId: t1 });
      await call('thread_read', { threadId: 'nope' });
      await call('subject_list', { member: 'alice' });
    });
    const oks = r.ts.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
    expect(r.ts.calls[1]).toMatchObject({ out: { duplicate: true } });
    expect(r.ts.calls[3]).toMatchObject({ out: { newThread: false } });
    expect(r.ts.calls[20]).toMatchObject({ out: { next: expect.stringMatching(/approved/) } });
    expect(r.ts.calls[21]).toMatchObject({ out: { threadState: 'waiting' } });
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('errors: gate, not claimed, wrong run, unknown item, oversized file, bad progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-att-'));
    const big = join(dir, 'big.txt');
    writeFileSync(big, 'x'.repeat(901 * 1024));
    const r = await both(async (call) => {
      await call('claim', { itemId: 'gated' });
      await call('complete', { itemId: 'gated', runId: 'whatever' });
      await call('ask', { itemId: 'i1', question: 'Tone?' });
      await call('add_note', { itemId: 'i1', text: 'x' });
      await call('read_item', { itemId: 'nope' });
      await call('attach', { itemId: 'i1', source: big });
      const { runId } = out(await call('claim', { itemId: 'i1' })) as { runId: string };
      await call('progress', { itemId: 'i1', done: 3, total: 2 });
      await call('complete', { itemId: 'i1', runId: 'not-the-run' });
      await call('log', { runId: 'not-a-run', text: 'x' });
      await call('log', { runId, text: 'still mine' });
      await call('release', { itemId: 'i1' });
      await call('release', { itemId: 'i1' });
    });
    expect(r.ts.calls.filter((c) => !(c as { ok: boolean }).ok).length).toBeGreaterThanOrEqual(8);
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('a failed run releases the item and counts toward the pause; 3 in a row pause the agent', async () => {
    const r = await both(async (call) => {
      for (let i = 0; i < 3; i++) {
        const { runId } = out(await call('claim', { itemId: 'i1' })) as { runId: string };
        await call('end_run', { runId, status: 'failed', summary: `fail ${i}` });
      }
      await call('list_work', {});
      await call('claim', { itemId: 'i1' });
    });
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('a revoked agent is told plainly', async () => {
    const r = await both(
      async (call) => {
        await call('list_work', {});
        await call('read_item', { itemId: 'i1' });
      },
      { revokedAt: now() },
    );
    expect(r.go.calls).toEqual(r.ts.calls);
  }, 60_000);

  it('a person sends it back: the next claim reads the reason; agent send-back to an earlier step', async () => {
    const r = await both(async (call) => {
      // Work the draft step, complete to the gate, a person sends it back to draft.
      const { runId } = out(await call('claim', { itemId: 'i1' })) as { runId: string };
      await call('complete', { itemId: 'i1', runId });
      const alice = as('alice');
      await alice.run(
        sendBack(alice.ctx, {
          project: { steps: projectDoc().steps },
          projectId: 'p1',
          itemId: 'i1',
          item: (await snap(I('i1'))) as unknown as ItemState,
          toStepId: 'draft',
          rationale: 'Needs sources for every claim',
          tags: [],
        }),
      );
      const again = out(await call('claim', { itemId: 'i1' })) as { runId: string };
      await call('read_item', { itemId: 'i1' });
      await call('send_back', {
        itemId: 'i1',
        runId: again.runId,
        toStep: 'intake',
        reason: 'Intake missed the audience',
      });
      await call('send_back', { itemId: 'i1', runId: again.runId, toStep: 'review', reason: 'x' });
    });
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('paths: shaping, skip, ask path change, propose step; a legacy item without paths', async () => {
    const r = await both(async (call) => {
      await put({
        [I('u1')]: itemDoc({ stepId: 'intake', status: 'queued', shape: null, title: 'Fix typo' }),
        [I('old')]: itemDoc({ stepId: 'intake', status: 'queued', title: 'Old item' }),
      });
      await call('list_work', {});
      const { runId } = out(await call('claim', { itemId: 'u1' })) as { runId: string };
      await call('read_item', { itemId: 'u1' });
      await call('shape_item', {
        itemId: 'u1',
        runId,
        skips: [{ stepId: 'nope', reason: 'x' }],
        note: 'tiny',
      });
      await call('shape_item', {
        itemId: 'u1',
        runId,
        skips: [
          { stepId: 'draft', reason: 'Nothing to write' },
          { stepId: 'review', reason: 'A one-word copy fix' },
        ],
        note: 'copy fix',
      });
      const second = out(await call('claim', { itemId: 'u1' })) as { runId: string };
      await call('skip_step', {
        itemId: 'u1',
        stepId: 'publish',
        skip: true,
        reason: 'Nothing to publish',
      });
      await call('skip_step', { itemId: 'u1', stepId: 'review', skip: true });
      await call('ask_path_change', {
        itemId: 'u1',
        stepId: 'publish',
        reason: 'Not a people step',
      });
      await call('propose_step', {
        itemId: 'u1',
        name: 'Legal review',
        kind: 'human',
        description: 'Check the terms',
        afterStepId: 'review',
        reason: 'The copy touches the terms of service',
      });
      await call('complete', { itemId: 'u1', runId: second.runId });
      await call('read_item', { itemId: 'u1' });
      // An item from before per-item paths.
      const old = out(await call('claim', { itemId: 'old' })) as { runId: string };
      await call('skip_step', { itemId: 'old', stepId: 'draft', skip: true, reason: 'Not needed' });
      await call('ask_path_change', {
        itemId: 'old',
        stepId: 'review',
        reason: 'A tiny copy change only',
      });
      await call('complete', { itemId: 'old', runId: old.runId });
    });
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('calendar (item w9SAf): upsert, free across organizations, delete, errors', async () => {
    const r = await both(async (call) => {
      await put({
        [paths.member(W, 'alice')]: {
          name: 'Alice',
          email: 'alice@example.com',
          photoURL: null,
          color: '#000',
        },
        // Busy time Alice has in another organization (no title, only the time).
        'users/alice/busy/wOther_x': {
          workspaceId: 'wOther',
          start: new Date('2030-01-07T12:00:00Z'),
          end: new Date('2030-01-07T13:30:00Z'),
          deleted: false,
          updatedAt: now(),
          lastEventId: 'seed',
        },
      });
      const up = out(
        await call('calendar_upsert', {
          member: 'Alice@Example.com',
          events: [
            {
              source: 'google',
              sourceEventId: 'g1',
              title: ' Standup ',
              start: '2030-01-07T09:00:00Z',
              end: '2030-01-07T09:30:00+00:00',
              attendees: ['bob@example.com'],
            },
            {
              source: 'google',
              sourceEventId: 'g2',
              title: 'Private',
              start: '2030-01-07T10:00Z',
              end: '2030-01-07T11:00:00.000Z',
              busyOnly: true,
            },
          ],
        }),
      ) as { ids: string[] };
      await call('calendar_upsert', {
        member: 'alice',
        events: [
          {
            source: 'google',
            sourceEventId: 'g1',
            title: 'Standup (moved)',
            start: '2030-01-07T09:15:00Z',
            end: '2030-01-07T09:45:00Z',
            allDay: false,
          },
        ],
      });
      await call('calendar_free', {
        member: 'alice',
        from: '2030-01-07T08:00:00Z',
        to: '2030-01-07T17:00:00Z',
      });
      await call('calendar_free', {
        member: 'Alice',
        from: '2030-01-07T08:00:00Z',
        to: '2030-01-07T17:00:00Z',
        minMinutes: 90,
      });
      await call('calendar_delete', { member: 'alice', source: 'google', sourceEventIds: ['g2'] });
      await call('calendar_delete', { ids: [up.ids[0]!, 'alice_nope'] });
      await call('calendar_free', {
        member: 'alice',
        from: '2030-01-07T08:00:00Z',
        to: '2030-01-07T17:00:00Z',
      });
      // errors
      await call('calendar_upsert', {
        member: 'alice',
        events: [
          { source: 'google', sourceEventId: 'x', start: 'tomorrow', end: '2030-01-07T09:00:00Z' },
        ],
      });
      await call('calendar_upsert', {
        member: 'alice',
        events: [
          {
            source: 'google',
            sourceEventId: 'x',
            start: '2030-01-07T10:00:00Z',
            end: '2030-01-07T09:00:00Z',
          },
        ],
      });
      await call('calendar_upsert', {
        member: 'eve',
        events: [
          {
            source: 'google',
            sourceEventId: 'x',
            start: '2030-01-07T08:00:00Z',
            end: '2030-01-07T09:00:00Z',
          },
        ],
      });
      await call('calendar_free', { from: '2030-01-07T08:00:00Z', to: '2030-01-07T09:00:00Z' });
      await call('calendar_free', {
        member: 'alice',
        from: '2030-01-07T08:00:00Z',
        to: '2030-04-07T09:00:00Z',
      });
      await call('calendar_delete', {});
    });
    const oks = r.ts.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(r.ts.calls[2]).toMatchObject({
      out: {
        free: [
          { start: '<iso>', end: '<iso>' },
          { start: '<iso>', end: '<iso>' },
          { start: '<iso>', end: '<iso>' },
        ],
        busyBlocks: 3,
      },
    });
    expect((r.ts.calls[3] as { out: { free: unknown[] } }).out.free).toHaveLength(1);
    expect(r.ts.calls[6]).toMatchObject({ out: { busyBlocks: 1 } });
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 120_000);

  it('wait_for_work returns at once when work waits, and times out when none does', async () => {
    const r = await both(async (call) => {
      await call('wait_for_work', { timeoutSeconds: 5 });
      await put({ [I('i1')]: itemDoc({ stepId: 'review', status: 'waiting' }) });
      await call('wait_for_work', { timeoutSeconds: 2 });
    });
    expect(r.go.calls).toEqual(r.ts.calls);
  }, 60_000);

  it('the 4th agent send-back holds the item for people', async () => {
    const r = await both(async (call) => {
      await put({ [I('i1')]: itemDoc({ stepId: 'draft', status: 'queued', agentSendBacks: 3 }) });
      const { runId } = out(await call('claim', { itemId: 'i1' })) as { runId: string };
      await call('send_back', {
        itemId: 'i1',
        runId,
        toStep: 'intake',
        reason: 'Still missing the audience',
      });
      await call('list_work', {});
      await call('read_item', { itemId: 'i1' });
    });
    expect(r.go.calls).toEqual(r.ts.calls);
    expect(r.go.docs).toEqual(r.ts.docs);
  }, 60_000);

  it('hivenod whoami --json says the same as the TypeScript CLI', async () => {
    await reset();
    const { token } = await newAgent({ guardrails: { maxFailedRuns: 5 } });
    const c = await HiveClient.connect({ token, projectId: PROJECT, authEmulator: AUTH_HOST });
    await c.refreshAgent();
    const want = c.whoami();
    await c.close();
    const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
    const res = spawnSync(BIN, ['whoami', '--json'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        HIVENOD_HOME: home,
        HIVENOD_TOKEN: token,
        HIVENOD_PROJECT_ID: PROJECT,
        HIVENOD_FIREBASE_API_KEY: 'fake-api-key',
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
        FIRESTORE_EMULATOR_HOST: FS_HOST,
      },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(JSON.parse(JSON.stringify(want)));
    expect(res.stdout).not.toContain(token);
  }, 60_000);

  it('hivenod pair: the code shown, confirmed by an admin, saves a working token (same agent.json)', async () => {
    await reset();
    const { uid, token } = await createAgentIdentity(options, W, {
      authEmulatorUrl: `http://${AUTH_HOST}`,
    });
    const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
    const child = spawn(BIN, ['pair'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        HIVENOD_HOME: home,
        HIVENOD_PROJECT_ID: PROJECT,
        HIVENOD_FIREBASE_API_KEY: 'fake-api-key',
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
        FIRESTORE_EMULATOR_HOST: FS_HOST,
      },
    });
    let said = '';
    child.stdout.on('data', (d: Buffer) => (said += d.toString()));
    child.stderr.on('data', (d: Buffer) => (said += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    await expect.poll(() => said, { timeout: 15_000 }).toMatch(/confirm the code/);
    const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said)!.slice(1).join('');
    expect(said).toContain(
      `https://hivenod.com/agents/connect?code=${code.slice(0, 4)}-${code.slice(4)}`,
    );
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
      doc(owner.db, pairingPath(code)),
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
    expect(await exited).toBe(0);
    expect(said).toContain('Paired: this machine is now the agent Writer (laptop)');
    expect(said).not.toContain(token);
    const saved = JSON.parse(readFileSync(join(home, 'agent.json'), 'utf8'));
    expect(saved).toMatchObject({
      token,
      workspaceId: W,
      agentUid: uid,
      agentName: 'Writer (laptop)',
    });
    expect(statSync(join(home, 'agent.json')).mode & 0o777).toBe(0o600);
    // The pairing request is gone, and the TypeScript CLI reads the saved file as its own.
    expect(await snap(pairingPath(code))).toEqual({});
    process.env.HIVENOD_HOME = home;
    try {
      expect(readCredentials()).toMatchObject({ token, agentName: 'Writer (laptop)' });
    } finally {
      delete process.env.HIVENOD_HOME;
    }
  }, 60_000);
  it('hivenod connect: a plain member confirms with one click, the token is saved, never shown', async () => {
    await reset();
    const { uid, token } = await createAgentIdentity(options, W, {
      authEmulatorUrl: `http://${AUTH_HOST}`,
    });
    const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
    // A stand-in `claude` that records the setup commands (no real Claude Code here).
    mkdirSync(join(home, 'bin'));
    writeFileSync(
      join(home, 'bin', 'claude'),
      `#!/bin/sh\necho "$*" >> ${join(home, 'claude.log')}\n`,
      { mode: 0o755 },
    );
    const PATH = `${join(home, 'bin')}:/usr/bin:/bin`;
    const child = spawn(BIN, ['connect'], {
      env: {
        PATH,
        HOME: home,
        HIVENOD_HOME: home,
        HIVENOD_NO_BROWSER: '1',
        HIVENOD_PROJECT_ID: PROJECT,
        HIVENOD_FIREBASE_API_KEY: 'fake-api-key',
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
        FIRESTORE_EMULATOR_HOST: FS_HOST,
      },
    });
    let said = '';
    child.stdout.on('data', (d: Buffer) => (said += d.toString()));
    child.stderr.on('data', (d: Buffer) => (said += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    await expect.poll(() => said, { timeout: 15_000 }).toMatch(/enter the code/);
    const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said)!.slice(1).join('');
    expect(said).toContain(`https://hivenod.com/connect?code=${code.slice(0, 4)}-${code.slice(4)}`);
    expect(said).toContain('It expires in 10 minutes');
    const alice = as('alice');
    const req = await getDoc(doc(alice.db, pairingPath(code)));
    expect(req.data()).toMatchObject({ status: 'pending', cli: 'claude', kind: 'connect' });
    await alice.run(
      createAgent(alice.ctx, {
        agentUid: uid,
        name: 'Claude Code (laptop)',
        color: '#2F5FD0',
        projectIds: ['p1'],
        tokenHint: 'a7f3',
      }),
    );
    const sealed = await sealToken(token, req.data()!.publicKey as string, code);
    await updateDoc(
      doc(alice.db, pairingPath(code)),
      toFirestoreValue(
        pairingCompletion({
          workspaceId: W,
          agentUid: uid,
          agentName: 'Claude Code (laptop)',
          pairedBy: 'alice',
          sealed,
        }),
      ) as Record<string, unknown>,
    );
    expect(await exited).toBe(0);
    expect(said).toContain('Connected: this machine is now the agent Claude Code (laptop)');
    expect(said).toContain('Claude Code has the hivenod plugin');
    expect(said).toContain('Start it with: hivenod claude');
    expect(readFileSync(join(home, 'claude.log'), 'utf8')).toBe(
      'plugin marketplace add wisely-solutions/hivenod\nplugin install hivenod@hivenod\n',
    );
    expect(said).not.toContain(token);
    const saved = JSON.parse(readFileSync(join(home, 'agent.json'), 'utf8'));
    expect(saved).toMatchObject({ token, workspaceId: W, agentUid: uid });
    expect(await snap(pairingPath(code))).toEqual({});
    // Run again: it says it is connected and creates no new request.
    const again = spawnSync(BIN, ['connect'], {
      encoding: 'utf8',
      env: { PATH, HOME: home, HIVENOD_HOME: home },
    });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('Already connected as Claude Code (laptop)');
  }, 60_000);
});
