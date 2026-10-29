/**
 * The Go CLI as an agent, for the black-box tests (item MlWOc3O5NyfZcLgetrVo): `hivenod mcp`
 * over stdio through the MCP SDK client, with one method per tool (the names the old TypeScript
 * client had, so the scenarios read the same), and `hivenod whoami --json`. A tool error throws
 * with the tool's message.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { paths } from '@hive/shared';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnv, now, put, W } from '../../../packages/shared/rules/harness';
import { goBinary, goEnv } from './gobin';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };

type Obj = Record<string, unknown>;
// The results are JSON; the tests read them loosely, as they did the TypeScript client's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
/** A work row (list_work, wait_for_work). */
export interface WorkRow {
  itemId: string;
  [k: string]: Any;
}
/** read_item's result, typed where the tests look inside lists. */
export interface ItemRead {
  path: { id: string }[];
  messages: { kind: string; text: string }[];
  [k: string]: Any;
}

/** A new agent identity and its agent document (projects p1, like the old tests). */
export async function newAgent(
  over: { name?: string; revoked?: boolean; extra?: Obj; docs?: Record<string, Obj> } = {},
) {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: over.name ?? 'Research agent',
      color: '#2F5FD0',
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: over.revoked ? now() : null,
      lastSeenAt: null,
      tokenHint: token.slice(-4),
      previousAgentUid: null,
      lastEventId: 'seed',
      ...over.extra,
    },
    ...over.docs,
  });
  return { uid, token };
}

/** Waits (up to 8 s) until a process has exited. */
export async function exited(pid: number) {
  for (const t0 = Date.now(); Date.now() - t0 < 8000;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** All documents of a collection by id (rules disabled). */
export async function docs(path: string) {
  const out: Record<string, Obj> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    const snap = await c.firestore().collection(path).get();
    snap.forEach((d) => (out[d.id] = d.data()));
  });
  return out;
}

export class GoAgent {
  private constructor(
    readonly uid: string,
    readonly home: string,
    private readonly env: Record<string, string>,
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  /** Starts `hivenod mcp` (or `args`, e.g. `mcp --channel`) for the token, in a fresh home folder. */
  static async start(
    uid: string,
    token: string,
    extraEnv: Record<string, string> = {},
    args = ['mcp'],
  ) {
    const env = goEnv({ HIVENOD_TOKEN: token, ...extraEnv });
    const transport = new StdioClientTransport({
      command: goBinary(),
      args,
      env,
      stderr: 'inherit',
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    return new GoAgent(uid, env.HIVENOD_HOME!, env, client, transport);
  }

  async close() {
    const pid = this.transport.pid;
    await this.client.close().catch(() => undefined);
    if (pid) await exited(pid);
  }

  /** Calls a tool: its JSON result, or throws its error message. */
  async call(name: string, args: Obj = {}): Promise<Any> {
    const r = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: 120_000,
    });
    const text = (r.content as { text: string }[])[0]?.text ?? '';
    if (r.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** `hivenod whoami --json` with the same token and home. */
  whoami(): Any {
    const r = spawnSync(goBinary(), ['whoami', '--json'], { encoding: 'utf8', env: this.env });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  }

  listWork = (): Promise<WorkRow[]> => this.call('list_work');
  waitForWork = ({
    timeoutMs,
  }: {
    timeoutMs: number;
  }): Promise<{ timedOut: boolean; work: WorkRow[] }> =>
    this.call('wait_for_work', { timeoutSeconds: Math.ceil(timeoutMs / 1000) });
  claim = (itemId: string) => this.call('claim', { itemId });
  readItem = (itemId: string): Promise<ItemRead> => this.call('read_item', { itemId });
  log = (runId: string, text: string, level?: string) =>
    this.call('log', { runId, text, ...(level ? { level } : {}) });
  attach = (itemId: string, source: string, o: { name?: string } = {}) =>
    this.call('attach', { itemId, source, ...o });
  ask = (itemId: string, question: string) => this.call('ask', { itemId, question });
  progress = (itemId: string, done: number, total: number) =>
    this.call('progress', { itemId, done, total });
  raiseFinding = (itemId: string, title: string, details: string) =>
    this.call('raise_finding', { itemId, title, details });
  createItem = (project: string, title: string, description?: string, attachments?: string[]) =>
    this.call('create_item', {
      project,
      title,
      ...(description !== undefined ? { description } : {}),
      ...(attachments ? { attachments } : {}),
    });
  reportUsage = (runId: string, u: Obj) => this.call('report_usage', { runId, ...u });
  endRun = (runId: string, status: string, extra: Obj = {}) =>
    this.call('end_run', { runId, status, ...extra });
  complete = (itemId: string, runId: string, extra: Obj = {}) =>
    this.call('complete', { itemId, runId, ...extra });
  release = (itemId: string) => this.call('release', { itemId });
  sendBack = (itemId: string, runId: string, toStep: string, reason: string, extra: Obj = {}) =>
    this.call('send_back', { itemId, runId, toStep, reason, ...extra });
  addNote = (itemId: string, text: string) => this.call('add_note', { itemId, text });
  /** skips: stepId -> reason (the tool takes a list). */
  shape = (itemId: string, runId: string, o: { skips: Record<string, string>; note: string }) =>
    this.call('shape_item', {
      itemId,
      runId,
      note: o.note,
      skips: Object.entries(o.skips).map(([stepId, reason]) => ({ stepId, reason })),
    });
  skipStep = (itemId: string, stepId: string, skip: boolean, reason?: string) =>
    this.call('skip_step', { itemId, stepId, skip, ...(reason ? { reason } : {}) });
  askPathChange = (itemId: string, stepId: string, reason: string) =>
    this.call('ask_path_change', { itemId, stepId, reason });
  proposeStep = (itemId: string, p: Obj) => this.call('propose_step', { itemId, ...p });
}

/** A fresh home folder (for a CLI run that must not share the agent's). */
export const freshHome = () => mkdtempSync(join(tmpdir(), 'hivenod-home-'));
