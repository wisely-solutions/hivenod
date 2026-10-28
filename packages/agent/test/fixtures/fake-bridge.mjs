/**
 * The Hivenod side of a fake coding CLI in tests: calls the run's tools either through the real
 * one-item MCP server (FAKE_MCP=1, like the real CLI would) or straight over hivenod run's bridge
 * socket (what that server forwards to).
 */
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

export function hiveTools(hive) {
  const bridge = hive.args[hive.args.indexOf('--bridge') + 1];
  let mcp = null;
  let sock = null;
  let nextId = 1;
  const waiting = new Map();
  async function viaMcp(name, a) {
    if (!mcp) {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      mcp = new Client({ name: 'fake-cli', version: '0' });
      await mcp.connect(
        new StdioClientTransport({
          command: hive.command,
          args: hive.args,
          env: { PATH: process.env.PATH ?? '', ...(hive.env ?? {}) },
        }),
      );
    }
    const r = await mcp.callTool({ name, arguments: a });
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
    return JSON.parse(r.content[0].text);
  }
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
  const call = process.env.FAKE_MCP === '1' ? viaMcp : direct;
  return {
    call,
    async finish(outcome, summary, question) {
      if (question) await call('ask', { question });
      await call('finish', { outcome, summary });
    },
    async close() {
      await mcp?.close();
      sock?.destroy();
    },
  };
}
