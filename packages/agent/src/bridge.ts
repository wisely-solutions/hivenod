/**
 * The run bridge (card MkUwvyWs, tester finding 7): during `hivenod run` the agent's token stays in
 * the wrapper process. The coding CLI's MCP server (`hivenod mcp --run R --bridge S`) holds no
 * credential at all; it forwards each tool call over a local socket to the wrapper, which runs it
 * with its own client, bound to the one item and run. Whoever reaches the socket (the model
 * included, if it has a shell) gets only those item-scoped tools, which it already has, and never
 * the token.
 *
 * Protocol: one JSON object per line. Request `{ id, tool, args }`, answer
 * `{ id, ok: true, result }` or `{ id, ok: false, error }`.
 */
import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { HiveClient } from './client';
import { HiveError, messageOf } from './errors';
import type { ToolDef } from './tools';

/** A socket path inside the run's private (0700) folder; a named pipe on Windows. */
export function bridgePath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\hivenod-run-${randomBytes(12).toString('hex')}`
    : join(dir, 'bridge.sock');
}

export interface Bridge {
  path: string;
  close(): Promise<void>;
}

/** Serves `tools` on `path`, running them with `client` (in this process). */
export async function serveBridge(
  path: string,
  tools: ToolDef[],
  client: HiveClient,
): Promise<Bridge> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    // A call that waits (the permission hook) ends when its caller is gone.
    const gone = new AbortController();
    sock.on('close', () => {
      sockets.delete(sock);
      gone.abort();
    });
    sock.on('error', () => undefined);
    createInterface({ input: sock }).on('line', (line) => {
      void (async () => {
        let id: unknown = null;
        try {
          const req = JSON.parse(line) as { id?: unknown; tool?: unknown; args?: unknown };
          id = req.id ?? null;
          const def = typeof req.tool === 'string' ? byName.get(req.tool) : undefined;
          if (!def) throw new HiveError(`Tool not found: ${String(req.tool)}`);
          // The socket skips the MCP layer's schema check, so check the input here.
          const args = z.object(def.input).parse(req.args ?? {});
          const result = await def.run(client, args as never, { signal: gone.signal });
          sock.write(`${JSON.stringify({ id, ok: true, result })}\n`);
        } catch (e) {
          const error = e instanceof z.ZodError ? `Invalid input: ${e.message}` : messageOf(e);
          if (!sock.destroyed) sock.write(`${JSON.stringify({ id, ok: false, error })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** One connection to a bridge; `call` sends a tool call and resolves with its result. */
export function bridgeClient(path: string) {
  let sock: Socket | null = null;
  let next = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const failAll = (e: Error) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  const open = () => {
    if (sock && !sock.destroyed) return sock;
    const s = createConnection(path);
    s.on('error', (e) => failAll(new HiveError(`hivenod run is not reachable (${e.message}).`)));
    s.on('close', () => {
      failAll(new HiveError('hivenod run ended this run.'));
      if (sock === s) sock = null;
    });
    createInterface({ input: s }).on('line', (line) => {
      try {
        const r = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
        const w = waiting.get(r.id);
        if (!w) return;
        waiting.delete(r.id);
        if (r.ok) w.resolve(r.result);
        else w.reject(new HiveError(r.error ?? 'The tool failed.'));
      } catch {
        /* ignore a broken line */
      }
    });
    sock = s;
    return s;
  };
  return {
    call(tool: string, args: Record<string, unknown>): Promise<unknown> {
      const s = open();
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        s.write(`${JSON.stringify({ id, tool, args })}\n`);
      });
    },
    close() {
      sock?.destroy();
    },
  };
}

/** The same tools (names, descriptions, schemas), each forwarded over the bridge. */
export function bridgedTools(path: string, defs: ToolDef[]): ToolDef[] {
  const c = bridgeClient(path);
  return defs.map((d) => ({
    ...d,
    run: (_client: HiveClient, args: Record<string, unknown>) => c.call(d.name, args),
  })) as ToolDef[];
}
