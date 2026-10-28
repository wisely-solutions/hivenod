/** `hivenod mcp`: an MCP stdio server exposing the agent operations as tools. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  CHANNEL_CLAIM_MESSAGE,
  channelInstructions,
  ChannelSession,
  type ChannelEvent,
  type ChannelOptions,
} from './channel';
import { HiveClient, type ConnectOptions } from './client';
import { HiveError, messageOf } from './errors';
import { quietBloomFilterWarning } from './quietlog';
import { TOOLS, type ToolDef } from './tools';

/**
 * Builds the server. The client connects on the first tool call, so Claude Code can list the
 * tools even before the token works; a bad token then shows up as a clear tool error.
 *
 * With `channel` (card KLCTVnX8) it is also a Claude Code channel: it declares
 * `claude/channel`, connects as soon as the session is initialized and pushes work in (see
 * ./channel.ts). Items arrive claimed, so `claim` and `wait_for_work` are not offered there, and
 * `ask` on the handed-over item holds it for the answer.
 */
export function createMcpServer(
  connect: () => Promise<HiveClient>,
  tools: ToolDef[] = TOOLS,
  opts: { channel?: ChannelOptions } = {},
) {
  const server = new McpServer(
    { name: 'hivenod', version: '0.1.0' },
    opts.channel
      ? {
          capabilities: { experimental: { 'claude/channel': {} } },
          instructions: channelInstructions(opts.channel.maxItems),
        }
      : undefined,
  );
  let client: Promise<HiveClient> | null = null;
  let session: ChannelSession | null = null;
  const list = opts.channel ? channelTools(tools, () => session) : tools;
  for (const def of list) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input },
      async (args: Record<string, unknown>) => {
        try {
          client ??= connect();
          const result = await def.run(await client, args as never);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          if (client) client.catch(() => (client = null)); // retry the sign-in next time
          return { isError: true, content: [{ type: 'text' as const, text: messageOf(e) }] };
        }
      },
    );
  }
  const push = (e: ChannelEvent) =>
    server.server.notification({ method: 'notifications/claude/channel', params: { ...e } });
  let starting: Promise<void> | null = null;
  if (opts.channel) {
    const channel = opts.channel;
    server.server.oninitialized = () => {
      starting = (async () => {
        try {
          client ??= connect();
          const c = await client;
          session = new ChannelSession(c, push, channel);
          await session.start();
        } catch (e) {
          session = null; // never started: its tools pass calls through as without a channel
          if (client) client.catch(() => (client = null));
          await push({
            content: `Hivenod could not start handing work to this session: ${messageOf(e)} Fix it, then restart the session.`,
            meta: { kind: 'info', code: 'setup' },
          }).catch(() => undefined);
        }
      })();
    };
  }
  // The client ended the connection (Claude Code closed the session): offline at once.
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    onclose?.();
    void session?.stop();
  };
  return {
    server,
    /** The channel session once started (tests). */
    channel: () => session,
    started: () => starting ?? Promise.resolve(),
    async close() {
      await session?.stop();
      if (client) await (await client.catch(() => null))?.close();
      await server.close();
    },
  };
}

/** Item tools that act on any item of the agent's projects: holding it is not needed. */
const ANY_ITEM = new Set(['read_item', 'raise_finding']);
/** Not about one item. */
const NO_ITEM = new Set(['list_work', 'wait_for_work', 'claim']);

const ITEM_ID_HELP =
  'Item id (the item_id of the <channel kind="work"> event). May be left out while this session holds one item; required when it holds several.';
const RUN_ID_HELP =
  'Run id (the run_id of the work event). May be left out: the open run of the item is used.';

/**
 * Card cGSENsRF: in a channel session the item tools are per handed-over item. `itemId` (and
 * `runId`) become optional and are filled in from the held items; a call on an item this session
 * does not hold, or one a person stopped, is refused. A session that gets no handovers (busy) or
 * has not started passes calls through as before.
 */
