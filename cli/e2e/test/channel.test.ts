/**
 * Card KLCTVnX8 (Go-only since item MlWOc3O5NyfZcLgetrVo): `hivenod mcp --channel` (the Go binary)
 * against the emulators and the real rules, through a real MCP client that receives the
 * `notifications/claude/channel` events (what Claude Code gets). Projects were removed (item
 * OE8FmrTaIxFVGcaeGG3N, slice 11): work arrives as Inbox threads only.
 * - the session offers thread tools only; a removed item tool says projects were removed;
 * - presence: online while it runs, offline at once on a clean end, one live session per agent,
 *   a restart on the same machine takes over (item N0biX), a busy one re-checks (item AXVvH);
 * - inbox events: new threads, updates, answers, approved outcomes, plans, caps.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import {
  answerQuestion,
  approveOutcome,
  approvePlan,
  type PlanInput,
  inboxPaths,
  type OutcomeStateOf,
  type ThreadStateOf,
  paths,
} from '@hive/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { as, getEnv, now, put, useEmulator, W } from '../../../packages/shared/rules/harness';
import { GO, goBinary, goEnv } from './gobin';

/** The suites run on the Go binary; without Go they are skipped with a warning. */
const d = GO ? describe : describe.skip;
/** token -> agent uid, for the start-up check of a session. */
const uids = new Map<string, string>();

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };

interface Pushed {
  content: string;
  meta: Record<string, string>;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f()));
});

async function newAgent() {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Builder',
      color: '#2F5FD0',
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: token.slice(-4),
      previousAgentUid: null,
      lastEventId: 'seed',
    },
  });
  uids.set(token, uid);
  return { uid, token };
}

/** A message for inbox_add (work for the session: it comes back as an inbox event). */
const msg = (over: Record<string, unknown> = {}) => ({
  source: 'teams',
  sender: { name: 'Sam Example', handle: 'sam@example.com' },
  text: 'Can we move the review to Thursday?',
  threadRef: 'thread-1',
  receivedAt: '2026-10-28T09:00:00Z',
  ...over,
});

