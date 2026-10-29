/**
 * One real interactive Claude Code session through `hivenod run` on the emulators (card OPpbi0MS).
 * Skipped unless HIVE_SMOKE_CLAUDE_INTERACTIVE=1: it needs a signed-in `claude`, a terminal
 * (Claude Code is interactive only on a TTY: run vitest in a pty with --pool=threads, so the
 * session inherits it), a folder Claude already trusts (HIVE_SMOKE_REPO), and spends a few cents
 * (haiku). Remote Control starts if the account has it. Run, in a terminal:
 *   HIVE_SMOKE_CLAUDE_INTERACTIVE=1 HIVE_SMOKE_REPO=/a/trusted/folder node scripts/emu-exec.mjs \
 *     "cd packages/agent && npx vitest run \
 *     -c vitest.integration.config.ts --pool=threads test/claude.interactive.smoke.test.ts"
 * Nobody answers the permission prompt for the shell command in the item: Hivenod denies it after
 * the (shortened) timeout and the item still finishes.
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { paths } from '@hive/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getEnv, I, itemDoc, now, put, useEmulator, W } from '../../shared/rules/harness';
import { HiveClient } from '../src/client';
import { EXIT, Runner } from '../src/runner';

const run = process.env.HIVE_SMOKE_CLAUDE_INTERACTIVE === '1';
if (run) useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const PKG = fileURLToPath(new URL('..', import.meta.url));

describe.skipIf(!run)('hivenod run claude: a real interactive Claude Code session (haiku)', () => {
  it('opens Claude for the item, denies an unanswered prompt, finishes with tokens, model and the Remote Control link', async () => {
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
          'First run the shell command `date > when.txt` with Bash (it may be denied; if so, go on without it). Then create a file hello.md in the current folder containing exactly one line: Hello from Hivenod. Attach hello.md to the item and finish.',
      }),
    });
    const repo = process.env.HIVE_SMOKE_REPO ?? mkdtempSync(join(tmpdir(), 'hive-smoke-repo-'));
    for (const f of ['hello.md', 'when.txt']) rmSync(join(repo, f), { force: true });
    const c = await HiveClient.connect({
      token,
      projectId: 'hive-rules-test',
      authEmulator: AUTH_HOST,
    });
    const lines: string[] = [];
    const runner = new Runner({
      client: c,
      hiveCommand: [process.execPath, join(PKG, 'dist/cli.js')],
      cwd: repo,
      model: 'haiku',
      once: true,
      maxRunMinutes: 8,
      interactive: true,
      permissionTimeoutMs: 20_000,
      terminal: { line: (s) => lines.push(s) },
    });
    const code = await runner.run();
    await c.close();
    console.log(lines.join('\n'));
    expect(code).toBe(EXIT.ok);
    expect(readFileSync(join(repo, 'hello.md'), 'utf8')).toContain('Hello from Hivenod');
    // Nobody answered the prompt for Bash (not on the allow-list): denied.
    expect(existsSync(join(repo, 'when.txt'))).toBe(false);
    let item: Record<string, unknown> = {};
    const runs: { id: string; data: Record<string, unknown> }[] = [];
    const log: string[] = [];
    await getEnv().withSecurityRulesDisabled(async (ctx) => {
      item = (await ctx.firestore().doc(I('i1')).get()).data() ?? {};
      (await ctx.firestore().collection(`workspaces/${W}/runs`).get()).forEach((d) =>
        runs.push({ id: d.id, data: d.data() }),
      );
      (await ctx.firestore().collection(`workspaces/${W}/runs/${runs[0]!.id}/log`).get()).forEach(
        (d) => log.push(String(d.data().text)),
      );
    });
    console.log('run:', JSON.stringify(runs[0]?.data));
    console.log('log:', log.join('\n'));
    expect(item).toMatchObject({ stepId: 'review', status: 'waiting' });
    const r = runs[0]!.data;
    expect(r).toMatchObject({ status: 'done', agentUid: uid });
    expect(r.tokensIn as number).toBeGreaterThan(1000);
    expect(r.tokensOut as number).toBeGreaterThan(0);
    expect(String(r.model)).toMatch(/haiku/);
    expect(log.join('\n')).toMatch(/Waiting for permission: Bash/);
    expect(log.join('\n')).toMatch(/Nobody answered the permission prompt/);
    if (process.env.HIVE_SMOKE_EXPECT_RC === '1')
      expect((r.remote as { url: string }).url).toMatch(/^https:\/\/claude\.ai\/code\/session_/);
  }, 600_000);
});
