import { newTokens } from '@hive/shared';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurFromUsd } from './claude';
import { HiveError, REVOKED_MESSAGE, stoppedMessage } from './errors';
import { EXIT, headerLines, Runner, type RunnerClient } from './runner';
import { ADAPTERS } from './clis';

const FAKE = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url));

const row = {
  itemId: 'i1',
  projectId: 'p1',
  project: 'Launch blog',
  title: 'Post 4: pricing explained',
  type: 'idea',
  stepId: 'draft',
  step: 'Draft',
  status: 'queued',
  claim: null,
  progress: null,
  sendBackCount: 0,
};
const brief = {
  itemId: 'i1',
  projectId: 'p1',
  project: 'Launch blog',
  title: 'Post 4: pricing explained',
  type: 'idea',
  summary: 'Explain pricing',
  status: 'working',
  step: {
    id: 'draft',
    name: 'Draft',
    kind: 'agent',
    description: 'Write it',
    instructions: 'Write 600 words',
    outputs: ['post.md'],
  },
  claim: { runId: 'r1', mine: true },
  progress: null,
  costEur: 0,
  sendBackCount: 0,
  sendBackReasons: [],
  decisions: [],
  messages: [],
  attachments: [],
};

function fakeClient(over: Partial<Record<keyof RunnerClient, ReturnType<typeof vi.fn>>> = {}) {
  const c = {
    waitForWork: vi.fn(async () => ({ timedOut: false, work: [row] })),
    claim: vi.fn(async () => ({ runId: 'r1', resumed: false })),
    untrackRun: vi.fn(),
    readItem: vi.fn(async () => brief),
    whoami: vi.fn(() => ({
      agentUid: 'a1',
      name: 'Writer',
      workspaceId: 'w1',
      projectIds: '*',
      paused: false,
      pausedReason: null,
      guardrails: { maxFailedRuns: 3 },
    })),
    refreshAgent: vi.fn(),
    heartbeat: vi.fn(async () => ({})),
    reportUsage: vi.fn(
      async (_r: string, u: { tokensIn: number; tokensOut: number; tokensCached?: number }) => ({
        runId: 'r1',
        newTokens: newTokens(u),
      }),
    ),
    complete: vi.fn(async () => ({
      movedTo: { stepId: 'review', name: 'Review' },
      waitingForPeople: true,
    })),
    releaseRun: vi.fn(async () => ({ status: 'failed', held: false, agentPaused: null })),
    log: vi.fn(async () => ({})),
    ask: vi.fn(async () => ({ messageId: 'q-fake', note: 'Asked.' })),
    progress: vi.fn(async () => ({})),
    attach: vi.fn(async () => ({ name: 'x', kind: 'text' })),
    raiseFinding: vi.fn(async () => ({})),
    checkProject: vi.fn(async (p: string) => p),
    markSeen: vi.fn(async () => undefined),
    markOffline: vi.fn(async () => undefined),
    setRemote: vi.fn(async () => undefined),
    watchRun: vi.fn(() => () => undefined),
    ...over,
  };
  return c;
}