/** A Claude Code stand-in: an MCP client on the channel server, collecting what is pushed. */
async function session(
  token: string,
  maxItems?: number,
  maxInbox?: number,
  extraEnv: Record<string, string> = {},
) {
  const events: Pushed[] = [];
  const client = new Client({ name: 'claude-code', version: '0' });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') events.push(n.params as unknown as Pushed);
  };
  const t0 = Date.now();
  const transport = new StdioClientTransport({
    command: goBinary(),
    args: ['mcp', '--channel', ...(maxItems ? ['--max-items', String(maxItems)] : [])],
    env: goEnv({
      HIVENOD_TOKEN: token,
      HIVENOD_PRESENCE_MS: '1000',
      HIVENOD_INBOX_TICK_MS: '500',
      ...(maxInbox !== undefined ? { HIVENOD_MAX_INBOX: String(maxInbox) } : {}),
      ...extraEnv,
    }),
    stderr: 'inherit',
  });
  await client.connect(transport);
  // Started: presence written, or an info event (busy, setup).
  const uid = uids.get(token)!;
  for (;;) {
    const seen = (await read(paths.agent(W, uid))).lastSeenAt as { toMillis(): number } | undefined;
    if ((seen && seen.toMillis() >= t0 - 1000) || events.some((e) => e.meta.kind === 'info')) break;
    if (Date.now() - t0 > 10_000) throw new Error('the Go channel session did not start in 10 s');
    await new Promise((r) => setTimeout(r, 50));
  }
  const close = async () => {
    const pid = transport.pid ?? null;
    await client.close().catch(() => undefined);
    if (pid) await exited(pid);
  };
  open.push(close);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  /** The n-th event of `kind` (1-based), waiting up to `ms` for it. */
  const next = async (kind: string, n = 1, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const got = events.filter((e) => e.meta.kind === kind);
      if (got.length >= n) return { ...got[n - 1]!, ms: Date.now() - t0 };
      if (Date.now() - t0 > ms)
        throw new Error(`no ${kind} #${n} within ${ms} ms; got ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return {
    events,
    call,
    next,
    close,
    pid: transport.pid,
    /** Sends a signal to this session's own process (by its PID) and waits until it exited. */
    signal: async (sig: NodeJS.Signals) => {
      const pid = transport.pid;
      if (!pid) throw new Error('no pid');
      process.kill(pid, sig);
      await exited(pid);
    },
    disconnect: async () => {
      await client.close();
    },
    listTools: () => client.listTools(),
  };
}

async function read(path: string) {
  let d: Record<string, unknown> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    d = (await c.firestore().doc(path).get()).data() ?? {};
  });
  return d;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits (up to 8 s) until a process has exited. */
async function exited(pid: number) {
  for (const t0 = Date.now(); Date.now() - t0 < 8000;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const inboxEvents = (s: Awaited<ReturnType<typeof session>>) =>
  s.events.filter((e) => e.meta.kind === 'inbox');

d('hivenod mcp --channel', () => {
  it('declares the channel and offers thread tools only (projects removed, slice 11)', async () => {
    const { token } = await newAgent();
    const s = await session(token);
    const names = (await s.listTools()).tools.map((t) => t.name);
    expect(names).toContain('thread_read');
    expect(names).toContain('plan_propose');
    for (const gone of [
      'claim',
      'list_work',
      'read_item',
      'complete',
      'send_back',
      'park',
      'create_item',
    ])
      expect(names).not.toContain(gone);
    await expect(s.call('claim', { itemId: 'x' })).rejects.toThrow(
      /Projects were removed from Hivenod; work arrives as Inbox threads/,
    );
    expect(s.events.filter((e) => e.meta.kind === 'work')).toHaveLength(0);
  });

  it('goes offline at once when the session ends cleanly (client closes the connection)', async () => {
    const { uid, token } = await newAgent();
    const s = await session(token);
    await pause(1500); // presence written
    const before = await read(paths.agent(W, uid));
    expect(before.lastSeenAt).toBeTruthy();
    expect(before.signedOutAt ?? null).toBeNull();
    // Claude Code ends the session: only the connection closes, nobody calls srv.close().
    await s.disconnect();
    const t0 = Date.now();
    for (;;) {
      if ((await read(paths.agent(W, uid))).signedOutAt) break;
      if (Date.now() - t0 > 3000) throw new Error('not offline within 3 s of the session ending');
      await pause(100);
    }
  });

  it('offline, then reconnect: waiting threads arrive; a second session gets no events', async () => {
    const { uid, token } = await newAgent();
    let s = await session(token);
    await s.close();
    expect((await read(paths.agent(W, uid))).signedOutAt).toBeTruthy();
    s = await session(token);
    const tid = (await s.call('inbox_add', msg())).threadId as string;
    expect((await s.next('inbox')).meta.thread_id).toBe(tid);
    // On another machine (item N0biX: the same machine would take over).
    const other = await session(token, undefined, undefined, {
      HIVENOD_HOST_ID: 'other-machine',
    });
    const busy = await other.next('info');
    expect(busy.meta.code).toBe('busy');
    await other.call('inbox_add', msg({ threadRef: 'thread-2', text: 'Not for the second' }));
    await pause(1500);
    expect(inboxEvents(other)).toHaveLength(0);
  });
});

d('hivenod mcp --channel: restarts on the same machine take over (item N0biX)', () => {
  const HOST = { HIVENOD_HOST_ID: 'machine-1' };
  const start = (token: string, env: Record<string, string> = HOST) =>
    session(token, undefined, undefined, env);
  const presence = async (uid: string) => read(paths.agent(W, uid));

  it('kill -9, then a new session on the same machine takes over within 5 s and resends its thread', async () => {
    const { uid, token } = await newAgent();
    const a = await start(token);
    const tid = (await a.call('inbox_add', msg())).threadId as string;
    expect((await a.next('inbox')).meta.thread_id).toBe(tid);
    const seenA = (await presence(uid)).seenSession as string;
    expect(seenA).toMatch(/^[0-9a-f]{24}$/);
    expect((await presence(uid)).seenHostId).toBe('machine-1');
    await a.signal('SIGKILL'); // a crash: no offline stamp
    expect((await presence(uid)).signedOutAt ?? null).toBeNull();
    const t0 = Date.now();
    const b = await start(token);
    const eb = await b.next('inbox', 1, 5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(eb.meta.thread_id).toBe(tid); // the thread still being investigated comes again
    expect(b.events.find((e) => e.meta.code === 'takeover')?.content).toMatch(
      /took over from an earlier session of this agent on this machine/,
    );
    expect(b.events.some((e) => e.meta.code === 'busy')).toBe(false);
    await pause(1500);
    expect((await presence(uid)).seenSession).not.toBe(seenA);
  });

  it('an old session still alive sees the takeover on its heartbeat and stops taking work', async () => {
    const { uid, token } = await newAgent();
    const a = await start(token);
    const b = await start(token);
    let over: Pushed | undefined;
    for (const t0 = Date.now(); !over && Date.now() - t0 < 5000; await pause(50))
      over = a.events.find((e) => e.meta.code === 'taken_over');
    if (!over) throw new Error(`no taken_over info; got ${JSON.stringify(a.events)}`);
    expect(over.content).toMatch(/Another session of this agent took over on this machine/);
    const tid = (await b.call('inbox_add', msg())).threadId as string;
    expect((await b.next('inbox')).meta.thread_id).toBe(tid);
    await pause(1500);
    expect(inboxEvents(a)).toHaveLength(0);
    // The old one ending cleanly does not mark the new one offline.
    await a.signal('SIGTERM');
    const p = await presence(uid);
    expect(p.signedOutAt ?? null).toBeNull();
  });

  it('a clean SIGTERM or SIGINT leaves no live presence: the next session starts with no takeover', async () => {
    const { uid, token } = await newAgent();
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      const a = await start(token, { HIVENOD_HOST_ID: `machine-${sig}` });
      await pause(1200);
      await a.signal(sig);
      const p = await presence(uid);
      const seen = (p.lastSeenAt as { toMillis(): number }).toMillis();
      const out = (p.signedOutAt as { toMillis(): number } | undefined)?.toMillis() ?? 0;
      expect(out).toBeGreaterThanOrEqual(seen);
      // Even from another machine: no "another live session".
      const b = await start(token, { HIVENOD_HOST_ID: `elsewhere-${sig}` });
      const tid = (await b.call('inbox_add', msg({ threadRef: `t-${sig}`, text: `After ${sig}` })))
        .threadId as string;
      expect((await b.next('inbox')).meta.thread_id).toBe(tid);
      expect(b.events.some((e) => e.meta.code === 'busy' || e.meta.code === 'takeover')).toBe(
        false,
      );
      await b.call('outcome_propose', { threadId: tid, type: 'no_reply', fields: {} });
      await b.close();
    }
  });

  it('two machines: the second is still told about the other live session', async () => {
    const { uid, token } = await newAgent();
    const a = await start(token, { HIVENOD_HOST_ID: 'laptop' });
    const b = await start(token, { HIVENOD_HOST_ID: 'desktop' });
    const busy = await b.next('info');
    expect(busy.meta.code).toBe('busy');
    expect(busy.content).toMatch(/already running in another terminal/);
    const tid = (await a.call('inbox_add', msg())).threadId as string;
    expect((await a.next('inbox')).meta.thread_id).toBe(tid);
    await pause(1500);
    expect(inboxEvents(b)).toHaveLength(0);
    expect(a.events.some((e) => e.meta.code === 'taken_over')).toBe(false);
    expect((await presence(uid)).seenHostId).toBe('laptop');
  });
});

d('hivenod mcp --channel: a busy session re-checks and takes over (item AXVvH)', () => {
  it('A live on host 1, B busy on host 2: A stops, B gets the info event and the threads', async () => {
    const { uid, token } = await newAgent();
    const a = await session(token, undefined, undefined, { HIVENOD_HOST_ID: 'host-1' });
    const b = await session(token, undefined, undefined, { HIVENOD_HOST_ID: 'host-2' });
    expect((await b.next('info')).meta.code).toBe('busy');
    // While A is live, B stays busy and never stamps presence.
    await pause(2500);
    expect(b.events.some((e) => e.meta.code === 'takeover')).toBe(false);
    expect((await read(paths.agent(W, uid))).seenHostId).toBe('host-1');
    await a.signal('SIGTERM');
    await b.next('info', 2, 90_000); // busy, then the takeover
    const take = b.events.filter((e) => e.meta.kind === 'info')[1]!;
    expect(take.meta.code).toBe('takeover');
    expect(take.content).toMatch(/The other session of this agent stopped/);
    const tid = (await b.call('inbox_add', msg())).threadId as string;
    expect((await b.next('inbox')).meta.thread_id).toBe(tid);
    expect((await read(paths.agent(W, uid))).seenHostId).toBe('host-2');
  }, 120_000);
});

// ---------- Inbox events (item 4PEHrOW5IfXBQWgOK9wo, part 2) ----------

d('hivenod mcp --channel inbox events (item 4PEHr)', () => {
  const inbox = (s: Awaited<ReturnType<typeof session>>) =>
    s.events.filter((e) => e.meta.kind === 'inbox');
  const thread = async (tid: string) =>
    (await read(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
  const owner = () => as('owner');

  it('arrive within seconds, are never claimed; updates, notes, filing and answers', async () => {
    const { token } = await newAgent();
    const s = await session(token);
    const added = await s.call('inbox_add', msg());
    const tid = added.threadId as string;
    const e1 = await s.next('inbox');
    expect(e1.meta).toMatchObject({
      kind: 'inbox',
      thread_id: tid,
      reason: 'new',
      member: 'owner',
      inbox_cap: '3',
      inbox_active: '1',
    });
    expect(e1.content).not.toMatch(/sub-agent/);
    expect(e1.content).toContain(`thread_read (threadId ${tid})`);
    // A second message on the thread, while it is in flight: an update, not a new start.
    await s.call('inbox_add', msg({ messageId: 'm-2', text: 'Or Friday?' }));
    const e2 = await s.next('inbox', 2);
    expect(e2.meta).toMatchObject({ thread_id: tid, reason: 'message', update: 'true' });
    // Notes and filing are nothing new.
    await s.call('inbox_note', { threadId: tid, text: 'Checked the calendar.' });
    await s.call('subject_assign', { threadId: tid, name: 'Review date' });
    // The question waits for the person; the answer comes back as an event.
    await s.call('inbox_ask', { threadId: tid, question: 'Thursday or Friday?' });
    const o = owner();
    await o.run(
      answerQuestion(o.ctx, { threadId: tid, thread: await thread(tid), answer: 'Thursday' }),
    );
    const e3 = await s.next('inbox', 3);
    expect(e3.meta).toMatchObject({ thread_id: tid, reason: 'answered' });
    expect(e3.content).toContain('Their answer: Thursday');
    await pause(1200);
    expect(inbox(s)).toHaveLength(3);
  });

  it('an approved outcome is sent to the agent that brought the thread in, once', async () => {
    const { token } = await newAgent();
    const s = await session(token, 2);
    const tid = (await s.call('inbox_add', msg())).threadId as string;
    await s.next('inbox');
    const oid = (
      await s.call('outcome_propose', {
        threadId: tid,
        type: 'reply',
        fields: { text: 'Thursday works.' },
      })
    ).outcomeId as string;
    await pause(800);
    expect(inbox(s)).toHaveLength(1); // proposing is not agent work
    const o = owner();
    await o.run(
      approveOutcome(o.ctx, {
        outcomeId: oid,
        outcome: (await read(inboxPaths.outcome(W, oid))) as unknown as OutcomeStateOf,
        thread: await thread(tid),
      }),
    );
    const e = await s.next('inbox', 2);
    expect(e.meta).toMatchObject({
      thread_id: tid,
      reason: 'carry_out',
      outcome_id: oid,
      outcome_type: 'reply',
    });
    expect(e.content).toMatch(/outcome_done/);
    await s.call('outcome_done', {
      outcomeId: oid,
      status: 'done',
      result: { permalink: 'https://teams.example.com/m/9' },
    });
    await pause(1200);
    expect(inbox(s)).toHaveLength(2);
  });

  it('plans (item qwFAW): one carry_out per step, only at its turn, with plan_id and step', async () => {
    const { token } = await newAgent();
    const s = await session(token, 2);
    const tid = (await s.call('inbox_add', msg())).threadId as string;
    await s.next('inbox');
    const p = await s.call('plan_propose', {
      threadId: tid,
      steps: [
        { type: 'reply', fields: { text: 'Thursday works.' } },
        { type: 'approval', fields: { what: 'Move the review' } },
        { type: 'nudge', fields: { text: 'Still on for Thursday?' } },
      ],
    });
    const pid = p.planId as string;
    const [s1, s2, s3] = p.stepIds as string[];
    const planOf = async (): Promise<PlanInput> => {
      const plan = (await read(inboxPaths.plan(W, pid))) as unknown as PlanInput['plan'];
      const outcomes: Record<string, OutcomeStateOf> = {};
      for (const id of plan.steps)
        outcomes[id] = (await read(inboxPaths.outcome(W, id))) as unknown as OutcomeStateOf;
      return { planId: pid, plan, outcomes };
    };
    const o = owner();
    // Approve plan: steps 1 and 3 are approved; only step 1 is its turn.
    await o.run(approvePlan(o.ctx, { ...(await planOf()), thread: await thread(tid) }));
    const e1 = await s.next('inbox', 2);
    expect(e1.meta).toMatchObject({
      thread_id: tid,
      reason: 'carry_out',
      outcome_id: s1,
      plan_id: pid,
      step: '1 of 3',
    });
    await s.call('outcome_done', { outcomeId: s1, status: 'done' });
    // The gate waits for the person: step 3 is not sent.
    await pause(1200);
    expect(inbox(s)).toHaveLength(2);
    const pl = await planOf();
    await o.run(
      approveOutcome(o.ctx, {
        outcomeId: s2!,
        outcome: pl.outcomes[s2!]!,
        thread: await thread(tid),
        plan: pl,
      }),
    );
    const e3 = await s.next('inbox', 3);
    expect(e3.meta).toMatchObject({ reason: 'carry_out', outcome_id: s3, step: '3 of 3' });
    await s.call('outcome_done', { outcomeId: s3, status: 'done' });
    await pause(1200);
    expect(inbox(s)).toHaveLength(3);
  });

  it('at most maxInbox threads at a time; a reconnect or restart sends no duplicates', async () => {
    const { token } = await newAgent();
    const s = await session(token, 1, 2);
    for (const ref of ['r1', 'r2', 'r3'])
      await s.call('inbox_add', msg({ threadRef: ref, text: `Ask ${ref}` }));
    await s.next('inbox', 2);
    await pause(1200);
    expect(inbox(s)).toHaveLength(2);
    expect(inbox(s)[1]!.meta).toMatchObject({ inbox_cap: '2', inbox_active: '2' });
    // One moves on (proposed): the third goes out.
    const first = inbox(s)[0]!.meta.thread_id!;
    await s.call('outcome_propose', { threadId: first, type: 'no_reply', fields: {} });
    await s.next('inbox', 3);
    const sent = inbox(s).map((e) => e.meta.thread_id);
    expect(new Set(sent).size).toBe(3);
    await pause(1500);
    expect(inbox(s)).toHaveLength(3);
    // A new session resends the two still being investigated, once each.
    await s.close();
    const s2 = await session(token, 1, 2);
    await s2.next('inbox', 2);
    await pause(1500);
    const again = inbox(s2);
    expect(again).toHaveLength(2);
    expect(again.map((e) => e.meta.reason)).toEqual(['new', 'new']);
    expect(new Set(again.map((e) => e.meta.thread_id))).toEqual(
      new Set(sent.filter((t) => t !== first)),
    );
  });

  it('max_inbox 0 turns inbox events off', async () => {
    const { token } = await newAgent();
    const s = await session(token, 1, 0);
    await s.call('inbox_add', msg());
    await pause(1500);
    expect(inbox(s)).toHaveLength(0);
  });
});
