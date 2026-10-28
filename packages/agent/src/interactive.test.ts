import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  childEnv,
  describeRequest,
  hookDecision,
  interactiveArgs,
  remoteUrl,
  SessionLog,
  sessionSettings,
  sessionStatus,
  shellQuote,
} from './interactive';

const FIXTURE = fileURLToPath(
  new URL('../test/fixtures/claude-2.1.310-session.jsonl', import.meta.url),
);
const SID = '09817820-8d33-4efd-9b86-5272eb25da0d';

function configWithLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-claude-config-'));
  mkdirSync(join(dir, 'projects', '-home-me-repo'), { recursive: true });
  return dir;
}

describe('interactive Claude: command line', () => {
  const spec = {
    prompt: 'Work on this Hivenod item\n<item>…</item>',
    rules: 'Rules',
    sessionId: SID,
    mcpConfig: '{"mcpServers":{}}',
    hookCommand: "/usr/bin/node /opt/hive/cli.js hook permission --bridge '/tmp/a b/bridge.sock'",
    hookTimeoutSec: 660,
    name: 'Hivenod: Post 4',
    deniedPaths: ['/home/me/.hivenod'],
  };

  it('puts the prompt first (the option lists would swallow it), session id, Remote Control', () => {
    const a = interactiveArgs(spec);
    const flag = (f: string) => a[a.indexOf(f) + 1];
    expect(a[0]).toBe(spec.prompt);
    expect(a).not.toContain('-p');
    expect(flag('--session-id')).toBe(SID);
    expect(flag('--remote-control')).toBe('Hivenod: Post 4');
    expect(flag('--append-system-prompt')).toBe('Rules');
    // The person's own Claude Code config rules: no permission mode forced, only Hivenod's own
    // tools and reading allowed up front (card rifzGl8M).
    expect(a).not.toContain('--permission-mode');
    expect(flag('--allowedTools')).toBe('mcp__hivenod__*,Read,Glob,Grep,TodoWrite');
    // Only Hivenod's own folders are denied.
    expect(flag('--disallowedTools')!.split(',')).toEqual([
      'Read(//home/me/.hivenod/**)',
      'Edit(//home/me/.hivenod/**)',
    ]);
    // The person's own arguments (card 19u5WLtk) follow the prompt, ahead of Hivenod's flags.
    const x = interactiveArgs({ ...spec, extraArgs: ['--dangerously-skip-permissions'] });
    expect(x.slice(0, 2)).toEqual([spec.prompt, '--dangerously-skip-permissions']);
    expect(x[x.indexOf('--disallowedTools') + 1]).toContain('Read(//home/me/.hivenod/**)');
    expect(x).not.toContain('--permission-mode');
    // The person's own MCP servers load, unless --clean.
    expect(a).not.toContain('--strict-mcp-config');
    expect(interactiveArgs({ ...spec, clean: true })).toContain('--strict-mcp-config');
  });

  it("passes the permission hook and turns auto mode off (the person's other settings rule)", () => {
    const s = JSON.parse(sessionSettings('hook-cmd', 660)) as Record<string, unknown>;
    expect(s).toEqual({
      // Claude's prompt offers "switch to auto mode", which would skip the allow-list.
      permissions: { disableAutoMode: 'disable' },
      hooks: {
        PermissionRequest: [
          { matcher: '', hooks: [{ type: 'command', command: 'hook-cmd', timeout: 660 }] },
        ],
      },
    });
  });

  it('quotes the hook command for the shell', () => {
    expect(shellQuote(['/usr/bin/node', '/a b/cli.js', "it's"])).toBe(
      `/usr/bin/node '/a b/cli.js' 'it'\\''s'`,
    );
  });

  it('gives Claude no token and no parent-session markers', () => {
    const env = childEnv({
      PATH: '/bin',
      HIVENOD_TOKEN: 'hive_agt_x',
      HIVENOD_TOKEN_FILE: '/x',
      HIVE_TOKEN: 'hive_agt_old',
      HIVE_TOKEN_FILE: '/old',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_PID: '1',
      CLAUDE_CONFIG_DIR: '/c',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1' });
  });
});

describe('interactive Claude: Remote Control link', () => {
  it('turns the bridge session id into the claude.ai/code link', () => {
    expect(remoteUrl('cse_0182WrAGXy2pVKtBowTsTfYe')).toBe(
      'https://claude.ai/code/session_0182WrAGXy2pVKtBowTsTfYe',
    );
    expect(remoteUrl('session_01F2Qyv1jPsSpLqBhTWsANu2')).toBe(
      'https://claude.ai/code/session_01F2Qyv1jPsSpLqBhTWsANu2',
    );
    expect(remoteUrl('javascript:alert(1)')).toBeNull();
    expect(remoteUrl('cse_../../x')).toBeNull();
  });
});

describe('interactive Claude: the session log (Claude Code 2.1.310)', () => {
  it('reads tokens, model, cost and the Remote Control session from a real log', () => {
    const dir = configWithLog();
    copyFileSync(FIXTURE, join(dir, 'projects', '-home-me-repo', `${SID}.jsonl`));
    const log = new SessionLog(SID, dir);
    log.poll();
    expect(log.readable).toBe(true);
    expect(log.bridgeSessionId).toBe('cse_0182WrAGXy2pVKtBowTsTfYe');
    // Claude's own totals (cost-state), which include its side calls.
    expect(log.usage()).toEqual({
      tokensIn: 2872 + 115990 + 14134,
      tokensOut: 869,
      tokensCached: 115990,
      model: 'claude-haiku-5-5',
      costUsd: 0.004708400000000001,
    });
  });

  it('counts each message once while running, and reads only what was added', () => {
    const dir = configWithLog();
    const p = join(dir, 'projects', '-home-me-repo', `${SID}.jsonl`);
    const msg = (id: string, out: number) =>
      `${JSON.stringify({
        parentUuid: null,
        type: 'assistant',
        sessionId: SID,
        message: {
          id,
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
            output_tokens: out,
          },
        },
      })}\n`;
    writeFileSync(p, msg('m1', 5) + msg('m1', 5));
    const log = new SessionLog(SID, dir);
    log.poll();
    expect(log.usage()).toMatchObject({
      tokensIn: 1110,
      tokensCached: 1000,
      tokensOut: 5,
      model: 'claude-opus-5-5',
    });
    expect(log.usage().costUsd).toBeGreaterThan(0);
    // Half a line is kept until the rest arrives.
    const next = msg('m2', 7);
    appendFileSync(p, next.slice(0, 40));
    log.poll();
    expect(log.usage().tokensOut).toBe(5);
    appendFileSync(p, next.slice(40));
    log.poll();
    expect(log.usage()).toMatchObject({ tokensIn: 2220, tokensOut: 12 });
  });

  it('fails soft: no log yet, or lines it does not understand', () => {
    const dir = configWithLog();
    const log = new SessionLog(SID, dir);
    log.poll();
    expect(log.readable).toBe(false);
    expect(log.usage()).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      model: null,
      costUsd: 0,
    });
    writeFileSync(join(dir, 'projects', '-home-me-repo', `${SID}.jsonl`), 'not json\n{"type":1}\n');
    log.poll();
    expect(log.readable).toBe(true);
    expect(log.usage().tokensIn).toBe(0);
  });

  it('reads busy / idle / waiting from the session file', () => {
    const dir = configWithLog();
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(
      join(dir, 'sessions', '42.json'),
      JSON.stringify({ pid: 42, status: 'waiting', waitingFor: 'permission prompt' }),
    );
    expect(sessionStatus(42, dir)).toEqual({ status: 'waiting', waitingFor: 'permission prompt' });
    expect(sessionStatus(43, dir)).toBeNull();
  });
});

describe('interactive Claude: the permission hook', () => {
  it('prints a deny decision only when Hivenod denies', () => {
    expect(hookDecision({})).toBe('');
    expect(hookDecision(null)).toBe('');
    expect(
      JSON.parse(hookDecision({ behavior: 'deny', message: 'No answer in 10 minutes.' })),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'No answer in 10 minutes.' },
      },
    });
  });

  it('describes the request for the run log', () => {
    expect(describeRequest({ tool_name: 'Bash', tool_input: { command: 'git push\nmore' } })).toBe(
      'Bash: git push',
    );
    expect(describeRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://x.y' } })).toBe(
      'WebFetch: https://x.y',
    );
    expect(describeRequest({})).toBe('a tool');
  });
});
