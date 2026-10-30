/**
 * Contract suite for the Go CLI (item zLwtX2WEEg3mER4CR74g; Go-only since item MlWOc3O5NyfZcLgetrVo):
 * every scenario runs against the real Auth and Firestore emulators and the real rules, through the
 * Go binary (`hivenod mcp` over stdio), from a fresh world. The tool results and the resulting
 * Firestore documents, with random ids, timestamps and clock values masked, must equal the
 * recorded golden files in ../golden (first recorded when the TypeScript client and the Go CLI
 * gave the same results). After an intended change: UPDATE_GOLDEN=1 pnpm test:rules, then review
 * the diff. Needs Go (HIVENOD_GO or `go` on PATH); without it the suite is skipped with a warning.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
  rejectRelation,
  relateSubjects,
  relationId,
  approveOutcome,
  approvePlan,
  createMemberThread,
  retryPlanStep,
  sendBackPlan,
  type SendBackOf,
  requestRevision,
  requestRecheck,
  instructThread,
  inboxPaths,
  type PlanInput,
  setInboxLabels,
  setSubjectLabel,
  type OutcomeStateOf,
  type ThreadStateOf,
  type ItemState,
} from '@hive/shared';
import { toFirestoreValue } from '@hive/shared/firestore';
import { doc, getDoc, Timestamp, updateDoc } from 'firebase/firestore';
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
} from '../../../packages/shared/rules/harness';
import { GO, goBinary } from './gobin';
import { matchesGolden } from './golden';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJECT = 'hive-rules-test';
const options = { apiKey: 'fake-api-key', projectId: PROJECT };

let BIN = '';
beforeAll(() => {
  if (GO) BIN = goBinary();
}, 300_000);

// ---------- the Go binary behind one interface ----------

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
      'inboxRelations',
      'inboxPlans',
      'inboxAttachments',
    ])
      await read(`workspaces/${W}/${c}`);
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
/** Temporary folders (random names) in file paths. */
const TMP = tmpdir();
/** Masks what differs between two equal runs: random ids, the agent uid, timestamps, clocks. */
function mask(v: unknown, uid: string): unknown {
  if (typeof v === 'string')
    return (
      v
        .split(uid)
        .join('<agent>')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<iso>')
        .split(TMP)
        .join('<tmp>')
        .replace(/<tmp>[^\s:"]*/g, '<tmp>')
        .replace(ID, '<id>')
        // Thread attachment ids: {threadId}_{id}.
        .replace(/_[A-Za-z0-9]{20}\b/g, '_<id>')
    );
  if (typeof v === 'number') return v > 1e12 ? '<ms>' : v;
  if (Array.isArray(v)) return v.map((x) => mask(x, uid));
  if (v && typeof v === 'object') {
    if (typeof (v as { toMillis?: unknown }).toMillis === 'function') return '<ts>';
    return Object.fromEntries(
      Object.entries(v)
        // A decision's wait (slice 9) is a duration measured at run time.
        .map(
          ([k, x]) =>
            [
              mask(k, uid) as string,
              k === 'waitedMs' && typeof x === 'number' ? '<ms>' : mask(x, uid),
            ] as const,
        )
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
 * Runs a scenario on a fresh world through the Go binary. `scenario` gets a `call` that records
 * each result (masked) and returns it unmasked for the next calls.
 */
async function scenario(
  scenario: (call: Call, uid: string) => Promise<void>,
  agentExtra: Record<string, unknown> = {},
): Promise<Result> {
  await reset();
  const { uid, token } = await newAgent(agentExtra);
  const impl = await goImpl(token);
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
}

const out = (r: { out: unknown }) => r.out as Record<string, unknown>;

// ---------- scenarios ----------

const d = GO ? describe : describe.skip;

d('Go CLI contract (MCP tools, emulators, rules, golden files)', () => {
  it('claim, log, attach, ask, progress, finding, end run, complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-att-'));
    const html = join(dir, 'report.html');
    writeFileSync(html, '<h1>Bees</h1>');
    const r = await scenario(async (call) => {
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
    expect(r.calls.every((c) => (c as { ok: boolean }).ok)).toBe(true);
    expect(r.calls.find((c) => (c as { tool: string }).tool === 'complete')).toMatchObject({
      out: { movedTo: { stepId: 'review' }, status: 'waiting' },
    });
    expect(r.docs['workspaces/w1/runs/<id>/log']).toHaveLength(2);
    matchesGolden(r);
  }, 120_000);

  it('create_item (item DhsO9): created where allowed, with files; refused when off or not its project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-att-'));
    const md = join(dir, 'notes.md');
    writeFileSync(md, '# Steps');
    {
      const r = await scenario(async (call) => {
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
      const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
      expect(oks).toEqual([false, true, true, true, false, false, false]);
      expect(r.calls[1]).toMatchObject({ out: { status: 'queued', step: 'Intake' } });
      matchesGolden(r);
    }
  }, 120_000);

  it('inbox (item 4PEHr): messages, threads, dedup, subjects, notes, questions, outcomes approved by the person', async () => {
    const r = await scenario(async (call) => {
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
      await call('subject_assign', {
        threadId: t1,
        name: 'Review date (Payments)',
        area: 'Payments',
      });
      const sa = out(await call('subject_assign', { threadId: t2, name: 'review date (payments)' }))
        .subjectId as string;
      await call('subject_assign', { threadId: t1, subjectId: sa, area: 'Admin' });
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
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
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
    expect(r.calls[1]).toMatchObject({ out: { duplicate: true } });
    expect(r.calls[3]).toMatchObject({ out: { newThread: false } });
    expect(r.calls[20]).toMatchObject({ out: { next: expect.stringMatching(/approved/) } });
    expect(r.calls[21]).toMatchObject({ out: { threadState: 'waiting' } });
    matchesGolden(r);
  }, 120_000);

  it('subject search and related subjects (item 4PEHr): found by name, people, channel and text; links the person OKs', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const add = async (source: string, ref: string, name: string, text: string) =>
        out(
          await call('inbox_add', {
            source,
            sender: { name, handle: `${name.toLowerCase()}@example.com` },
            text,
            threadRef: ref,
            // Fixed: the default message id is the receivedAt milliseconds.
            receivedAt: '2026-10-28T09:00:00Z',
          }),
        ).threadId as string;
      const t1 = await add('teams', 'r1', 'Sam', 'Klarna refund stuck for order 12');
      const t2 = await add('jira', 'r2', 'Ana', 'Please give me Grafana access');
      const t3 = await add('mail', 'r3', 'Ana', 'Klarna payouts are late');
      const s1 = out(await call('subject_assign', { threadId: t1, name: 'Klarna refunds' }))
        .subjectId as string;
      const s2 = out(await call('subject_assign', { threadId: t2, name: 'Grafana access' }))
        .subjectId as string;
      const s3 = out(await call('subject_assign', { threadId: t3, name: 'Klarna payouts' }))
        .subjectId as string;
      await call('subject_search', {});
      await call('subject_search', { query: 'klarna' });
      await call('subject_search', { query: 'ana' });
      await call('subject_search', { query: 'jira' });
      await call('subject_search', { query: 'order 12' });
      await call('subject_search', { query: 'nothing like this' });
      await call('subject_search', { hasOpen: true, activeDays: 7, limit: 2 });
      await call('subject_search', { waitingForMe: true });
      await call('subject_relate', { a: s3, b: s1, note: 'Both Klarna' });
      await call('subject_relate', { a: s1, b: s3 });
      await call('subject_relate', { a: s1, b: s1 });
      await call('subject_relate', { a: s1, b: 'nope' });
      await call('subject_relate', { a: s2, b: s1 });
      await call('subject_search', { query: 'klarna' });
      const rel = (a: string, b: string) => inboxPaths.relation(W, relationId(a, b));
      await owner.run(
        relateSubjects(owner.ctx, {
          a: s1,
          b: s3,
          subjectA: { memberUid: 'owner' },
          subjectB: { memberUid: 'owner' },
          existing: (await snap(rel(s1, s3))) as never,
        }),
      );
      await owner.run(
        rejectRelation(owner.ctx, {
          relationId: relationId(s1, s2),
          relation: (await snap(rel(s1, s2))) as never,
        }),
      );
      await call('subject_relate', { a: s1, b: s2 });
      await call('subject_search', { query: 'klarna refunds' });
      // Urgent threads (thread_flag).
      await call('thread_flag', { threadId: t1, reason: 'Order 12 is stuck at checkout' });
      await call('thread_read', { threadId: t1 });
      await call('thread_flag', { threadId: t1, urgent: false });
      await call('thread_flag', { threadId: 'nope' });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      ...Array(6).fill(true),
      ...Array(8).fill(true),
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(r.calls[23]).toMatchObject({ out: { urgent: true } });
    const hits = (i: number) =>
      (out(r.calls[i] as never).subjects as { name: string }[]).map((x) => x.name);
    expect(hits(6)).toHaveLength(3);
    expect(hits(7)).toEqual(['Klarna payouts', 'Klarna refunds']);
    expect(hits(8)).toEqual(['Grafana access', 'Klarna payouts']);
    expect(hits(9)).toEqual(['Grafana access']);
    expect(hits(10)).toEqual(['Klarna refunds']);
    expect(hits(11)).toEqual([]);
    expect(r.calls[19]).toMatchObject({
      out: { subjects: [{ proposed: [{ name: 'Klarna refunds', note: 'Both Klarna' }] }, {}] },
    });
    expect(r.calls[21]).toMatchObject({
      out: { subjects: [{ name: 'Klarna refunds', related: [{ name: 'Klarna payouts' }] }] },
    });
    matchesGolden(r);
  }, 120_000);

  it('subject labels (item YaOEr): suggested by the agent from the workspace list, confirmed by the person, never overwritten', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const add = async (ref: string) =>
        out(
          await call('inbox_add', {
            source: 'mail',
            sender: { name: 'Sam Example', handle: 'sam@example.com' },
            text: `Question ${ref}`,
            threadRef: ref,
            receivedAt: '2026-10-28T09:00:00Z',
          }),
        ).threadId as string;
      const t1 = await add('r1');
      const t2 = await add('r2');
      const t3 = await add('r3');
      // The defaults are offered until an admin edits the list.
      await call('subject_list', {});
      const s1 = out(
        await call('subject_assign', { threadId: t1, name: 'Price list', label: 'sales' }),
      ).subjectId as string;
      // Not on the list: refused with the allowed values.
      await call('subject_assign', { threadId: t2, name: 'Login broken', label: 'Marketing' });
      await call('subject_list', {});
      // The person confirms; the agent cannot change a confirmed label.
      await owner.run(
        setSubjectLabel(owner.ctx, {
          subjectId: s1,
          subject: { memberUid: 'owner', name: 'Price list', label: 'Sales' },
          label: 'Sales',
        }),
      );
      await call('subject_assign', { threadId: t2, subjectId: s1, label: 'Support' });
      await call('subject_list', {});
      // An admin edits the list; the agent sees it on its next subject_list and uses it.
      await owner.run(setInboxLabels(owner.ctx, { labels: ['Deals', 'Tickets'] }));
      await call('subject_assign', { threadId: t3, name: 'Old label', label: 'Sales' });
      const s3 = out(
        await call('subject_assign', { threadId: t3, name: 'Renewal', label: 'deals' }),
      ).subjectId as string;
      await call('subject_assign', { threadId: t3, subjectId: s3, label: 'Tickets' });
      await call('subject_list', {});
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      true,
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
      true,
    ]);
    expect(r.calls[4]).toMatchObject({ out: { created: true, labelApplied: true } });
    expect(r.calls[3]).toMatchObject({
      out: { labels: ['Sales', 'Support', 'Billing', 'Partnership', 'Internal', 'Other'] },
    });
    expect(r.calls[7]).toMatchObject({ out: { labelApplied: false } });
    matchesGolden(r);
  }, 120_000);

  it('decision data (item kt3E7): confidence and checks, due dates, answer chips', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const t1 = out(
        await call('inbox_add', {
          source: 'mail',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Please sign off the price list by Friday noon.',
          threadRef: 'price-1',
          receivedAt: '2026-10-28T09:00:00Z',
        }),
      ).threadId as string;
      // Due dates (thread_due): set, read back, cleared; refused when bad.
      await call('thread_due', {
        threadId: t1,
        due: '2026-10-30T12:00:00+01:00',
        reason: 'Friday noon',
      });
      await call('thread_read', { threadId: t1 });
      await call('thread_due', { threadId: t1, due: null });
      await call('thread_due', { threadId: t1, due: 'Friday' });
      await call('thread_due', { threadId: t1, due: 5 });
      await call('thread_due', { threadId: 'nope', due: null });
      await call('thread_due', { threadId: t1, due: '2026-10-30T12:00:00Z' });
      // Answer chips: up to 4; the person answers with one.
      await call('inbox_ask', {
        threadId: t1,
        question: 'Sign as is, or ask for the 3% discount first?',
        options: ['Sign as is', 'Ask for 3%', 'x', 'y', 'z'],
      });
      await call('inbox_ask', {
        threadId: t1,
        question: 'Sign as is, or ask for the 3% discount first?',
        options: [' Sign as is ', 'Ask for 3%'],
      });
      await call('thread_read', { threadId: t1 });
      await owner.run(
        answerQuestion(owner.ctx, { threadId: t1, thread: await thread(t1), answer: 'Ask for 3%' }),
      );
      // Confidence and checks on a proposal.
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'Could you do 3% off? Then I sign today.' },
        note: 'You asked for the discount first.',
        confidence: 'high',
        checks: ['Last year: 3% for early sign-off', 'Your answer: ask for 3%'],
      });
      await call('outcome_propose', {
        threadId: t1,
        type: 'no_reply',
        fields: {},
        confidence: 'sure',
      });
      await call('outcome_propose', {
        threadId: t1,
        type: 'no_reply',
        fields: {},
        checks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });
      await call('thread_read', { threadId: t1 });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      false,
      true,
      true,
      true,
      false,
      false,
      true,
    ]);
    expect(r.calls[2]).toMatchObject({ out: { due: '<iso>' } });
    expect(r.calls[10]).toMatchObject({
      out: { question: { options: ['Sign as is', 'Ask for 3%'], answer: null } },
    });
    expect(r.calls[14]).toMatchObject({
      out: {
        due: '<iso>',
        outcomes: [
          {
            confidence: 'high',
            checks: ['Last year: 3% for early sign-off', 'Your answer: ask for 3%'],
          },
        ],
      },
    });
    matchesGolden(r);
  }, 120_000);

  it('ask for changes (item L7OzW): the proposer revises in place, versions kept, a late revision refused', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const outcome = async (oid: string) =>
        (await snap(inboxPaths.outcome(W, oid))) as unknown as OutcomeStateOf;
      const t1 = out(
        await call('inbox_add', {
          source: 'teams',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Can we move the payments review to Thursday?',
          threadRef: 'review-1',
          receivedAt: '2026-10-28T09:00:00Z',
        }),
      ).threadId as string;
      const oid = out(
        await call('outcome_propose', {
          threadId: t1,
          type: 'reply',
          fields: { text: 'Hi Sam, thanks for flagging this. Thursday works for me. Best, Cara' },
          note: 'They asked to move it.',
          confidence: 'high',
        }),
      ).outcomeId as string;
      // Nobody asked yet: refused.
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'x' },
        revises: oid,
      });
      const ask = async (chips: string[], instruction: string | null) =>
        owner.run(
          requestRevision(owner.ctx, {
            outcomeId: oid,
            outcome: await outcome(oid),
            thread: await thread(t1),
            chips,
            instruction,
          }),
        );
      await ask(['shorter', 'availability'], 'Mention 14:00 as a backup');
      await call('thread_read', { threadId: t1 });
      // Another type: refused, propose a new outcome instead.
      await call('outcome_propose', {
        threadId: t1,
        type: 'nudge',
        fields: { text: 'x' },
        revises: oid,
      });
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'Hi Sam, Thursday 10:00 works; 14:00 is free too. Cara' },
        note: 'Shorter, with a backup.',
        confidence: 'medium',
        checks: ['Thu 14:00 free'],
        revises: oid,
      });
      await call('thread_read', { threadId: t1 });
      // Asked again, but the person sends v1 meanwhile: the late revision is refused.
      await ask(['warmer'], null);
      const o = await outcome(oid);
      await owner.run(
        approveOutcome(owner.ctx, {
          outcomeId: oid,
          outcome: o,
          thread: await thread(t1),
          version: 1,
        }),
      );
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'Late.' },
        revises: oid,
      });
      await call('thread_read', { threadId: t1 });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([true, true, false, true, false, true, true, false, true]);
    expect(r.calls[3]).toMatchObject({
      out: {
        outcomes: [
          { state: 'revising', versions: 1, revise: { chips: ['shorter', 'availability'] } },
        ],
      },
    });
    expect(r.calls[5]).toMatchObject({ out: { version: 2, state: 'proposed' } });
    expect(r.calls[8]).toMatchObject({
      out: {
        outcomes: [
          {
            state: 'approved',
            versions: 2,
            fields: { text: 'Hi Sam, thanks for flagging this. Thursday works for me. Best, Cara' },
          },
        ],
      },
    });
    matchesGolden(r);
  }, 120_000);

  it('re-check (item bmNoI): the home agent answers once per request, still good stamps the proposal, or it revises unasked', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const t1 = out(
        await call('inbox_add', {
          source: 'teams',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Can we move the payments review to Thursday?',
          threadRef: 'review-2',
          receivedAt: '2026-10-28T09:00:00Z',
        }),
      ).threadId as string;
      const oid = out(
        await call('outcome_propose', {
          threadId: t1,
          type: 'reply',
          fields: { text: 'Thursday works for me.' },
          note: 'They asked to move it.',
        }),
      ).outcomeId as string;
      // Nobody asked: refused (the answer and an unasked revision).
      await call('thread_recheck_done', { threadId: t1, result: 'still_good' });
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'x' },
        revises: oid,
      });
      const ask = async () =>
        owner.run(requestRecheck(owner.ctx, { threadId: t1, thread: await thread(t1) }));
      await ask();
      await call('thread_read', { threadId: t1 });
      await call('thread_recheck_done', { threadId: t1, result: 'fine' });
      await call('thread_recheck_done', {
        threadId: t1,
        result: 'still_good',
        note: 'No new messages; Thursday 10:00 is still free.',
      });
      await call('thread_read', { threadId: t1 });
      // Asked again: this time it changed, so the agent writes v2 unasked.
      await ask();
      await call('outcome_propose', {
        threadId: t1,
        type: 'reply',
        fields: { text: 'Thursday is taken now; Friday 10:00 works for me.' },
        note: 'Thursday got booked since.',
        revises: oid,
      });
      await call('thread_recheck_done', {
        threadId: t1,
        result: 'revised',
        note: 'Moved to Friday.',
      });
      // Answered: once only.
      await call('thread_recheck_done', { threadId: t1, result: 'still_good' });
      await call('thread_read', { threadId: t1 });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
    ]);
    expect(r.calls[4]).toMatchObject({ out: { recheck: { state: 'pending', result: null } } });
    expect(r.calls[6]).toMatchObject({
      out: { result: 'still_good', checked: [expect.any(String)] },
    });
    expect(r.calls[7]).toMatchObject({
      out: { recheck: { state: 'done', result: 'still_good' }, outcomes: [{ state: 'proposed' }] },
    });
    expect(r.calls[8]).toMatchObject({ out: { version: 2, state: 'proposed' } });
    expect(r.calls[11]).toMatchObject({
      out: {
        recheck: { state: 'done', result: 'revised', note: 'Moved to Friday.' },
        outcomes: [
          { versions: 2, fields: { text: 'Thursday is taken now; Friday 10:00 works for me.' } },
        ],
      },
    });
    matchesGolden(r);
  }, 120_000);

  it('ask the agent (item w6O2K): the home agent answers each request once, with a note or the proposal it made, and sets chips', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const t1 = out(
        await call('inbox_add', {
          source: 'teams',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Looking forward to the review on Thursday.',
          threadRef: 'review-3',
          receivedAt: '2026-10-28T09:00:00Z',
        }),
      ).threadId as string;
      const ask = async (extra: { text?: string; chip?: string }) => {
        const p = instructThread(owner.ctx, { threadId: t1, thread: await thread(t1), ...extra });
        await owner.run(p);
        return p.eventId;
      };
      // Nobody asked: refused.
      await call('thread_answer_instruction', {
        threadId: t1,
        instructionId: 'nope',
        kind: 'note',
        note: 'x',
      });
      const i1 = await ask({ text: 'Prepare me for the Thursday review.' });
      await call('thread_read', { threadId: t1 });
      await call('thread_answer_instruction', { threadId: t1, instructionId: i1, kind: 'note' });
      await call('thread_answer_instruction', {
        threadId: t1,
        instructionId: i1,
        kind: 'note',
        note: 'Sam leads it; bring the Q3 numbers.',
      });
      // Answered: once only.
      await call('thread_answer_instruction', {
        threadId: t1,
        instructionId: i1,
        kind: 'ask',
      });
      // A chip; answered with the proposal it made (which waits for approval).
      const i2 = await ask({ chip: 'draft_reply' });
      const oid = out(
        await call('outcome_propose', {
          threadId: t1,
          type: 'reply',
          fields: { text: 'Thanks Sam, see you Thursday.' },
          note: 'You asked for a reply.',
        }),
      ).outcomeId as string;
      await call('thread_answer_instruction', {
        threadId: t1,
        instructionId: i2,
        kind: 'outcome',
        refId: 'not-there',
      });
      await call('thread_answer_instruction', {
        threadId: t1,
        instructionId: i2,
        kind: 'outcome',
        refId: oid,
      });
      await call('thread_suggest_chips', { threadId: t1, chips: ['summarize', 'dance'] });
      await call('thread_suggest_chips', { threadId: t1, chips: ['summarize', 'recheck'] });
      await call('thread_read', { threadId: t1 });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      true,
    ]);
    expect(r.calls[2]).toMatchObject({
      out: {
        instructions: [{ text: 'Prepare me for the Thursday review.', state: 'pending' }],
        next: expect.stringContaining('thread_answer_instruction'),
      },
    });
    expect(r.calls[11]).toMatchObject({
      out: {
        instructions: [
          {
            state: 'answered',
            answer: { kind: 'note', note: 'Sam leads it; bring the Q3 numbers.' },
          },
          { chip: 'draft_reply', state: 'answered', answer: { kind: 'outcome' } },
        ],
        suggestedChips: ['summarize', 'recheck'],
        outcomes: [{ state: 'proposed' }],
      },
    });
    matchesGolden(r);
  }, 120_000);

  it('summaries (item OE8Fm): the home agent writes versions, thread_read shows them, a stale base and a person step without a visual are refused', async () => {
    const r = await scenario(async (call) => {
      const t1 = out(
        await call('inbox_add', {
          source: 'teams',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Can we ship release 175 today?',
          threadRef: 'rel-175',
          receivedAt: '2026-10-28T09:00:00Z',
        }),
      ).threadId as string;
      await call('thread_read', { threadId: t1 });
      const summary = {
        headline: 'Release 175: ship today?',
        ask: 'Ship release 175 today?',
        answer: 'All checks green; 2 changes, no migration',
        recommendation: { action: 'Approve', why: 'Green and small' },
        confidence: 'high',
        bullets: [
          '412 tests pass',
          {
            text: 'Check time 10 min',
            refs: [{ kind: 'link', id: 'pr86', label: 'PR #86', url: 'https://example.com/pr/86' }],
          },
        ],
        details: '## What changed\n- two fixes',
        visuals: [
          {
            kind: 'bar',
            title: 'Check time',
            caption: 'Down from 14 to 10 minutes',
            unit: 'min',
            x: ['r173', 'r174', 'r175'],
            series: [{ name: 'minutes', values: [14, 12.5, 10] }],
            highlight: 2,
            better: 'down',
          },
          {
            kind: 'flow',
            title: 'Plan',
            caption: 'Ship is next',
            nodes: [
              { id: 'b', label: 'Build', who: 'agent', state: 'done' },
              { id: 's', label: 'Ship it?', who: 'person', state: 'now' },
            ],
          },
        ],
      };
      // A person step without a visual or a reason: refused.
      await call('thread_summary', {
        threadId: t1,
        baseVersion: 0,
        summary: { ...summary, visuals: [] },
      });
      await call('thread_summary', { threadId: t1, baseVersion: 0, summary });
      // A stale base: refused; the right one writes v2.
      await call('thread_summary', { threadId: t1, baseVersion: 0, summary });
      await call('thread_summary', {
        threadId: t1,
        baseVersion: 1,
        summary: { headline: 'Release 175 shipped', bullets: ['Live since 10:02'] },
      });
      await call('thread_read', { threadId: t1 });
      await call('inbox_list', {});
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([true, true, false, true, false, true, true, true]);
    expect(r.calls[1]).toMatchObject({
      out: {
        summary: null,
        summaryNext: expect.stringContaining('thread_summary (baseVersion 0)'),
      },
    });
    expect(r.calls[2]).toMatchObject({
      ok: false,
      out: expect.stringContaining('At a person step'),
    });
    expect(r.calls[3]).toMatchObject({ out: { version: 1 } });
    expect(r.calls[4]).toMatchObject({ ok: false, out: expect.stringContaining('moved on to v1') });
    expect(r.calls[6]).toMatchObject({
      out: {
        summary: {
          version: 2,
          state: 'fresh',
          headline: 'Release 175 shipped',
          ask: null,
          bullets: [{ text: 'Live since 10:02', refs: [] }],
          visuals: [],
        },
      },
    });
    expect((r.calls[6] as { out: Record<string, unknown> }).out.summaryNext).toBeUndefined();
    matchesGolden(r);
  }, 120_000);

  it('thread attachments (item OE8Fm, slice 4): the home agent attaches screenshots and shows them as an image pair; other threads, SVG and missing images are refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hivenod-shots-'));
    // A 1x1 PNG, twice (before and after), and an SVG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(dir, 'before.png'), png);
    writeFileSync(join(dir, 'after.png'), png);
    writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'report.html'), '<h1>Checks</h1>');
    const r = await scenario(async (call) => {
      const add = async (ref: string) =>
        out(
          await call('inbox_add', {
            source: 'teams',
            sender: { name: 'Sam Example', handle: 'sam@example.com' },
            text: `Ship the new card? (${ref})`,
            threadRef: ref,
            receivedAt: '2026-10-28T09:00:00Z',
          }),
        ).threadId as string;
      const t1 = await add('card-1');
      const t2 = await add('card-2');
      const b4 = out(await call('thread_attach', { threadId: t1, source: join(dir, 'before.png') }))
        .attachmentId as string;
      const af = out(
        await call('thread_attach', {
          threadId: t1,
          source: join(dir, 'after.png'),
          name: 'Inbox card, after',
        }),
      ).attachmentId as string;
      await call('thread_attach', { threadId: t1, source: join(dir, 'report.html') });
      await call('thread_attach', { threadId: t1, source: join(dir, 'logo.svg') });
      await call('thread_attach', { threadId: t1, source: 'http://example.com/a.png' });
      const other = out(
        await call('thread_attach', { threadId: t2, source: join(dir, 'before.png') }),
      ).attachmentId as string;
      const pair = (before: string, after: string) => ({
        headline: 'The Inbox card shows the summary',
        ask: 'Ship the new card?',
        bullets: ['One screen changed'],
        visuals: [
          {
            kind: 'image_pair',
            title: 'Inbox card',
            caption: 'The card asks the question first',
            before,
            after,
          },
        ],
      });
      // Another thread's screenshot, a missing one, then the real pair.
      await call('thread_summary', { threadId: t1, baseVersion: 0, summary: pair(b4, other) });
      await call('thread_summary', {
        threadId: t1,
        baseVersion: 0,
        summary: pair(b4, `${t1}_nope`),
      });
      await call('thread_summary', { threadId: t1, baseVersion: 0, summary: pair(b4, af) });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([true, true, true, true, true, false, false, true, false, false, true]);
    expect(r.calls[2]).toMatchObject({ out: { kind: 'image', name: 'before.png' } });
    expect(r.calls[5]).toMatchObject({ ok: false, out: expect.stringContaining('webp') });
    expect(r.calls[6]).toMatchObject({ ok: false, out: expect.stringContaining('https') });
    expect(r.calls[8]).toMatchObject({
      ok: false,
      out: expect.stringContaining('is not an attachment of this thread'),
    });
    expect(r.calls[9]).toMatchObject({ ok: false, out: expect.stringContaining('no image') });
    expect(r.calls[10]).toMatchObject({ out: { version: 1 } });
    expect(r.docs[`workspaces/${W}/inboxAttachments`]).toHaveLength(4);
    matchesGolden(r);
  }, 120_000);

  it('plans (item qwFAW): one call proposes, steps run in order, a gate waits for the person, Build it runs until done', async () => {
    const r = await scenario(async (call) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const outcome = async (oid: string) =>
        (await snap(inboxPaths.outcome(W, oid))) as unknown as OutcomeStateOf;
      const planOf = async (pid: string): Promise<PlanInput> => {
        const plan = (await snap(inboxPaths.plan(W, pid))) as unknown as PlanInput['plan'];
        const outcomes: Record<string, OutcomeStateOf> = {};
        for (const id of plan.steps) outcomes[id] = await outcome(id);
        return { planId: pid, plan, outcomes };
      };
      const t1 = out(
        await call('inbox_add', {
          source: 'teams',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Can you update the price list on the website? A goes from 10 to 12.',
          threadRef: 'prices-1',
          receivedAt: '2026-10-29T09:00:00Z',
        }),
      ).threadId as string;
      // Refused: a step type that ends the thread, and a plan without steps.
      await call('plan_propose', {
        threadId: t1,
        steps: [{ type: 'no_reply', fields: {} }],
      });
      await call('plan_propose', { threadId: t1, steps: [] });
      const p = out(
        await call('plan_propose', {
          threadId: t1,
          note: 'Confirm, get your OK on the prices, update the site, then tell Sam.',
          confidence: 'medium',
          steps: [
            { type: 'reply', fields: { text: 'On it, Sam.', holding: true }, confidence: 'high' },
            { type: 'approval', fields: { what: 'New price list', detail: 'A: 10 → 12' } },
            { type: 'make_it_work', fields: { title: 'Update the price list', project: 'p1' } },
            { type: 'reply', fields: { text: 'Done: the new prices are live.' } },
          ],
        }),
      );
      const pid = p.planId as string;
      const [s1, s2, s3, s4] = p.stepIds as string[];
      await call('thread_read', { threadId: t1 });
      // Nothing approved: nothing to carry out, and step 1 cannot be reported.
      await call('inbox_list', {});
      await call('outcome_done', { outcomeId: s1!, status: 'done' });
      await owner.run(approvePlan(owner.ctx, { ...(await planOf(pid)), thread: await thread(t1) }));
      // Only step 1 is its turn; step 3 is approved but must wait.
      await call('inbox_list', {});
      await call('outcome_done', { outcomeId: s3!, status: 'started', result: { itemId: 'i1' } });
      await call('outcome_done', {
        outcomeId: s1!,
        status: 'done',
        result: { permalink: 'https://teams.example.com/m/1' },
      });
      // The gate waits for the person: nothing to carry out.
      await call('inbox_list', {});
      await call('thread_read', { threadId: t1 });
      const pl = await planOf(pid);
      await owner.run(
        approveOutcome(owner.ctx, {
          outcomeId: s2!,
          outcome: pl.outcomes[s2!]!,
          thread: await thread(t1),
          plan: pl,
        }),
      );
      await call('inbox_list', {});
      // Build it: started with the item, done when the item is Done.
      await call('outcome_done', { outcomeId: s3!, status: 'started' });
      // Build it (slice 6): the item must exist; its link is filled in.
      await call('outcome_done', { outcomeId: s3!, status: 'started', result: { itemId: 'nope' } });
      await call('outcome_done', { outcomeId: s3!, status: 'started', result: { itemId: 'i1' } });
      await call('thread_read', { threadId: t1 });
      await call('outcome_done', { outcomeId: s3!, status: 'done', result: { itemId: 'i1' } });
      await call('inbox_list', {});
      await call('outcome_done', {
        outcomeId: s4!,
        status: 'failed',
        result: { error: 'Teams said 403' },
      });
      // Blocked until the person retries; then it is its turn again.
      await call('outcome_done', { outcomeId: s4!, status: 'done' });
      await owner.run(
        retryPlanStep(owner.ctx, { ...(await planOf(pid)), thread: await thread(t1) }),
      );
      await call('outcome_done', { outcomeId: s4!, status: 'done' });
      await call('thread_read', { threadId: t1 });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
    expect(r.calls[5]).toMatchObject({ out: { toCarryOut: [] } });
    expect(r.calls[7]).toMatchObject({ out: { toCarryOut: [{ step: '1 of 4', type: 'reply' }] } });
    expect(r.calls[10]).toMatchObject({ out: { toCarryOut: [] } });
    expect(r.calls[12]).toMatchObject({
      out: { toCarryOut: [{ step: '3 of 4', type: 'make_it_work' }] },
    });
    expect(r.calls[14]).toMatchObject({
      ok: false,
      out: expect.stringContaining('Item nope not found'),
    });
    expect(r.calls[15]).toMatchObject({ out: { state: 'running' } });
    expect(r.calls[16]).toMatchObject({
      out: { state: 'waiting', waiting: { on: 'item' }, plans: [{ progress: 'Step 3 of 4' }] },
    });
    expect(r.calls[19]).toMatchObject({ out: { state: 'failed', threadState: 'yourCall' } });
    expect(r.calls[22]).toMatchObject({
      out: { state: 'waiting', plans: [{ state: 'done', progress: 'Done' }] },
    });
    matchesGolden(r);
  }, 120_000);

  it('development plans (item OE8Fm, slice 6): a New thread from the template runs gate by gate; send backs from the person and the agent; the third blocks', async () => {
    const r = await scenario(async (call, uid) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const planOf = async (pid: string): Promise<PlanInput & { plan: SendBackOf }> => {
        const plan = (await snap(inboxPaths.plan(W, pid))) as unknown as PlanInput['plan'] &
          SendBackOf;
        const outcomes: Record<string, OutcomeStateOf> = {};
        for (const id of plan.steps)
          outcomes[id] = (await snap(inboxPaths.outcome(W, id))) as unknown as OutcomeStateOf;
        return { planId: pid, plan, outcomes };
      };
      const gate = async (pid: string) => {
        const pl = await planOf(pid);
        const id = pl.plan.steps[pl.plan.cursor]!;
        await owner.run(
          approveOutcome(owner.ctx, {
            outcomeId: id,
            outcome: pl.outcomes[id]!,
            thread: await thread(pl.plan.threadId),
            plan: pl,
            summaryVersion: 1,
          }),
        );
      };
      // The person's New thread with the Development template: Shape is theirs, approved.
      const made = createMemberThread(owner.ctx, {
        title: 'Dark mode',
        text: 'Add a dark mode to the board.',
        agentUid: uid,
        template: 'dev',
        threadId: 'dev1',
        planId: 'dp1',
        stepIds: ['ds1', 'ds2', 'ds3', 'ds4', 'ds5', 'ds6', 'ds7'],
      });
      await owner.run(made);
      await call('inbox_list', {});
      await call('thread_read', { threadId: 'dev1' });
      // Build is approved but not its turn.
      await call('outcome_done', { outcomeId: 'ds3', status: 'done' });
      await call('outcome_done', { outcomeId: 'ds1', status: 'done', result: { text: 'Size M' } });
      // Approve idea waits for the person; then Build: an open, unmerged PR.
      await call('inbox_list', {});
      await gate('dp1');
      await call('outcome_done', {
        outcomeId: 'ds3',
        status: 'done',
        result: { permalink: 'https://github.com/example/board/pull/86', text: 'PR #86 open' },
      });
      // Keep green (slice 6c): green and current, so Ship it? is offered; main moves while it
      // waits: re-checking on the done step, then green again.
      await call('outcome_done', {
        outcomeId: 'ds4',
        status: 'done',
        result: { text: 'Green on 4f2a1c0' },
      });
      await call('step_progress', {
        outcomeId: 'ds4',
        line: 'main moved to 9b1e2d3: rebasing',
        check: 'rechecking',
      });
      await call('step_progress', { outcomeId: 'ds4', line: 'green on 9b1e2d3', check: 'green' });
      // Ship it? → Build, from the person.
      await owner.run(
        sendBackPlan(owner.ctx, {
          ...(await planOf('dp1')),
          thread: await thread('dev1'),
          reason: 'Bigger toggle',
        }),
      );
      await call('thread_read', { threadId: 'dev1' });
      await call('inbox_list', {});
      await call('outcome_done', {
        outcomeId: 'ds3',
        status: 'done',
        result: { text: 'PR #86 updated' },
      });
      await call('outcome_done', { outcomeId: 'ds4', status: 'done' });
      await gate('dp1');
      // Ship it? decided: Keep green has ended.
      await call('step_progress', { outcomeId: 'ds4', line: 'main moved', check: 'rechecking' });
      // Release finds a bug: the agent sends the plan back to Build (refused: to a gate, no reason).
      await call('plan_send_back', { threadId: 'dev1', reason: 'x', toStep: 5 });
      await call('plan_send_back', { threadId: 'dev1', reason: ' ' });
      await call('plan_send_back', { threadId: 'dev1', reason: 'e2e fails on main', toStep: 3 });
      await call('outcome_done', { outcomeId: 'ds3', status: 'done', result: { text: 'Fixed' } });
      await call('outcome_done', { outcomeId: 'ds4', status: 'done' });
      await gate('dp1');
      // The third send back blocks the plan for the person; by default it goes back to the
      // nearest agent step, Keep green (slice 6c).
      await call('plan_send_back', { threadId: 'dev1', reason: 'Still failing' });
      await call('outcome_done', { outcomeId: 'ds4', status: 'done' });
      await call('thread_read', { threadId: 'dev1' });
      await owner.run(
        retryPlanStep(owner.ctx, { ...(await planOf('dp1')), thread: await thread('dev1') }),
      );
      await call('outcome_done', { outcomeId: 'ds4', status: 'done' });
      // The agent's own Development plan on a thread: proposed, nothing approved.
      await call('plan_propose', {
        threadId: 'dev1',
        template: 'dev',
        steps: [{ type: 'shape', fields: { idea: 'A second idea' } }],
      });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
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
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(r.calls[0]).toMatchObject({ out: { toCarryOut: [{ step: '1 of 7', type: 'shape' }] } });
    expect(r.calls[9]).toMatchObject({
      out: {
        plans: [
          { templateId: 'dev', sentBack: { n: 1, toStep: '3 of 7', reason: 'Bigger toggle' } },
        ],
      },
    });
    expect(r.calls[13]).toMatchObject({ ok: false });
    expect(JSON.stringify(r.calls[13])).toContain('Keep green ended');
    expect(r.calls[16]).toMatchObject({ out: { toStep: 3, blocked: false } });
    expect(r.calls[19]).toMatchObject({ out: { toStep: 4, blocked: true } });
    expect(r.calls[21]).toMatchObject({
      out: { state: 'yourCall', plans: [{ state: 'blocked' }] },
    });
    expect(r.calls[23]).toMatchObject({ out: { state: 'proposed' } });
    const steps = (r.calls[23] as { out: { steps: { type: string }[] } }).out.steps;
    expect(steps.map((x) => x.type)).toEqual([
      'shape',
      'approval',
      'build',
      'keepgreen',
      'approval',
      'release',
      'approval',
    ]);
    matchesGolden(r);
  }, 120_000);

  it('long steps (item OE8Fm, slice 6b): Build starts with no item, reports progress, ends done with its usage', async () => {
    const r = await scenario(async (call, uid) => {
      const owner = as('owner');
      const thread = async (tid: string) =>
        (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
      const planOf = async (pid: string): Promise<PlanInput> => {
        const plan = (await snap(inboxPaths.plan(W, pid))) as unknown as PlanInput['plan'];
        const outcomes: Record<string, OutcomeStateOf> = {};
        for (const id of plan.steps)
          outcomes[id] = (await snap(inboxPaths.outcome(W, id))) as unknown as OutcomeStateOf;
        return { planId: pid, plan, outcomes };
      };
      await owner.run(
        createMemberThread(owner.ctx, {
          title: 'Dark mode',
          text: 'Add a dark mode to the board.',
          agentUid: uid,
          template: 'dev',
          threadId: 'lt1',
          planId: 'lp1',
          stepIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
        }),
      );
      await call('outcome_done', { outcomeId: 'l1', status: 'done' });
      const pl = await planOf('lp1');
      await owner.run(
        approveOutcome(owner.ctx, {
          outcomeId: 'l2',
          outcome: pl.outcomes.l2!,
          thread: await thread('lt1'),
          plan: pl,
        }),
      );
      // Progress before the start is refused; then started with no item.
      await call('step_progress', { outcomeId: 'l3', line: 'Reading the code' });
      await call('outcome_done', { outcomeId: 'l3', status: 'started' });
      await call('step_progress', {
        outcomeId: 'l3',
        line: 'Tests green, writing the PR',
        percent: 70,
      });
      await call('step_progress', { outcomeId: 'l3', line: 'x', percent: 101 });
      await call('thread_read', { threadId: 'lt1' });
      await call('outcome_done', {
        outcomeId: 'l3',
        status: 'done',
        result: { permalink: 'https://github.com/example/board/pull/86', text: 'PR #86 open' },
        usage: { tokens: 123456, costEur: 1.23 },
      });
      // Keep green (slice 6c): a long step too; not solvable: failed with the evidence blocks the
      // plan, and the person sends it back to Build.
      await call('outcome_done', { outcomeId: 'l4', status: 'started' });
      await call('step_progress', {
        outcomeId: 'l4',
        line: 'rebased on main 4f2a1c0, 212/214 green, fixing lint',
        percent: 90,
      });
      await call('step_progress', { outcomeId: 'l4', line: 'x', check: 'red' });
      await call('outcome_done', {
        outcomeId: 'l4',
        status: 'failed',
        result: { error: 'lint fails after 3 fixes: no-unused-vars in src/a.ts; tried 3 fixes' },
      });
      await call('thread_read', { threadId: 'lt1' });
      await owner.run(
        sendBackPlan(owner.ctx, {
          ...((await planOf('lp1')) as PlanInput & { plan: SendBackOf }),
          thread: await thread('lt1'),
          reason: 'Fix the lint in Build',
        }),
      );
      await call('thread_read', { threadId: 'lt1' });
    });
    const oks = r.calls.map((c) => (c as { ok: boolean }).ok);
    expect(oks).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(r.calls[11]).toMatchObject({ out: { plans: [{ state: 'blocked' }] } });
    expect(r.calls[12]).toMatchObject({
      out: { plans: [{ state: 'active', sentBack: { n: 1, toStep: '3 of 7' } }] },
    });
    expect(r.calls[2]).toMatchObject({ out: { state: 'running' } });
    expect(r.calls[5]).toMatchObject({ out: { state: 'waiting', waiting: { on: 'item' } } });
    matchesGolden(r);
  }, 120_000);

  it('errors: gate, not claimed, wrong run, unknown item, oversized file, bad progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-att-'));
    const big = join(dir, 'big.txt');
    writeFileSync(big, 'x'.repeat(901 * 1024));
    const r = await scenario(async (call) => {
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
    expect(r.calls.filter((c) => !(c as { ok: boolean }).ok).length).toBeGreaterThanOrEqual(8);
    matchesGolden(r);
  }, 120_000);

  it('a failed run releases the item and counts toward the pause; 3 in a row pause the agent', async () => {
    const r = await scenario(async (call) => {
      for (let i = 0; i < 3; i++) {
        const { runId } = out(await call('claim', { itemId: 'i1' })) as { runId: string };
        await call('end_run', { runId, status: 'failed', summary: `fail ${i}` });
      }
      await call('list_work', {});
      await call('claim', { itemId: 'i1' });
    });
    matchesGolden(r);
  }, 120_000);

  it('a revoked agent is told plainly', async () => {
    const r = await scenario(
      async (call) => {
        await call('list_work', {});
        await call('read_item', { itemId: 'i1' });
      },
      { revokedAt: now() },
    );
    matchesGolden({ calls: r.calls });
  }, 60_000);

  it('a person sends it back: the next claim reads the reason; agent send-back to an earlier step', async () => {
    const r = await scenario(async (call) => {
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
    matchesGolden(r);
  }, 120_000);

  it('paths: shaping, skip, ask path change, propose step; a legacy item without paths', async () => {
    const r = await scenario(async (call) => {
      // Same updatedAt for both: Timestamp.now() differs by a millisecond between the two seeds,
      // which would decide the hand-out order instead of the id tiebreak. Far future: after the i1 seed.
      const tie = Timestamp.fromMillis(4_000_000_000_000);
      await put({
        [I('u1')]: itemDoc({
          stepId: 'intake',
          status: 'queued',
          shape: null,
          title: 'Fix typo',
          updatedAt: tie,
        }),
        [I('old')]: itemDoc({
          stepId: 'intake',
          status: 'queued',
          title: 'Old item',
          updatedAt: tie,
        }),
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
    matchesGolden(r);
  }, 120_000);

  it('an Inbox-only agent is refused item tools and the removed calendar tools (items fJnu6, OE8Fm)', async () => {
    const r = await scenario(
      async (call) => {
        await call('list_work', {});
        await call('claim', { itemId: 'i1' });
        await call('read_item', { itemId: 'i1' });
        await call('calendar_upsert', {
          member: 'alice',
          events: [
            {
              source: 'google',
              sourceEventId: 'g1',
              title: 'Dentist',
              start: '2030-01-07T09:00:00Z',
              end: '2030-01-07T10:00:00Z',
            },
          ],
        });
        await call('inbox_add', {
          source: 'mail',
          sender: { name: 'Sam Example', handle: 'sam@example.com' },
          text: 'Lunch on Friday?',
          threadRef: 'mail-thread-1',
          receivedAt: '2026-10-28T09:00:00Z',
          member: 'owner',
        });
      },
      { projectIds: [], scope: 'inbox' },
    );
    expect(r.calls.map((c) => (c as { ok: boolean }).ok)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(JSON.stringify(r.calls[0])).toContain('limited to Inbox (scope');
    matchesGolden(r);
  }, 60_000);

  it('wait_for_work returns at once when work waits, and times out when none does', async () => {
    const r = await scenario(async (call) => {
      await call('wait_for_work', { timeoutSeconds: 5 });
      await put({ [I('i1')]: itemDoc({ stepId: 'review', status: 'waiting' }) });
      await call('wait_for_work', { timeoutSeconds: 2 });
    });
    matchesGolden({ calls: r.calls });
  }, 60_000);

  it('the 4th agent send-back holds the item for people', async () => {
    const r = await scenario(async (call) => {
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
    matchesGolden(r);
  }, 60_000);

  it.each([
    ['a project agent', { guardrails: { maxFailedRuns: 5 } }],
    ['an Inbox-only agent (item fJnu6)', { projectIds: [], scope: 'inbox' }],
  ])(
    'hivenod whoami --json shows the agent and its settings: %s',
    async (_, extra) => {
      await reset();
      const { uid, token } = await newAgent(extra);
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
      matchesGolden({ whoami: mask(JSON.parse(res.stdout), uid) });
      expect(res.stdout).not.toContain(token);
    },
    60_000,
  );

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
    // The pairing request is gone, and the saved file alone is enough for the next command.
    expect(await snap(pairingPath(code))).toEqual({});
    const who = spawnSync(BIN, ['whoami', '--json'], {
      encoding: 'utf8',
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
    expect(who.status, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ agentUid: uid, name: 'Writer (laptop)' });
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