let lines: string[];
let argsFile: string;
beforeEach(() => {
  lines = [];
  argsFile = join(mkdtempSync(join(tmpdir(), 'hive-runner-')), 'args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
});

function runner(client: ReturnType<typeof fakeClient>, extra: Record<string, unknown> = {}) {
  return new Runner({
    client: client as unknown as RunnerClient,
    hiveCommand: [process.execPath, '/x/cli.js'],
    cliCommand: FAKE,
    once: true,
    terminal: { line: (s) => lines.push(s) },
    usageCheckMs: 50,
    heartbeatMs: 100,
    killGraceMs: 200,
    ...extra,
  });
}
const mode = (m: string) => (process.env.FAKE_CLAUDE_MODE = m);
const text = () => lines.join('\n');

describe('hivenod run: one item', () => {
  it('a shaping job: headless with the shaping prompt and tools, ends with the shape (card st5INNZj)', async () => {
    mode('shape');
    const c = fakeClient({
      waitForWork: vi.fn(async () => ({
        timedOut: false,
        work: [{ ...row, stepId: 'intake', step: 'Shaping', job: 'shape' }],
      })),
      readItem: vi.fn(async () => ({
        ...brief,
        job: 'shape',
        path: [
          { id: 'intake', name: 'Intake', kind: 'agent', description: '', state: 'current' },
          { id: 'draft', name: 'Draft', kind: 'agent', description: '', state: 'ahead' },
          { id: 'review', name: 'Review', kind: 'human', description: '', state: 'ahead' },
        ],
      })),
      shape: vi.fn(async () => ({ skipped: ['Draft'], askedToSkip: [], firstStep: 'Intake' })),
    });
    expect(await runner(c, { interactive: true }).run()).toBe(EXIT.ok);
    expect(c.shape).toHaveBeenCalledWith(
      'i1',
      'r1',
      { skips: { draft: 'Nothing to write' }, note: 'tiny fix' },
      expect.objectContaining({ summary: 'tiny fix' }),
      'p1',
    );
    expect(c.complete).not.toHaveBeenCalled();
    expect(text()).toMatch(/Shaped “Post 4: pricing explained”: skips Draft/);
    const args = (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    expect(args.join(' ')).toMatch(/SHAPE one new item/);
    expect(args.join(' ')).toMatch(/--job.{0,4}shape/);
  });

  it('claims, runs the CLI headless, reports tokens and model, completes one step', async () => {
    mode('done');
    const c = fakeClient();
    expect(await runner(c).run()).toBe(EXIT.ok);
    expect(c.claim).toHaveBeenCalledWith('i1', 'p1');
    expect(c.complete).toHaveBeenCalledWith(
      'i1',
      'r1',
      {
        tokensIn: 2000 + 11000 + 200,
        tokensCached: 11000,
        tokensOut: 400,
        model: 'claude-test-1',
        // Claude's own cost (result.total_cost_usd 0.05) in EUR (tester R80: it was always €0).
        costEur: eurFromUsd(0.05),
        summary: 'Drafted the post.',
      },
      'p1',
    );
    expect(c.releaseRun).not.toHaveBeenCalled();
    expect(text()).toContain('▶ New item “Post 4: pricing explained”  (Launch blog · step Draft)');
    expect(text()).toContain('claude ▸ Reading the brief.');
    expect(text()).toContain('claude ▸ Write post.md');
    expect(text()).toMatch(
      /✓ Finished step Draft · 2\.2k tokens in \(\+11k cached\) \/ 400 out · claude-test-1 · €0\.04 · moved to Review \(waiting for people\)/,
    );
  });

  it('gives the CLI the allow-list, only the Hivenod MCP server, and never the token', async () => {
    mode('done');
    process.env.HIVENOD_TOKEN = 'hive_agt_should_not_leak';
    process.env.HIVENOD_HOME = '/home/someone/.hivenod';
    try {
      await runner(fakeClient()).run();
    } finally {
      delete process.env.HIVENOD_TOKEN;
      process.env.HIVENOD_HOME = '/nonexistent/hive-home-for-tests';
    }
    const got = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[]; hasToken: boolean };
    const flag = (f: string) => got.args[got.args.indexOf(f) + 1]!;
    expect(got.hasToken).toBe(false);
    expect(flag('--permission-mode')).toBe('dontAsk');
    // Claude runs with the user's own config: Hivenod only allows its own tools and reading.
    expect(flag('--allowedTools')).toBe('mcp__hivenod__*,Read,Glob,Grep,TodoWrite');
    expect(got.args.join(' ')).not.toContain('hive_agt_');
    const mcp = JSON.parse(flag('--mcp-config')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['hivenod']);
    const hive = mcp.mcpServers.hivenod!;
    expect(hive.args.slice(0, 4)).toEqual(['/x/cli.js', 'mcp', '--run', 'r1']);
    expect(hive.args[4]).toBe('--bridge');
    expect(hive.args[5]).toMatch(/hivenod-run-.*bridge\.sock$/);
    // Tester finding 7: the MCP server gets no credential at all (no token, no token file), so
    // nothing in Claude's arguments leads to the token; the wrapper keeps it in memory.
    expect(hive.env).toEqual({});
    expect(got.args.join(' ')).not.toMatch(/token/i);
    // And Claude's file tools may not read or change Hivenod's saved credentials.
    // The run's private folder (bridge socket) is denied too, not just ~/.hivenod (card JJ6fYb3b).
    const denied = flag('--disallowedTools').split(',');
    expect(denied).toEqual(
      expect.arrayContaining([
        'Read(//home/someone/.hivenod/**)',
        'Edit(//home/someone/.hivenod/**)',
      ]),
    );
    expect(denied.some((d) => /^Read\(\/\/.*hivenod-run-.*\/\*\*\)$/.test(d))).toBe(true);
    expect(denied.some((d) => /^Edit\(\/\/.*hivenod-run-.*\/\*\*\)$/.test(d))).toBe(true);
    expect(denied.some((d) => d === 'Bash' || d === 'Edit' || d === 'Write')).toBe(false);
    expect(got.args[1]).toContain('<item>');
    expect(got.args[1]).toContain('Write 600 words');
  });

  it('YOLO after --: the CLI gets the flag, no forced dontAsk, and every guard stays (card 19u5WLtk)', async () => {
    mode('done');
    process.env.HIVENOD_TOKEN = 'hive_agt_should_not_leak';
    process.env.HIVENOD_HOME = '/home/someone/.hivenod';
    const c = fakeClient();
    try {
      await runner(c, { extraArgs: ['--dangerously-skip-permissions', '--effort', 'high'] }).run();
    } finally {
      delete process.env.HIVENOD_TOKEN;
      process.env.HIVENOD_HOME = '/nonexistent/hive-home-for-tests';
    }
    const got = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[]; hasToken: boolean };
    const flag = (f: string) => got.args[got.args.indexOf(f) + 1]!;
    expect(got.args).toContain('--dangerously-skip-permissions');
    expect(flag('--effort')).toBe('high');
    expect(got.args).not.toContain('--permission-mode');
    expect(got.hasToken).toBe(false);
    expect(got.args.join(' ')).not.toContain('hive_agt_');
    expect(flag('--allowedTools')).toBe('mcp__hivenod__*,Read,Glob,Grep,TodoWrite');
    const denied = flag('--disallowedTools').split(',');
    expect(denied).toEqual(
      expect.arrayContaining([
        'Read(//home/someone/.hivenod/**)',
        'Edit(//home/someone/.hivenod/**)',
      ]),
    );
    // ~/.hivenod, the old ~/.hive (a token saved there still works) and the run folder.
    expect(denied.length).toBe(6);
    expect(denied).toContain(`Read(/${join(homedir(), '.hive')}/**)`);
    // Hivenod's own flags come after the person's, so a repeated flag ends with Hivenod's.
    expect(got.args.indexOf('--effort')).toBeLessThan(got.args.indexOf('--disallowedTools'));
    expect(c.log).toHaveBeenCalledWith(
      'r1',
      'Extra Claude arguments: --dangerously-skip-permissions --effort high',
    );
    // Copyable into a shell: ordinary ASCII hyphens only (no U+2011).
    const line = (c.log as ReturnType<typeof vi.fn>).mock.calls.find((a) =>
      String(a[1]).startsWith('Extra Claude arguments'),
    )?.[1] as string;
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(line).not.toContain('\u2011');
  });

  it('a question releases the item at once, held for the answer', async () => {
    mode('ask');
    const c = fakeClient({ releaseRun: vi.fn(async () => ({ held: true, agentPaused: null })) });
    expect(await runner(c).run()).toBe(EXIT.ok);
    expect(c.releaseRun).toHaveBeenCalledWith('r1', {
      status: 'released',
      holdFor: 'q-fake',
      outcome: expect.objectContaining({ summary: 'Half done; need a decision.' }),
    });
    expect(c.complete).not.toHaveBeenCalled();
    expect(text()).toContain('? Question sent to Hivenod: “Annual or monthly first?” → Needs you');
  });

  it('a failed run gives the item back as failed; the third pauses the agent and stops', async () => {
    mode('fail');
    const c = fakeClient({
      releaseRun: vi.fn(async () => ({
        status: 'failed',
        held: false,
        agentPaused: 'This agent is now paused after 3 failed runs in a row (limit 3).',
      })),
    });
    expect(await runner(c, { once: false }).run()).toBe(EXIT.paused);
    expect(c.releaseRun).toHaveBeenCalledWith('r1', {
      status: 'failed',
      outcome: expect.objectContaining({
        summary: 'The agent could not finish: The brief is missing the product name.',
      }),
    });
    expect(text()).toContain('■ This agent is now paused');
  });

  it('a CLI that ends without finish, or crashes, fails the run with the reason', async () => {
    mode('nofinish');
    const c = fakeClient();
    await runner(c).run();
    expect(c.releaseRun.mock.calls[0]![1]).toMatchObject({
      status: 'failed',
      outcome: { summary: expect.stringMatching(/without calling finish \(denied: \$ git push\)/) },
    });
    mode('crash');
    const d = fakeClient();
    await runner(d).run();
    expect(d.releaseRun.mock.calls[0]![1]).toMatchObject({
      outcome: { summary: expect.stringMatching(/exited with code 2: boom: something broke/) },
    });
  });

  it('stops a run at the time limit', async () => {
    mode('hang');
    const c = fakeClient();
    await runner(c, { maxRunMinutes: 0.01 }).run();
    expect(c.releaseRun.mock.calls[0]![1]).toMatchObject({
      status: 'failed',
      outcome: { summary: expect.stringMatching(/Stopped after 0.01 minutes/) },
    });
  }, 10_000);

  it('never stops a run over tokens: 800k+ new tokens complete normally and are reported', async () => {
    mode('done');
    process.env.FAKE_BIG = '1';
    try {
      const c = fakeClient();
      expect(await runner(c).run()).toBe(EXIT.ok);
      expect(c.releaseRun).not.toHaveBeenCalled();
      expect(c.complete).toHaveBeenCalledWith(
        'i1',
        'r1',
        expect.objectContaining({ tokensIn: expect.any(Number) }),
        'p1',
      );
      const done = c.complete.mock.calls[0]![2] as unknown as {
        tokensIn: number;
        tokensCached: number;
      };
      expect(done.tokensIn - done.tokensCached).toBeGreaterThan(500_000);
      expect(text()).not.toMatch(/limit/i);
    } finally {
      delete process.env.FAKE_BIG;
    }
  }, 10_000);

  it('a revoke stops the CLI at the next heartbeat and ends the session', async () => {
    mode('hang');
    const c = fakeClient({
      heartbeat: vi.fn(async () => {
        throw new HiveError(REVOKED_MESSAGE);
      }),
    });
    expect(await runner(c, { once: false }).run()).toBe(EXIT.revoked);
    expect(text()).toContain('revoked');
  }, 10_000);

  it('Stop work in Hivenod (BrK0r2FE): the live watch ends the CLI within seconds; nothing is written, no failure', async () => {
    mode('hang');
    const summary = 'Stopped by Owner in Hivenod: the item went back on hold. Reason: wrong brief';
    const c = fakeClient({
      watchRun: vi.fn((_runId: string, onStopped: (r: { summary: string }) => void) => {
        const t = setTimeout(() => onStopped({ summary }), 300);
        return () => clearTimeout(t);
      }),
    });
    const started = Date.now();
    expect(await runner(c).run()).toBe(EXIT.ok);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(c.watchRun).toHaveBeenCalledWith('r1', expect.any(Function));
    expect(c.releaseRun).not.toHaveBeenCalled();
    expect(c.complete).not.toHaveBeenCalled();
    expect(text()).toContain(summary);
    expect(text()).toContain('not counted as a failure');
  }, 10_000);

  it('Stop work noticed by a heartbeat when the live watch missed it (offline for a while)', async () => {
    mode('hang');
    const c = fakeClient({
      heartbeat: vi.fn(async () => {
        throw new HiveError(stoppedMessage({ summary: 'Stopped by Owner in Hivenod.' }));
      }),
    });
    expect(await runner(c).run()).toBe(EXIT.ok);
    expect(c.releaseRun).not.toHaveBeenCalled();
    expect(text()).toContain('not counted as a failure');
  }, 10_000);

  it('Stop work racing a finish: the stop wins, no error line', async () => {
    mode('done');
    const c = fakeClient({
      complete: vi.fn(async () => {
        throw new HiveError(stoppedMessage({ summary: 'Stopped by Owner in Hivenod.' }));
      }),
    });
    expect(await runner(c).run()).toBe(EXIT.ok);
    expect(text()).toContain('not counted as a failure');
    expect(text()).not.toContain('Could not report');
    expect(c.releaseRun).not.toHaveBeenCalled();
  }, 10_000);

  it('Ctrl+C stops the CLI and gives the item back', async () => {
    mode('hang');
    const ac = new AbortController();
    const c = fakeClient();
    setTimeout(() => ac.abort(), 300);
    expect(await runner(c, { signal: ac.signal }).run()).toBe(EXIT.interrupted);
    expect(c.releaseRun).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ status: 'released' }),
    );
  }, 10_000);

  it('a missing CLI fails the run with a clear reason', async () => {
    const c = fakeClient();
    await runner(c, { cliCommand: '/nonexistent/claude' }).run();
    expect(c.releaseRun.mock.calls[0]![1]).toMatchObject({
      outcome: { summary: expect.stringMatching(/not found on PATH/) },
    });
  });
});

