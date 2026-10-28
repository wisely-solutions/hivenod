#!/usr/bin/env node
/**
 * A stand-in for `codex exec --json` (codex-cli 0.164.0 event names) in tests of `hivenod run codex`.
 * It reads the Hivenod MCP server from the -c mcp_servers.hivenod.* overrides, prints JSONL like the
 * fixture codex-0.164.0-exec.jsonl, and writes a session file under CODEX_HOME. Modes
 * (FAKE_CLI_MODE): done | fail | nofinish | tokens (big running totals in the session file, then
 * it keeps going until stopped) | turnfail. FAKE_CLI_ARGS_FILE: where to write its arguments.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { hiveTools } from './fake-bridge.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.164.0');
  process.exit(0);
}
if (args[0] === 'exec' && args[1] === '--help') {
  const { readFileSync } = await import('node:fs');
  process.stdout.write(
    readFileSync(new URL('./codex-0.164.0-exec-help.txt', import.meta.url), 'utf8'),
  );
  process.exit(0);
}
if (process.env.FAKE_CLI_ARGS_FILE)
  writeFileSync(
    process.env.FAKE_CLI_ARGS_FILE,
    JSON.stringify({ args, cwd: process.cwd(), hasToken: 'HIVENOD_TOKEN' in process.env }),
  );
const conf = (key) => {
  const c = args.find((a, i) => args[i - 1] === '-c' && a.startsWith(`${key}=`));
  return c === undefined ? undefined : JSON.parse(c.slice(key.length + 1));
};
const hive = {
  command: conf('mcp_servers.hivenod.command'),
  args: conf('mcp_servers.hivenod.args'),
};
const tools = hiveTools(hive);
const mode = process.env.FAKE_CLI_MODE ?? 'done';
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const d = new Date();
const day = join(
  process.env.CODEX_HOME,
  'sessions',
  String(d.getFullYear()),
  String(d.getMonth() + 1).padStart(2, '0'),
  String(d.getDate()).padStart(2, '0'),
);
mkdirSync(day, { recursive: true });
const rollout = join(day, `rollout-2026-10-26T09-00-00-${thread}.jsonl`);
const entry = (type, payload) =>
  appendFileSync(rollout, `${JSON.stringify({ timestamp: d.toISOString(), type, payload })}\n`);

out({ type: 'thread.started', thread_id: thread });
entry('session_meta', { id: thread, cli_version: '0.164.0' });
entry('turn_context', { model: 'gpt-test-codex', approval_policy: 'never' });
out({ type: 'turn.started' });
out({
  type: 'item.started',
  item: {
    id: 'i1',
    type: 'mcp_tool_call',
    server: 'hivenod',
    tool: 'read_item',
    status: 'in_progress',
  },
});
if (process.env.FAKE_MCP === '1') {
  const item = await tools.call('read_item', {});
  await tools.call('log', { text: `fake read ${item.title}` });
}
const big = mode === 'tokens' ? 700_000 : 3000;
entry('event_msg', {
  type: 'token_count',
  info: { total_token_usage: { input_tokens: big, cached_input_tokens: 2000, output_tokens: 100 } },
});
out({
  type: 'item.completed',
  item: { id: 'i2', type: 'agent_message', text: 'Drafted the post.' },
});
if (mode === 'tokens') {
  setInterval(() => {}, 1000);
} else {
  if (mode === 'done') await tools.finish('done', 'Drafted the post.');
  if (mode === 'fail') await tools.finish('failed', 'The brief is missing the product name.');
  if (mode === 'turnfail')
    out({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
  else
    out({
      type: 'turn.completed',
      usage: {
        input_tokens: 5000,
        cached_input_tokens: 3000,
        output_tokens: 250,
        reasoning_output_tokens: 50,
      },
    });
  await tools.close();
  process.exit(mode === 'turnfail' ? 1 : 0);
}