function perItem(t: ToolDef, session: () => ChannelSession | null): ToolDef {
  if (NO_ITEM.has(t.name) || t.name === 'raise_finding') return t;
  const hasItem = 'itemId' in t.input;
  const hasRun = 'runId' in t.input;
  if (!hasItem && !hasRun) return t;
  const input: z.ZodRawShape = {
    ...t.input,
    itemId: z.string().min(1).optional().describe(ITEM_ID_HELP),
    ...(hasRun ? { runId: z.string().min(1).optional().describe(RUN_ID_HELP) } : {}),
  };
  return {
    ...t,
    input,
    run: (c, a, ctx) => {
      const s = session();
      const args = { ...(a as Record<string, unknown>) };
      const itemId = args.itemId as string | undefined;
      const runId = args.runId as string | undefined;
      if (!s || s.busy) {
        if (hasItem && !itemId) throw new HiveError(`${t.name} needs itemId.`);
        if (hasRun && !runId) throw new HiveError(`${t.name} needs runId.`);
      } else if (ANY_ITEM.has(t.name) && itemId) {
        // reading any item of the agent's projects is fine
      } else {
        const h = s.resolve(t.name, { itemId, runId });
        if (hasItem) {
          args.itemId = h.itemId;
          args.project ??= h.projectId;
        }
        if (hasRun) args.runId = h.runId;
      }
      if (!hasItem) delete args.itemId;
      return t.run(c, args as never, ctx);
    },
  };
}

/** The tools of a channel session: no claiming, per-item tools, and `ask` holds the item. */
export function channelTools(tools: ToolDef[], session: () => ChannelSession | null): ToolDef[] {
  return tools
    .filter((t) => t.name !== 'wait_for_work')
    .map((t) => perItem(channelTool(t, session), session));
}

function channelTool(t: ToolDef, session: () => ChannelSession | null): ToolDef {
  if (t.name === 'claim')
    return {
      ...t,
      description: `${t.description} In this session work is handed over already claimed: only claim when this session gets no handovers (another live session holds the agent).`,
      run: (c, a, ctx) => {
        const s = session();
        if (s && !s.busy) throw new HiveError(CHANNEL_CLAIM_MESSAGE);
        return t.run(c, a, ctx);
      },
    } satisfies ToolDef;
  if (t.name === 'ask')
    return {
      ...t,
      description:
        'Ask people a question about the item you hold when you are blocked or unsure. It appears under "Needs you" in Hivenod. On the item handed over to this session, asking also ends your run: the item waits for the answer and comes back to you with it as new work.',
      run: (c, a) => {
        const s = session();
        const args = a as { itemId: string; question: string; project?: string };
        return s
          ? s.askAndHold(args.itemId, args.question, args.project)
          : c.ask(args.itemId, args.question, args.project);
      },
    } satisfies ToolDef;
  return t;
}

export async function runMcp(
  opts: ConnectOptions & { channel?: ChannelOptions } = {},
  transport: Transport = new StdioServerTransport(),
  tools: ToolDef[] = TOOLS,
) {
  quietBloomFilterWarning();
  const { channel, ...connectOpts } = opts;
  const { server, close } = createMcpServer(() => HiveClient.connect(connectOpts), tools, {
    channel,
  });
  await server.connect(transport);
  // A clean end (stdin closed, the transport closed, SIGINT/SIGTERM/SIGHUP) writes offline at once;
  // only a crash is left to the presence timeout. Cap the wait so a hung network cannot keep it up.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const cap = setTimeout(() => process.exit(0), 5_000);
    cap.unref();
    void close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
}

/** The one-item server of `hivenod run`: no client and no credential, every tool is forwarded. */
export async function runBridgedMcp(
  tools: ToolDef[],
  transport: Transport = new StdioServerTransport(),
) {
  const { server, close } = createMcpServer(
    () => Promise.resolve(null as unknown as HiveClient),
    tools,
  );
  await server.connect(transport);
  const stop = () => void close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
}