describe('hivenod run: the loop', () => {
  it('keeps waiting through quiet periods and takes the item it already holds first', async () => {
    mode('done');
    const mine = { ...row, itemId: 'i2', claim: { runId: 'r0', mine: true, stale: false } };
    const c = fakeClient({
      waitForWork: vi
        .fn()
        .mockResolvedValueOnce({ timedOut: true, work: [] })
        .mockResolvedValueOnce({ timedOut: false, work: [row, mine] }),
    });
    await runner(c).run();
    expect(c.waitForWork).toHaveBeenCalledTimes(2);
    expect(c.claim).toHaveBeenCalledWith('i2', 'p1');
  });

  it('keeps retrying with backoff when Firebase answers QUOTA_EXCEEDED, never as a revoked token', async () => {
    mode('done');
    const quota = Object.assign(new Error('QUOTA_EXCEEDED'), { code: 'auth/quota-exceeded' });
    const c = fakeClient({
      waitForWork: vi
        .fn()
        .mockRejectedValueOnce(quota)
        .mockRejectedValueOnce(new HiveError('QUOTA_EXCEEDED : Exceeded quota'))
        .mockResolvedValueOnce({ timedOut: false, work: [row] }),
    });
    expect(await runner(c, { errorRetryMs: 1 }).run()).toBe(EXIT.ok);
    expect(c.waitForWork).toHaveBeenCalledTimes(3);
    expect(text()).toMatch(/Firebase is limiting requests for a moment, retrying/);
    expect(text()).not.toMatch(/revoked|rejected/i);
  });

  it('stops when the agent is revoked or paused while waiting', async () => {
    const r = fakeClient({
      waitForWork: vi.fn(async () => {
        throw new HiveError(REVOKED_MESSAGE);
      }),
    });
    expect(await runner(r, { once: false }).run()).toBe(EXIT.revoked);
    const p = fakeClient({
      waitForWork: vi.fn(async () => {
        throw new HiveError('This agent is paused (3 failed runs). It takes no new work.');
      }),
    });
    expect(await runner(p, { once: false }).run()).toBe(EXIT.paused);
  });

  it('a claim that fails (someone else was faster) is skipped', async () => {
    mode('done');
    const c = fakeClient({
      claim: vi
        .fn()
        .mockRejectedValueOnce(new HiveError('Another agent holds this item right now.'))
        .mockResolvedValueOnce({ runId: 'r1' }),
    });
    await runner(c, { claimRetryMs: 10 }).run();
    expect(text()).toContain('could not claim it: Another agent holds this item');
    expect(c.complete).toHaveBeenCalled();
  }, 10_000);

  it('--project with a project the agent cannot use stops with a clear error, no retries', async () => {
    const c = fakeClient({
      checkProject: vi.fn(async () => {
        throw new HiveError('This agent cannot use the project "nope". Its projects: Launch blog.');
      }),
    });
    expect(await runner(c, { once: false, projectId: 'nope' }).run()).toBe(EXIT.error);
    expect(c.waitForWork).not.toHaveBeenCalled();
    expect(text()).toContain('✗ This agent cannot use the project "nope"');
  });

  it('--project by name waits on that project id', async () => {
    mode('done');
    const c = fakeClient({ checkProject: vi.fn(async () => 'p1') });
    await runner(c, { projectId: 'Launch blog' }).run();
    expect(c.waitForWork).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
  });

  it('shows online while waiting and offline on exit (not after a revoke)', async () => {
    mode('done');
    const c = fakeClient({
      waitForWork: vi
        .fn()
        .mockResolvedValueOnce({ timedOut: true, work: [] })
        .mockResolvedValueOnce({ timedOut: false, work: [row] }),
    });
    expect(await runner(c, { presenceMs: 0 }).run()).toBe(EXIT.ok);
    expect(c.markSeen).toHaveBeenCalledTimes(2);
    expect(c.markOffline).toHaveBeenCalledTimes(1);
    const ac = new AbortController();
    const d = fakeClient({
      waitForWork: vi.fn(async () => {
        ac.abort();
        return { timedOut: true, work: [] };
      }),
    });
    expect(await runner(d, { once: false, signal: ac.signal }).run()).toBe(EXIT.interrupted);
    expect(d.markOffline).toHaveBeenCalled();
    const r = fakeClient({
      waitForWork: vi.fn(async () => {
        throw new HiveError(REVOKED_MESSAGE);
      }),
    });
    expect(await runner(r, { once: false }).run()).toBe(EXIT.revoked);
    expect(r.markOffline).not.toHaveBeenCalled();
  });

  it('prints the header like the draft', () => {
    const l = headerLines(
      {
        agentUid: 'a',
        name: 'Writer (laptop)',
        workspaceId: 'w',
        projectIds: ['p1'],
        paused: false,
        pausedReason: null,
        guardrails: { maxFailedRuns: 3 },
      },
      ['Launch blog', 'Docs'],
      { cli: 'Claude Code', cliVersion: '2.1.310', saved: '/home/x/.hivenod/agent.json' },
    );
    expect(l[0]).toBe(
      'Agent Writer (laptop) · projects: Launch blog, Docs · token saved to /home/x/.hivenod/agent.json',
    );
    expect(l[1]).toBe('✓ Connected. Guardrails: stop after 3 failed runs · cannot decide gates');
    expect(l[2]).toBe(
      '  Claude Code 2.1.310 · Permissions: your Claude Code settings (~/.claude/settings.json)',
    );
    expect(l.join('\n')).not.toMatch(/unattended|allowed|token limit|tokens per item/i);
  });
});

