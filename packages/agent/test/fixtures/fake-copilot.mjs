#!/usr/bin/env node
/**
 * A stand-in for `copilot -p … --output-format json` (Copilot CLI 1.0.103 shapes) in tests of
 * `hivenod run copilot`. It reads the Hivenod MCP server from --additional-mcp-config, prints JSONL like
 * the fixture copilot-1.0.103-output.jsonl, writes OpenTelemetry lines to
 * COPILOT_OTEL_FILE_EXPORTER_PATH and the usage file to --usage-output-file as it ends. Modes
 * (FAKE_CLI_MODE): done | ask | fail | nofinish | tokens (big running totals, then it keeps going
 * until stopped). FAKE_CLI_ARGS_FILE: where to write its arguments and some of its environment.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { hiveTools } from './fake-bridge.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('GitHub Copilot CLI 1.0.103.');
  process.exit(0);
}
if (args[0] === '--help') {
  process.stdout.write(
    readFileSync(new URL('./copilot-1.0.103-help.txt', import.meta.url), 'utf8'),
  );
  process.exit(0);
}
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.slice(name.length + 3);
};
if (process.env.FAKE_CLI_ARGS_FILE)
  writeFileSync(
    process.env.FAKE_CLI_ARGS_FILE,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      hasToken: 'HIVENOD_TOKEN' in process.env,
      allowAll: process.env.COPILOT_ALLOW_ALL ?? null,
      otel: process.env.COPILOT_OTEL_FILE_EXPORTER_PATH ?? null,
    }),
  );
const hive = JSON.parse(opt('additional-mcp-config')).mcpServers.hivenod;
const tools = hiveTools(hive);
const mode = process.env.FAKE_CLI_MODE ?? 'done';
const session = '7c1f0f7e-2b8a-4c1e-9a55-5b8d7f0e4a21';
const model = 'gpt-test-copilot';
const out = (type, data, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ type, data, timestamp: new Date().toISOString(), ...extra })}\n`,
  );
const otel = (id, input, output, cacheRead) =>
  appendFileSync(
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH,
    `${JSON.stringify({ spanId: id, name: `chat ${model}`, attributes: { 'gen_ai.response.model': model, 'gen_ai.usage.input_tokens': input, 'gen_ai.usage.output_tokens': output, 'gen_ai.usage.cache_read.input_tokens': cacheRead } })}\n`,
  );

out('session.start', { sessionId: session });
out('assistant.message', { messageId: 'm1', content: 'Reading the brief.', toolRequests: [] });
out('tool.execution_start', { toolCallId: 't1', toolName: 'hivenod-read_item', arguments: {} });
if (process.env.FAKE_MCP === '1') {
  const item = await tools.call('read_item', {});
  await tools.call('log', { text: `fake read ${item.title}` });
}
const big = mode === 'tokens' ? 700_000 : 3000;
otel('s1', big, 100, 2000);
if (mode === 'tokens') {
  setInterval(() => {}, 1000);
} else {
  if (mode === 'done') await tools.finish('done', 'Drafted the post.');
  if (mode === 'ask') await tools.finish('needs_answer', 'Half done.', 'Annual or monthly first?');
  if (mode === 'fail') await tools.finish('failed', 'The brief is missing the product name.');
  otel('s2', 2000, 150, 1000);
  out('assistant.message', { messageId: 'm2', content: 'Done.', toolRequests: [] });
  writeFileSync(
    opt('usage-output-file'),
    JSON.stringify({
      totalPremiumRequestCost: 0,
      totalNanoAiu: 1000,
      modelMetrics: {
        [model]: {
          requests: { count: 2, cost: 0 },
          usage: {
            inputTokens: 5000,
            outputTokens: 250,
            cacheReadTokens: 3000,
            cacheWriteTokens: 0,
          },
        },
      },
    }),
  );
  process.stdout.write(
    `${JSON.stringify({ type: 'result', sessionId: session, exitCode: 0, usage: { premiumRequests: 0 } })}\n`,
  );
  await tools.close();
  process.exit(0);
}
