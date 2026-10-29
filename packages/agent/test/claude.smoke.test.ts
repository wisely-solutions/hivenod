/**
 * One real Claude Code run through `hivenod run` on the emulators (card MkUwvyWs). Skipped unless
 * HIVE_SMOKE_CLAUDE=1, because it needs a signed-in `claude` and spends a few cents of model
 * usage (haiku). Run:
 *   HIVE_SMOKE_CLAUDE=1 node scripts/emu-exec.mjs \
 *     "cd packages/agent && npx vitest run -c vitest.integration.config.ts test/claude.smoke.test.ts"
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { paths } from '@hive/shared';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getEnv, I, itemDoc, now, put, useEmulator, W } from '../../shared/rules/harness';
import { HiveClient } from '../src/client';
import { EXIT, Runner } from '../src/runner';

const run = process.env.HIVE_SMOKE_CLAUDE === '1';
if (run) useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const PKG = fileURLToPath(new URL('..', import.meta.url));

describe.skipIf(!run)('hivenod run claude: a real Claude Code run (haiku)', () => {
  it('works an item in a repo and completes it with tokens and model', async () => {
    execFileSync('pnpm', ['build'], { cwd: PKG, stdio: 'ignore' });
    process.env.HIVENOD_PROJECT_ID = 'hive-rules-test';
    process.env.HIVENOD_HOME = mkdtempSync(join(tmpdir(), 'hive-home-'));
    const { uid, token } = await createAgentIdentity(
      { apiKey: 'fake-api-key', projectId: 'hive-rules-test' },
      W,
      { authEmulatorUrl: `http://${AUTH_HOST}` },
    );
    await put({
      [paths.agent(W, uid)]: {
        name: 'Claude smoke',
        color: '#2F5FD0',
        projectIds: ['p1'],
        createdBy: 'owner',
        createdAt: now(),
        revokedAt: null,
        lastSeenAt: null,
        tokenHint: 'a7f3',
        previousAgentUid: null,
        lastEventId: 'seed',
        permissions: ['editFiles'],
      },
      [I('i1')]: itemDoc({
        title: 'Write hello.md',
        summary:
          'Create a file hello.md in the current folder containing exactly one line: Hello from Hivenod. Then attach it to the item and finish.',
      }),
    });
    const repo = mkdtempSync(join(tmpdir(), 'hive-smoke-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const c = await HiveClient.connect({
      token,
      projectId: 'hive-rules-test',
      authEmulator: AUTH_HOST,
    });
    const lines: string[] = [];
    const code = await new Runner({
      client: c,
      hiveCommand: [process.execPath, join(PKG, 'dist/cli.js')],
      cwd: repo,
      model: 'haiku',
      once: true,
      maxRunMinutes: 5,
      terminal: { line: (s) => (lines.push(s), console.log(s)) },
    }).run();
    await c.close();
    expect(code).toBe(EXIT.ok);
    expect(readFileSync(join(repo, 'hello.md'), 'utf8')).toContain('Hello from Hivenod');
    let item: Record<string, unknown> = {};
    const runs: Record<string, unknown>[] = [];
    const atts: Record<string, unknown>[] = [];
    await getEnv().withSecurityRulesDisabled(async (ctx) => {
      item = (await ctx.firestore().doc(I('i1')).get()).data() ?? {};
      (await ctx.firestore().collection(`workspaces/${W}/runs`).get()).forEach((d) =>
        runs.push(d.data()),
      );
      (
        await ctx
          .firestore()
          .collection(`${I('i1')}/attachments`)
          .get()
      ).forEach((d) => atts.push(d.data()));
    });
    console.log('run:', JSON.stringify(runs[0]));
    expect(item).toMatchObject({ stepId: 'review', status: 'waiting' });
    expect(runs[0]).toMatchObject({ status: 'done', agentUid: uid });
    expect(runs[0]!.tokensIn as number).toBeGreaterThan(1000);
    expect(runs[0]!.tokensOut as number).toBeGreaterThan(0);
    expect(String(runs[0]!.model)).toMatch(/haiku/);
    expect(atts.map((a) => a.name)).toContain('hello.md');
    expect(lines.join('\n')).toMatch(/✓ Finished step Draft/);
  }, 300_000);
});