describe('hivenod run: interactive Claude per item (card OPpbi0MS)', () => {
  let config: string;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'hive-claude-config-'));
    process.env.CLAUDE_CONFIG_DIR = config;
  });
  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.FAKE_PERM_FILE;
  });
  const interactive = (c: ReturnType<typeof fakeClient>, extra: Record<string, unknown> = {}) =>
    runner(c, { interactive: true, claudeConfigDir: config, closeGraceMs: 3000, ...extra });

  it('opens an interactive session with Remote Control, records the link, reads tokens from the session log, closes it when finished', async () => {
    mode('done');
    process.env.HIVENOD_TOKEN = 'hive_agt_should_not_leak';
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    process.env.HIVENOD_HOME = '/home/someone/.hivenod';
    const c = fakeClient();
    let code: number;
    try {
      code = await interactive(c).run();
    } finally {
      delete process.env.HIVENOD_TOKEN;
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_CHILD_SESSION;
      process.env.HIVENOD_HOME = '/nonexistent/hive-home-for-tests';
    }
    expect(code).toBe(EXIT.ok);
    const got = JSON.parse(readFileSync(argsFile, 'utf8')) as {
      args: string[];
      hasToken: boolean;
      claudeEnv: string[];
    };
    const flag = (f: string) => got.args[got.args.indexOf(f) + 1]!;
    expect(got.args).not.toContain('-p');
    expect(got.args[0]).toContain('<item>');
    expect(got.args[0]).toContain('Write 600 words');
    expect(flag('--append-system-prompt')).toContain('Remote Control');
    expect(flag('--remote-control')).toBe('Hivenod: Post 4: pricing explained');
    expect(flag('--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    // The person's own default mode and allow rules apply: Hivenod forces no permission mode.
    expect(got.args).not.toContain('--permission-mode');
    expect(flag('--allowedTools')).toBe('mcp__hivenod__*,Read,Glob,Grep,TodoWrite');
    expect(got.args).not.toContain('--strict-mcp-config');
    const settings = JSON.parse(flag('--settings')) as {
      hooks: { PermissionRequest: { hooks: { command: string; timeout: number }[] }[] };
    };
    const hook = settings.hooks.PermissionRequest[0]!.hooks[0]!;
    expect(hook.command).toMatch(/^exec .* \/x\/cli\.js hook permission --bridge .*bridge\.sock$/);
    expect(hook.timeout).toBe(660);
    const deniedPaths = flag('--disallowedTools').split(',');
    expect(deniedPaths.slice(0, 2)).toEqual([
      'Read(//home/someone/.hivenod/**)',
      'Edit(//home/someone/.hivenod/**)',
    ]);
    expect(deniedPaths.length).toBe(6); // ~/.hivenod, the old ~/.hive and the run folder, nothing else
    expect(deniedPaths.slice(2, 4)).toEqual([
      `Read(/${join(homedir(), '.hive')}/**)`,
      `Edit(/${join(homedir(), '.hive')}/**)`,
    ]);
    expect(deniedPaths.slice(4).every((d) => /hivenod-run-/.test(d))).toBe(true);
    // The token never reaches Claude, and it is its own top-level session (it saves its log).
    expect(got.hasToken).toBe(false);
    expect(got.args.join(' ')).not.toContain('hive_agt_');
    expect(got.claudeEnv).toEqual([]);
    expect(c.setRemote).toHaveBeenCalledWith('r1', {
      url: 'https://claude.ai/code/session_01FakeRemoteSession42',
      sessionId: flag('--session-id'),
    });
    expect(c.complete).toHaveBeenCalledWith(
      'i1',
      'r1',
      {
        tokensIn: 2000 + 11000 + 200,
        tokensCached: 11000,
        tokensOut: 400,
        model: 'claude-test-1',
        costEur: eurFromUsd(0.05),
        summary: 'Drafted the post.',
      },
      'p1',
    );
    expect(text()).toContain('Opening Claude Code for this item');
    expect(text()).toContain(
      'Remote Control: https://claude.ai/code/session_01FakeRemoteSession42',
    );
    expect(text()).toMatch(/✓ Finished step Draft · .* · claude-test-1 · €0\.04 · moved to Review/);
  });

  it('interactive with extra arguments: passed after the prompt, guards and settings intact (card 19u5WLtk)', async () => {
    mode('done');
    process.env.HIVENOD_TOKEN = 'hive_agt_should_not_leak';
    process.env.HIVENOD_HOME = '/home/someone/.hivenod';
    try {
      await interactive(fakeClient(), {
        extraArgs: ['--dangerously-skip-permissions', '--model', 'opus'],
      }).run();
    } finally {
      delete process.env.HIVENOD_TOKEN;
      process.env.HIVENOD_HOME = '/nonexistent/hive-home-for-tests';
    }
    const got = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[]; hasToken: boolean };
    const flag = (f: string) => got.args[got.args.indexOf(f) + 1]!;
    expect(got.args[0]).toContain('<item>');
    expect(got.args.slice(1, 4)).toEqual(['--dangerously-skip-permissions', '--model', 'opus']);
    expect(got.args).not.toContain('--permission-mode');
    expect(flag('--disallowedTools').split(',').length).toBe(6);
    expect(flag('--settings')).toContain('PermissionRequest');
    expect(got.hasToken).toBe(false);
  });
  it('--clean loads only the Hivenod MCP server', async () => {
    mode('done');
    await interactive(fakeClient(), { clean: true }).run();
    const got = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] };
    expect(got.args).toContain('--strict-mcp-config');
  });

  it('reports running tokens from the session log; a big session is never stopped', async () => {
    mode('done');
    process.env.FAKE_BIG = '1';
    try {
      const c = fakeClient();
      expect(await interactive(c).run()).toBe(EXIT.ok);
      expect(c.complete).toHaveBeenCalled();
      expect(text()).not.toMatch(/limit/i);
    } finally {
      delete process.env.FAKE_BIG;
    }
  });

  it('a permission prompt nobody answers is denied after the timeout, and the run goes on', async () => {
    mode('perm');
    const permFile = join(config, 'perm.json');
    process.env.FAKE_PERM_FILE = permFile;
    const c = fakeClient();
    expect(await interactive(c, { permissionTimeoutMs: 100 }).run()).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(permFile, 'utf8'))).toMatchObject({ behavior: 'deny' });
    const logged = c.log.mock.calls.map((a) => String(a[1])).join('\n');
    expect(logged).toContain('Waiting for permission: Bash: git push');
    expect(logged).toContain('Nobody answered the permission prompt within 0 minutes: denied');
    expect(c.complete).toHaveBeenCalled();
  });

  it('closing Claude before the item is finished gives the item back and stops the session', async () => {
    mode('quit');
    const c = fakeClient({ releaseRun: vi.fn(async () => ({ held: false, agentPaused: null })) });
    expect(await interactive(c, { once: false }).run()).toBe(EXIT.ok);
    expect(c.releaseRun).toHaveBeenCalledWith('r1', {
      status: 'released',
      outcome: expect.objectContaining({
        summary: 'Claude was closed at the terminal before the item was finished.',
      }),
    });
    expect(text()).toContain('The item is back in the queue');
  });

  it('a question releases the item, held for the answer, and closes the session', async () => {
    mode('ask');
    const c = fakeClient({ releaseRun: vi.fn(async () => ({ held: true, agentPaused: null })) });
    expect(await interactive(c).run()).toBe(EXIT.ok);
    expect(c.releaseRun).toHaveBeenCalledWith('r1', {
      status: 'released',
      holdFor: 'q-fake',
      outcome: expect.objectContaining({ summary: 'Half done; need a decision.' }),
    });
  });

  it('the time limit, revoke and Ctrl+C-free stop still apply', async () => {
    mode('hang');
    const timedOut = fakeClient();
    expect(await interactive(timedOut, { maxRunMinutes: 0.002 }).run()).toBe(EXIT.ok);
    expect(timedOut.releaseRun).toHaveBeenCalledWith('r1', {
      status: 'failed',
      outcome: expect.objectContaining({ summary: expect.stringContaining('Stopped after') }),
    });
    const revoked = fakeClient({
      heartbeat: vi.fn(async () => {
        throw new HiveError(REVOKED_MESSAGE);
      }),
      reportUsage: vi.fn(async () => {
        throw new HiveError(REVOKED_MESSAGE);
      }),
    });
    expect(await interactive(revoked).run()).toBe(EXIT.revoked);
    // Stop work in Hivenod closes the interactive session too (card BrK0r2FE).
    const stopped = fakeClient({
      watchRun: vi.fn((_r: string, onStopped: (r: { summary: string }) => void) => {
        const t = setTimeout(() => onStopped({ summary: 'Stopped by Owner in Hivenod.' }), 300);
        return () => clearTimeout(t);
      }),
    });
    expect(await interactive(stopped).run()).toBe(EXIT.ok);
    expect(stopped.releaseRun).not.toHaveBeenCalled();
  });

  it('fails soft without a session log or Remote Control: tokens unknown, a note in the run', async () => {
    mode('nolog');
    const c = fakeClient();
    expect(await interactive(c, { remoteWaitMs: 50 }).run()).toBe(EXIT.ok);
    expect(c.complete).toHaveBeenCalledWith(
      'i1',
      'r1',
      expect.objectContaining({ tokensIn: 0, model: 'unknown' }),
      'p1',
    );
    const logged = c.log.mock.calls.map((a) => String(a[1])).join('\n');
    expect(logged).toContain("Could not read Claude's session log");
    expect(logged).toContain('Remote Control did not start');
    expect(c.setRemote).not.toHaveBeenCalled();
  });
});

