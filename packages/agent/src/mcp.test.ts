import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer } from './mcp';
import { TOOLS } from './tools';
import { HiveError } from './errors';
import { damagedMessage } from './credentials';
import { bridgeClient, bridgedTools, bridgePath, serveBridge, type Bridge } from './bridge';
import { runTools, type Finish } from './runtools';

describe('hivenod mcp', () => {
  it('lists the tools with JSON schemas derived from Zod, without needing a token', async () => {
    const { server } = createMcpServer(() => Promise.reject(new Error('no token')));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_note',
      'ask',
      'ask_path_change',
      'attach',
      'calendar_delete',
      'calendar_free',
      'calendar_upsert',
      'claim',
      'complete',
      'create_item',
      'end_run',
      'inbox_add',
      'inbox_ask',
      'inbox_list',
      'inbox_note',
      'list_work',
      'log',
      'outcome_done',
      'outcome_propose',
      'progress',
      'propose_step',
      'raise_finding',
      'read_item',
      'release',
      'report_usage',
      'send_back',
      'shape_item',
      'skip_step',
      'subject_assign',
      'subject_list',
      'subject_relate',
      'subject_search',
      'thread_read',
      'thread_wake',
      'wait_for_work',
    ]);
    const make = tools.find((t) => t.name === 'create_item')!;
    expect(make.inputSchema).toMatchObject({
      required: ['project', 'title'],
      properties: { title: { maxLength: 300 }, attachments: { type: 'array', maxItems: 10 } },
    });
    const back = tools.find((t) => t.name === 'send_back')!;
    expect(back.inputSchema).toMatchObject({
      required: ['itemId', 'runId', 'toStep', 'reason'],
      properties: { reason: { maxLength: 2000 } },
    });
    const usage = tools.find((t) => t.name === 'report_usage')!;
    expect(usage.description).toMatch(/never stops a run/);
    expect(usage.inputSchema).toMatchObject({ required: ['runId', 'tokensIn', 'tokensOut'] });
    const end = tools.find((t) => t.name === 'end_run')!;
    expect(end.description).toMatch(/failed/);
    expect(end.inputSchema).toMatchObject({
      type: 'object',
      required: ['runId', 'status'],
      properties: { status: { enum: ['done', 'failed'] }, costEur: { type: 'number', minimum: 0 } },
    });
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(40);
  });

  it('reports errors as tool errors, not crashes', async () => {
    const { server } = createMcpServer(() => Promise.reject(new Error('HIVENOD_TOKEN is not set')));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'list_work', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('HIVENOD_TOKEN is not set');
  });
});

