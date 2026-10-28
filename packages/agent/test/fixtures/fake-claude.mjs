#!/usr/bin/env node
/**
 * A stand-in for `claude -p … --output-format stream-json` in tests of `hivenod run`. It talks to the
 * Hivenod MCP server from --mcp-config like Claude Code would (when FAKE_MCP=1), prints stream-json
 * lines with usage like Claude Code 2.1.310, and behaves as FAKE_CLAUDE_MODE says:
 *   done | ask | fail | nofinish | crash | hang | tokens | shape
 * FAKE_CLAUDE_ARGS_FILE: where to write the arguments it got (to check the permission flags).
 *
 * Without -p it plays an interactive session (card OPpbi0MS): it writes a session log and a
 * session state file under CLAUDE_CONFIG_DIR like Claude Code 2.1.310, works through the bridge,
 * and, like a real interactive session, stays open after finish until it is closed (SIGTERM).
 * Modes: done | ask | quit (closed by the person) | perm (a permission prompt nobody answers)
 * | hang | tokens | nolog (no session log) | norc (no Remote Control).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.310 (Claude Code)');
  process.exit(0);
}
const flag = (f) => args[args.indexOf(f) + 1];
if (process.env.FAKE_CLAUDE_ARGS_FILE)
  writeFileSync(
    process.env.FAKE_CLAUDE_ARGS_FILE,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      hasToken: 'HIVENOD_TOKEN' in process.env,
      claudeEnv: Object.keys(process.env).filter((k) => /^CLAUDE(CODE|_CODE_|_PID)/.test(k)),
    }),
  );
const mode = process.env.FAKE_CLAUDE_MODE ?? 'done';
const interactive = !args.includes('-p');
const cfg = JSON.parse(flag('--mcp-config'));
const hive = cfg.mcpServers.hivenod;
const bridge = hive.args[hive.args.indexOf('--bridge') + 1];
const session = '00000000-0000-4000-8000-000000000001';
const model = 'claude-test-1';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let mcp = null;
// Like Claude Code: stopping the CLI also stops its MCP servers.
process.on('SIGTERM', () => {
  Promise.resolve(mcp?.close()).finally(() => process.exit(143));
});
async function call(name, a) {
  if (!mcp) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    mcp = new Client({ name: 'fake-claude', version: '0' });
    await mcp.connect(
      new StdioClientTransport({
        command: hive.command,
        args: hive.args,
        // Only what the config gives (like Claude Code, which adds a minimal default env).
        env: { PATH: process.env.PATH ?? '', ...hive.env },
      }),
    );
  }
  const r = await mcp.callTool({ name, arguments: a });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return JSON.parse(r.content[0].text);
}
const useMcp = process.env.FAKE_MCP === '1';
// Without the MCP server: straight to hivenod run's bridge socket (what the MCP server forwards to).
let sock = null;
let nextId = 1;
const waiting = new Map();
function direct(tool, a) {
  if (!sock) {
    sock = createConnection(bridge);
    createInterface({ input: sock }).on('line', (line) => {
      const r = JSON.parse(line);
      const w = waiting.get(r.id);
      waiting.delete(r.id);
      if (r.ok) w.resolve(r.result);
      else w.reject(new Error(`${tool}: ${r.error}`));
    });
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    sock.write(`${JSON.stringify({ id, tool, args: a })}\n`);
  });
}
async function finish(outcome, summary, question) {
  const fn = useMcp ? call : direct;
  if (question) await fn('ask', { question });
  await fn('finish', { outcome, summary });
}

if (interactive) await playInteractive();

out({ type: 'system', subtype: 'init', session_id: session, model });
const msg = (id, usage, content) =>
  out({ type: 'assistant', session_id: session, message: { id, model, usage, content } });

// tokens mode (a CLI that keeps running) or FAKE_BIG: usage over 500k tokens; Hivenod never stops a run for it.
const big = process.env.FAKE_BIG ? 600_000 : mode === 'tokens' ? 400_000 : 1000;
msg(
  'm1',
  {
    input_tokens: big,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 5000,
    output_tokens: 50,
  },
  [{ type: 'text', text: 'Reading the brief.' }],
);
if (useMcp) {
  const item = await call('read_item', {});
  await call('log', { text: `fake read ${item.title}` });
}
msg(
  'm2',
  {
    input_tokens: big,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 6000,
    output_tokens: 300,
  },
  [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/post.md' } }],
);

const result = (extra = {}) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    result: 'ok',
    modelUsage: {
      [model]: {
        inputTokens: 1000 + big,
        outputTokens: 400,
        cacheReadInputTokens: 11000,
        cacheCreationInputTokens: 200,
      },
    },
    permission_denials: [],
    total_cost_usd: 0.05,
    ...extra,
  });

if (mode === 'hang' || mode === 'tokens') {
  // Keeps running until the wrapper stops it.
  setInterval(() => {}, 1000);
} else {
  if (mode === 'done') await finish('done', 'Drafted the post.');
  // A shaping run (card st5INNZj): skip the draft step.
  if (mode === 'shape')
    await (useMcp ? call : direct)('shape_item', {
      skips: [{ stepId: 'draft', reason: 'Nothing to write' }],
      note: 'tiny fix',
    });
  if (mode === 'ask')
    await finish('needs_answer', 'Half done; need a decision.', 'Annual or monthly first?');
  if (mode === 'fail') await finish('failed', 'The brief is missing the product name.');
  if (mode === 'crash') {
    process.stderr.write('boom: something broke\n');
    await mcp?.close();
    sock?.destroy();
    process.exit(2);
  }
  result(
    mode === 'nofinish'
      ? { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] }
      : {},
  );
  await mcp?.close();
  sock?.destroy();
  process.exit(0);
}

async function playInteractive() {
  const sid = flag('--session-id');
  const config = process.env.CLAUDE_CONFIG_DIR;
  const logDir = join(config, 'projects', '-fake-repo');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(config, 'sessions'), { recursive: true });
  const logFile = join(logDir, `${sid}.jsonl`);
  const entry = (o) => {
    if (mode !== 'nolog') appendFileSync(logFile, `${JSON.stringify({ sessionId: sid, ...o })}\n`);
  };
  const status = (s) =>
    writeFileSync(
      join(config, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: sid, status: s }),
    );
  const assistant = (id, usage) =>
    entry({ parentUuid: null, type: 'assistant', message: { id, model, usage, content: [] } });
  process.on('SIGTERM', () => {
    status('idle');
    process.exit(143);
  });
  status('busy');
  entry({ type: 'mode', mode: 'normal' });
  if (mode !== 'norc')
    entry({
      type: 'bridge-session',
      bridgeSessionId: 'cse_01FakeRemoteSession42',
      lastSequenceNum: 0,
    });
  const big = process.env.FAKE_BIG ? 600_000 : mode === 'tokens' ? 400_000 : 1000;
  // One message logged per content block: the same id twice.
  const u = {
    input_tokens: big,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 5000,
    output_tokens: 50,
  };
  assistant('m1', u);
  assistant('m1', u);
  const forever = () => new Promise(() => setInterval(() => {}, 1000));
  if (mode === 'tokens') assistant('m2', u);
  if (mode === 'hang' || mode === 'tokens') await forever();
  if (mode === 'quit') {
    status('idle');
    process.exit(0);
  }
  if (mode === 'perm') {
    const answer = await direct('permission_wait', { request: 'Bash: git push' });
    writeFileSync(process.env.FAKE_PERM_FILE, JSON.stringify(answer));
  }
  if (mode === 'ask')
    await finish('needs_answer', 'Half done; need a decision.', 'Annual or monthly first?');
  else await finish('done', 'Drafted the post.');
  assistant('m2', { ...u, input_tokens: 10, cache_read_input_tokens: 6000, output_tokens: 300 });
  entry({
    type: 'cost-state',
    totalCostUSD: 0.05,
    modelUsage: {
      [model]: {
        inputTokens: 2000,
        outputTokens: 400,
        cacheReadInputTokens: 11000,
        cacheCreationInputTokens: 200,
        costUSD: 0.05,
      },
    },
  });
  status('idle');
  // An interactive session stays open until it is closed.
  await forever();
}