describe('hivenod run codex / copilot (card 3RiuFK00, EXPERIMENTAL; fake CLIs)', () => {
  const FAKES = {
    codex: fileURLToPath(new URL('../test/fixtures/fake-codex.mjs', import.meta.url)),
    copilot: fileURLToPath(new URL('../test/fixtures/fake-copilot.mjs', import.meta.url)),
  } as const;
  let cliArgs: string;
  beforeEach(() => {
    cliArgs = join(mkdtempSync(join(tmpdir(), 'hive-cli-')), 'args.json');
    process.env.FAKE_CLI_ARGS_FILE = cliArgs;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-home-'));
  });
  afterEach(() => {
    delete process.env.FAKE_CLI_MODE;
    delete process.env.FAKE_CLI_ARGS_FILE;
    delete process.env.CODEX_HOME;
  });
  const on = (cli: 'codex' | 'copilot', c: ReturnType<typeof fakeClient>, extra = {}) =>
    runner(c, { adapter: ADAPTERS[cli], cliCommand: FAKES[cli], ...extra });
  const cliMode = (m: string) => (process.env.FAKE_CLI_MODE = m);

  it('codex: runs headless even in a terminal, completes with tokens and the model from its files', async () => {
    cliMode('done');
    const c = fakeClient();
    expect(await on('codex', c, { interactive: true }).run()).toBe(EXIT.ok);
    expect(c.complete).toHaveBeenCalledWith(
      'i1',
      'r1',
      {
        tokensIn: 5000,
        tokensCached: 3000,
        tokensOut: 250,
        model: 'gpt-test-codex',
        costEur: 0,
        summary: 'Drafted the post.',
      },
      'p1',
    );
    expect(text()).toContain('codex ▸ hivenod read_item');
    expect(text()).toContain('codex ▸ Drafted the post.');
    const got = JSON.parse(readFileSync(cliArgs, 'utf8')) as { args: string[]; hasToken: boolean };
    expect(got.args[0]).toBe('exec');
    expect(got.hasToken).toBe(false);
    expect(got.args).toContain('workspace-write'); // editFiles
  });

  it('codex: a failed turn without finish fails the run with its message', async () => {
    cliMode('turnfail');
    const c = fakeClient();
    await on('codex', c).run();
    expect(c.releaseRun.mock.calls[0]![1]).toMatchObject({
      status: 'failed',
      outcome: { summary: expect.stringMatching(/stopped with an error: stream disconnected/) },
    });
  });

  it('codex: running totals are reported while it runs (from its session file); no token limit', async () => {
    cliMode('tokens');
    const c = fakeClient();
    // It keeps running; only the time limit ends it, never the tokens.
    await on('codex', c, { maxRunMinutes: 0.03 }).run();
    expect(c.reportUsage).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ tokensIn: 700_000, model: 'gpt-test-codex' }),
    );
    expect(text()).not.toMatch(/Token limit/);
    expect(text()).toMatch(/Stopped after 0.03 minutes/);
  }, 10_000);

  it('copilot: completes with tokens from its usage file; allow-list as rules; never allow-all', async () => {
    cliMode('done');
    process.env.COPILOT_ALLOW_ALL = 'true';
    process.env.HIVENOD_TOKEN = 'hive_agt_should_not_leak';
    const c = fakeClient();
    try {
      expect(await on('copilot', c).run()).toBe(EXIT.ok);
    } finally {
      delete process.env.COPILOT_ALLOW_ALL;
      delete process.env.HIVENOD_TOKEN;
    }
    expect(c.complete).toHaveBeenCalledWith(
      'i1',
      'r1',
      expect.objectContaining({
        tokensIn: 5000,
        tokensCached: 3000,
        tokensOut: 250,
        model: 'gpt-test-copilot',
        summary: 'Drafted the post.',
      }),
      'p1',
    );
    const got = JSON.parse(readFileSync(cliArgs, 'utf8')) as {
      args: string[];
      hasToken: boolean;
      allowAll: string | null;
      otel: string | null;
    };
    expect(got.hasToken).toBe(false);
    expect(got.allowAll).toBeNull();
    expect(got.otel).toMatch(/hivenod-run-.*copilot-otel\.jsonl$/);
    expect(got.args).toContain('--allow-tool=write');
    // Hivenod's fixed defaults (edit files, run tests, git commit) include shell rules.
    expect(got.args).not.toContain('--deny-tool=shell');
    expect(got.args.join(' ')).not.toContain('hive_agt_');
    expect(text()).toContain('copilot ▸ hivenod read_item');
  });

  it('copilot: a question releases the item, held for the answer', async () => {
    cliMode('ask');
    const c = fakeClient({ releaseRun: vi.fn(async () => ({ held: true, agentPaused: null })) });
    await on('copilot', c).run();
    expect(c.releaseRun).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ status: 'released', holdFor: 'q-fake' }),
    );
  });

  it('copilot: running totals are reported while it runs (from OpenTelemetry); no token limit', async () => {
    cliMode('tokens');
    const c = fakeClient();
    // It keeps running; only the time limit ends it, never the tokens.
    await on('copilot', c, { maxRunMinutes: 0.03 }).run();
    expect(c.reportUsage).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ tokensIn: 700_000, model: 'gpt-test-copilot' }),
    );
    expect(text()).not.toMatch(/Token limit/);
    expect(text()).toMatch(/Stopped after 0.03 minutes/);
  }, 10_000);

  it('with a bypass flag the header prints only the permissions line (no headless or prompt line)', () => {
    const me = (fakeClient().whoami as unknown as () => unknown)();
    for (const mode of ['headless', 'interactive'] as const) {
      const l = headerLines(me as never, ['Blog'], {
        cli: 'Claude Code',
        cliVersion: '2.1.310',
        mode,
        bypass: true,
        headlessLine: ADAPTERS.claude.headlessLine,
        permissionsLine: "Permissions: bypass (your flags). Hivenod's own guards stay on.",
      }).join('\n');
      expect(l).toContain('Permissions: bypass (your flags)');
      expect(l).not.toMatch(/Headless|unattended|permission prompts follow|denied after/);
    }
  });

  it('the header says which CLI runs and that it is experimental', () => {
    const me = (fakeClient().whoami as unknown as () => unknown)();
    const a = ADAPTERS.copilot;
    const l = headerLines(me as never, ['Blog'], {
      cli: a.name,
      cliVersion: '1.0.103',
      mode: 'headless',
      headlessLine: a.headlessLine,
      notes: a.notes,
    }).join('\n');
    expect(l).toContain('GitHub Copilot CLI 1.0.103');
    expect(l).toContain('Copilot runs unattended');
    expect(l).toContain('EXPERIMENTAL, untested');
    expect(l).toContain('AI Credits');
  });
});