describe('hivenod mcp --run (one item, used by hivenod run, over the run bridge)', () => {
  const bridges: Bridge[] = [];
  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((b) => b.close()));
  });

  /** The real chain: MCP server (no client, no token) -> bridge socket -> tools in "hivenod run". */
  async function connectRun(
    fake: Partial<Record<string, unknown>> = {},
    opts: { cwd?: string; deny?: (dir: string) => string[]; job?: 'shape' } = {},
  ) {
    const calls: unknown[][] = [];
    const finished: Finish[] = [];
    const client = new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === 'then'
            ? undefined
            : (...args: unknown[]) => {
                calls.push([name, ...args]);
                return Promise.resolve(fake[name] ?? { ok: true });
              },
      },
    );
    const dir = mkdtempSync(join(tmpdir(), 'hivenod-run-'));
    const scope = {
      runId: 'r1',
      itemId: 'i1',
      projectId: 'p1',
      cwd: opts.cwd ?? dir,
      ...(opts.deny ? { deny: opts.deny(dir) } : {}),
      onFinish: (f: Finish) => finished.push(f),
      job: opts.job ?? null,
    };
    const bridge = await serveBridge(bridgePath(dir), runTools(scope), client as never);
    bridges.push(bridge);
    // The MCP side knows nothing of the item: only the schemas and the socket.
    const defs = runTools({ ...scope, itemId: '', projectId: '', onFinish: () => undefined });
    const { server } = createMcpServer(
      () => Promise.resolve(null as never),
      bridgedTools(bridge.path, defs),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return { mcp, calls, finished, bridge, dir };
  }

  it('offers only item tools and finish: no claim, complete, end_run or work list', async () => {
    const { mcp } = await connectRun();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask',
      'ask_path_change',
      'attach',
      'finish',
      'log',
      'progress',
      'propose_step',
      'raise_finding',
      'read_item',
      'skip_step',
    ]);
  });

  it("path tools act on the run's item only (card st5INNZj)", async () => {
    const { mcp, calls } = await connectRun();
    await mcp.callTool({
      name: 'skip_step',
      arguments: { stepId: 'test', skip: true, reason: 'No code' },
    });
    await mcp.callTool({
      name: 'ask_path_change',
      arguments: { stepId: 'release', reason: 'Ships with the next deploy' },
    });
    expect(calls).toEqual([
      ['skipStep', 'i1', 'test', true, 'No code', 'p1'],
      ['askPathChange', 'i1', 'release', 'Ships with the next deploy', 'p1'],
    ]);
    const short = await mcp.callTool({
      name: 'ask_path_change',
      arguments: { stepId: 'release', reason: 'short' },
    });
    expect(short.isError).toBe(true);
  });

  it('a shaping run offers only reading, proposing and shape_item; shape_item ends it', async () => {
    const brief = {
      path: [
        { id: 'intake', kind: 'agent' },
        { id: 'research', kind: 'agent' },
        { id: 'release', kind: 'human' },
      ],
    };
    const { mcp, finished } = await connectRun({ readItem: brief }, { job: 'shape' });
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'finish',
      'log',
      'propose_step',
      'read_item',
      'shape_item',
    ]);
    const bad = await mcp.callTool({
      name: 'shape_item',
      arguments: { skips: [{ stepId: 'nope', reason: 'x' }], note: 'n' },
    });
    expect(bad.isError).toBe(true);
    const all = await mcp.callTool({
      name: 'shape_item',
      arguments: {
        skips: brief.path.map((p) => ({ stepId: p.id, reason: 'x' })),
        note: 'n',
      },
    });
    expect(all.isError).toBe(true);
    await mcp.callTool({
      name: 'shape_item',
      arguments: { skips: [{ stepId: 'research', reason: 'Copy only' }], note: 'copy change' },
    });
    expect(finished).toEqual([
      {
        outcome: 'done',
        summary: 'copy change',
        questionId: null,
        question: null,
        shape: { skips: { research: 'Copy only' }, note: 'copy change' },
      },
    ]);
    const again = await mcp.callTool({ name: 'log', arguments: { text: 'more' } });
    expect(again.isError).toBe(true);
  });

  it('binds every call to the run and item', async () => {
    const { mcp, calls } = await connectRun();
    await mcp.callTool({ name: 'log', arguments: { text: 'hello' } });
    await mcp.callTool({ name: 'read_item', arguments: {} });
    await mcp.callTool({ name: 'progress', arguments: { done: 1, total: 2 } });
    expect(calls).toEqual([
      ['log', 'r1', 'hello', undefined],
      ['readItem', 'i1', 'p1'],
      ['progress', 'i1', 1, 2, 'p1'],
    ]);
  });

  it('finish hands the outcome to the wrapper, once', async () => {
    const { mcp, finished } = await connectRun();
    await mcp.callTool({ name: 'finish', arguments: { outcome: 'done', summary: 'Wrote it' } });
    expect(finished).toEqual([
      { outcome: 'done', summary: 'Wrote it', questionId: null, question: null },
    ]);
    const again = await mcp.callTool({ name: 'log', arguments: { text: 'more' } });
    expect(again.isError).toBe(true);
  });

  it('needs_answer requires a question first and carries its id', async () => {
    const { mcp, finished } = await connectRun({ ask: { messageId: 'm9', note: 'shown' } });
    const early = await mcp.callTool({
      name: 'finish',
      arguments: { outcome: 'needs_answer', summary: 'x' },
    });
    expect(early.isError).toBe(true);
    await mcp.callTool({ name: 'ask', arguments: { question: 'Annual or monthly?' } });
    await mcp.callTool({ name: 'finish', arguments: { outcome: 'needs_answer', summary: 'Half' } });
    expect(finished[0]).toMatchObject({ outcome: 'needs_answer', questionId: 'm9' });
  });

  it('the socket itself gives only those tools, checks input, and never a credential', async () => {
    const { bridge, calls } = await connectRun();
    const raw = bridgeClient(bridge.path);
    try {
      await expect(raw.call('claim', { itemId: 'other' })).rejects.toThrow(/Tool not found/);
      await expect(raw.call('complete', {})).rejects.toThrow(/Tool not found/);
      await expect(raw.call('progress', { done: 'all' })).rejects.toThrow(/Invalid input/);
      expect(calls).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('attach refuses files in the Hivenod credentials folder (relative paths resolve to the CLI folder)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-home-'));
    const before = process.env.HIVENOD_HOME;
    process.env.HIVENOD_HOME = home;
    try {
      const { mcp, calls, dir } = await connectRun();
      const bad = await mcp.callTool({
        name: 'attach',
        arguments: { source: join(home, 'agent.json') },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toMatch(/credentials folder/);
      await mcp.callTool({ name: 'attach', arguments: { source: 'report.html' } });
      expect(calls).toEqual([
        ['attach', 'i1', join(dir, 'report.html'), { name: undefined, projectId: 'p1' }],
      ]);
    } finally {
      process.env.HIVENOD_HOME = before;
    }
  });

  it('attach through the bridge refuses symlinks into the credentials folder and the run folder (R80)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-r80-'));
    const home = join(root, 'home');
    const work = join(root, 'work');
    mkdirSync(home);
    mkdirSync(work);
    writeFileSync(join(home, 'agent.json'), '{"token":"secret"}');
    writeFileSync(join(work, 'report.html'), '<p>ok</p>');
    symlinkSync(join(home, 'agent.json'), join(work, 'decoy.txt'));
    symlinkSync('../home', join(work, 'cfg'));
    const before = process.env.HIVENOD_HOME;
    process.env.HIVENOD_HOME = home;
    try {
      const { mcp, calls, dir } = await connectRun({}, { cwd: work, deny: (d) => [d] });
      writeFileSync(join(dir, 'private.txt'), 'x');
      symlinkSync(join(dir, 'private.txt'), join(work, 'run.txt'));
      for (const source of [
        'decoy.txt',
        'cfg/agent.json',
        join(work, 'cfg', 'agent.json'),
        'run.txt',
      ]) {
        const bad = await mcp.callTool({ name: 'attach', arguments: { source } });
        expect(bad.isError, source).toBe(true);
        // The run folder has its own wording (card JJ6fYb3b), the credentials folder keeps its own.
        expect(JSON.stringify(bad.content)).toMatch(
          source === 'run.txt' ? /run folder/ : /credentials folder/,
        );
      }
      await mcp.callTool({ name: 'attach', arguments: { source: 'report.html' } });
      expect(calls).toEqual([
        [
          'attach',
          'i1',
          join(work, 'report.html'),
          { name: undefined, projectId: 'p1', deny: [dir] },
        ],
      ]);
    } finally {
      process.env.HIVENOD_HOME = before;
    }
  });
});

