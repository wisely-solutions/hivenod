/**
 * The MCP surface of the TypeScript `hivenod mcp`, as JSON: server info, the tools (names,
 * descriptions, input schemas) in plain and channel mode, and the channel instructions per
 * max_items. The Go CLI embeds this file (cli/internal/mcpserver/surface.json), so the
 * TypeScript sources stay the single source of truth; scripts/go-mcp-surface.test.mjs keeps the
 * file current (it lives here so it resolves the MCP SDK). Item zLwtX2WEEg3mER4CR74g.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { channelInstructions, MAX_ITEMS_LIMIT, workText } from './channel';
import type { HiveClient } from './client';
import { inboxText, type InboxEventInfo } from './inboxfeed';
import { createMcpServer } from './mcp';

async function list(channel: boolean, maxItems = 1) {
  const never = () => new Promise<HiveClient>(() => undefined);
  const { server } = createMcpServer(never, undefined, channel ? { channel: { maxItems } } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'surface', version: '0' });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  const out = {
    serverInfo: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions() ?? null,
    tools,
  };
  await client.close();
  await server.close();
  return out;
}

export async function mcpSurface() {
  const plain = await list(false);
  const channel = await list(true, 1);
  const instructions: Record<string, string> = {};
  for (let n = 1; n <= MAX_ITEMS_LIMIT; n++) instructions[String(n)] = channelInstructions(n);
  return {
    serverInfo: plain.serverInfo,
    plain: { capabilities: plain.capabilities, tools: plain.tools },
    channel: { capabilities: channel.capabilities, tools: channel.tools },
    channelInstructions: instructions,
    workText: workTextSamples(),
    inboxText: inboxTextSamples(),
  };
}

/** workText for a spread of rows, arrivals and max_items (the Go port is checked against it). */
function workTextSamples() {
  const long = 'x'.repeat(3100);
  const rows = [
    { itemId: 'i1', title: 'Fix the login', project: 'Blog', step: 'Build', job: null },
    { itemId: 'u1', title: 'New idea', project: 'Blog', step: 'Shaping', job: 'shape' as const },
  ];
  const whys = [
    { why: 'arrived' as const },
    { why: 'sent_back' as const, by: 'Tester', text: 'Fails on Safari' },
    { why: 'sent_back' as const, by: 'Alice', text: long },
    { why: 'answered' as const, by: 'Bob', text: 'Euro', question: 'Which currency?' },
    { why: 'answered' as const, by: 'Bob', text: 'Yes' },
  ];
  const out: {
    row: (typeof rows)[number];
    why: (typeof whys)[number];
    maxItems: number;
    text: string;
  }[] = [];
  for (const row of rows)
    for (const why of whys)
      for (const maxItems of [1, 3])
        out.push({ row, why, maxItems, text: workText(row, why, maxItems) });
  return out;
}

/** inboxText for every reason, long texts and updates (the Go port is checked against it). */
function inboxTextSamples() {
  const long = 'é'.repeat(3100);
  const infos: InboxEventInfo[] = [
    { reason: 'new', threadId: 't1', title: 'Move the review?' },
    { reason: 'new', threadId: 't1', title: '' },
    { reason: 'message', threadId: 't1', title: 'Move the review?' },
    { reason: 'message', threadId: 't1', title: 'Move the review?', update: true },
    { reason: 'answered', threadId: 't1', title: 'T', question: 'Thursday?', answer: 'Yes' },
    { reason: 'answered', threadId: 't1', title: 'T', answer: long, question: long },
    { reason: 'answered', threadId: 't1', title: 'T', answer: '' },
    { reason: 'woke', threadId: 't1', title: 'T' },
    { reason: 'rejected', threadId: 't1', title: 'T', why: 'Too formal' },
    { reason: 'rejected', threadId: 't1', title: 'T' },
    { reason: 'failed', threadId: 't1', title: 'T', why: 'Teams said 403' },
    { reason: 'failed', threadId: 't1', title: 'T' },
    { reason: 'restored', threadId: 't1', title: 'T' },
    { reason: 'resume', threadId: 't1', title: long },
    { reason: 'nudge_due', threadId: 't1', title: 'T', nudgeDays: 3 },
    { reason: 'carry_out', threadId: 't1', outcomeId: 'o1', outcomeType: 'reply' },
    { reason: 'carry_out', threadId: 't1', outcomeId: 'o1', outcomeType: 'reply', update: true },
  ];
  return infos.map((info) => ({ info, text: inboxText(info) }));
}
