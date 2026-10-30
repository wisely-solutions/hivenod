/**
 * The Go CLI as an agent, for the black-box tests (item MlWOc3O5NyfZcLgetrVo): `hivenod mcp`
 * over stdio through the MCP SDK client (call), and `hivenod whoami --json`. A tool error throws
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
/** A new agent identity and its agent document. */
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
}

/** A fresh home folder (for a CLI run that must not share the agent's). */
export const freshHome = () => mkdtempSync(join(tmpdir(), 'hivenod-home-'));