describe('hivenod mcp --channel with a damaged saved pairing', () => {
  it('sends the damaged message to the session as a setup message', async () => {
    process.env.HIVENOD_HOME = mkdtempSync(join(tmpdir(), 'hive-mcp-damaged-'));
    try {
      const msg = damagedMessage();
      const { server, started } = createMcpServer(
        () => Promise.reject(new HiveError(msg)),
        undefined,
        {
          channel: {},
        },
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '0' });
      const got: { params?: { content?: string; meta?: { code?: string } } }[] = [];
      const { z } = await import('zod');
      client.setNotificationHandler(
        z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }) as never,
        ((n: never) => got.push(n)) as never,
      );
      await Promise.all([server.connect(a), client.connect(b)]);
      await started();
      await new Promise((r) => setTimeout(r, 20));
      expect(got[0]?.params?.meta?.code).toBe('setup');
      expect(got[0]?.params?.content).toContain(msg);
    } finally {
      delete process.env.HIVENOD_HOME;
    }
  });
});

describe('hivenod mcp --channel item tools (card cGSENsRF)', () => {
  it('takes itemId (and runId) as optional, adds itemId to the run tools, and says so', async () => {
    // A client that cannot start the session: tools fall back to needing their ids.
    const { server, started } = createMcpServer(() => Promise.resolve({} as never), [...TOOLS], {
      channel: { maxItems: 3 },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    await started();
    expect(client.getInstructions()).toMatch(/Up to 3 items at a time/);
    const { tools } = await client.listTools();
    const t = (n: string) => tools.find((x) => x.name === n)!.inputSchema;
    expect(t('complete').required ?? []).not.toContain('itemId');
    expect(t('complete').required ?? []).not.toContain('runId');
    expect(t('send_back').required).toEqual(['toStep', 'reason']);
    for (const n of ['log', 'end_run', 'report_usage'])
      expect(Object.keys(t(n).properties ?? {})).toContain('itemId');
    expect(JSON.stringify(t('add_note'))).toMatch(/required when it holds several/);
    // raise_finding is about any item: unchanged.
    expect(t('raise_finding').required).toContain('itemId');
    // Before the session started, a call still needs its ids.
    const res = await client.callTool({ name: 'add_note', arguments: { text: 'x' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('add_note needs itemId');
  });

  it("a one-item channel keeps today's instructions", async () => {
    const { server } = createMcpServer(() => new Promise(() => undefined), undefined, {
      channel: {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getInstructions()).toMatch(/Only one at a time/);
  });
});
