import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareVersions, missingFlags, versionWarnings } from './adapter';
import { codexAdapter, codexArgs, codexSandbox, CodexStream, findRollout } from './codex';

const fixture = (f: string) => fileURLToPath(new URL(`../test/fixtures/${f}`, import.meta.url));
const lines = (f: string) => readFileSync(fixture(f), 'utf8').split('\n').filter(Boolean);
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const mcp = {
  command: '/usr/bin/node',
  args: ['/x/cli.js', 'mcp', '--run', 'R1', '--bridge', '/t/b "q".sock'],
};

describe('codex command line (EXPERIMENTAL)', () => {
  it('runs codex exec with JSON, only the Hivenod MCP server, no approvals, prompt last', () => {
    const a = codexArgs({
      prompt: '--do the item',
      mcp,
      permissions: ['editFiles'],
      model: 'gpt-5.5-codex',
    });
    expect(a.slice(0, 4)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
    ]);
    expect(a).not.toContain('--full-auto');
    expect(a).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    const cfg = a.filter((_, i) => a[i - 1] === '-c');
    expect(cfg).toContain('approval_policy="never"');
    expect(cfg).toContain('mcp_servers.hivenod.command="/usr/bin/node"');
    // TOML array with escaped quotes (TOML basic strings use JSON's escapes).
    expect(cfg).toContain(
      'mcp_servers.hivenod.args=["/x/cli.js","mcp","--run","R1","--bridge","/t/b \\"q\\".sock"]',
    );
    expect(cfg).toContain('mcp_servers.hivenod.default_tools_approval_mode="approve"');
    expect(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5.5-codex']);
    expect(a.slice(-2)).toEqual(['--', '--do the item']);
  });

  it('maps the allow-list to the sandbox', () => {
    expect(codexSandbox([])).toEqual({ sandbox: 'read-only', network: false });
    expect(codexSandbox(['editFiles'])).toEqual({ sandbox: 'workspace-write', network: false });
    expect(codexSandbox(['runTests', 'gitCommit'])).toEqual({
      sandbox: 'workspace-write',
      network: false,
    });
    expect(codexSandbox(['gitPush'])).toEqual({ sandbox: 'workspace-write', network: true });
    expect(codexSandbox(['webAccess'])).toEqual({ sandbox: 'read-only', network: true });
    const ro = codexArgs({ prompt: 'p', mcp, permissions: [] });
    expect(ro.slice(ro.indexOf('--sandbox'), ro.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'read-only',
    ]);
    expect(ro.join(' ')).not.toContain('network_access');
    const rw = codexArgs({ prompt: 'p', mcp, permissions: ['editFiles', 'installPackages'] });
    expect(rw).toContain('workspace-write');
    expect(rw).toContain('sandbox_workspace_write.network_access=true');
    expect(codexArgs({ prompt: 'p', mcp, permissions: ['editFiles'] })).toContain(
      'sandbox_workspace_write.network_access=false',
    );
  });
});

describe('codex exec --json reader (recorded-style fixture, 0.164.0 vocabulary)', () => {
  it('reads the thread, progress lines and the final usage', () => {
    const s = new CodexStream('gpt-5.5-codex', '/nonexistent');
    const notes = lines('codex-0.164.0-exec.jsonl').flatMap((l) => s.push(l));
    expect(s.sessionId).toBe(THREAD);
    expect(notes).toEqual([
      { kind: 'tool', text: 'hivenod read_item' },
      { kind: 'tool', text: "$ bash -lc 'npm test'" },
      { kind: 'tool', text: 'edit post-4.md' },
      { kind: 'tool', text: 'web search annual vs monthly pricing page examples' },
      { kind: 'text', text: 'Drafted posts/post-4.md.' },
    ]);
    expect(s.result).toEqual({ isError: false, text: '', denials: [] });
    // OpenAI counts cached input inside input_tokens.
    expect(s.usage()).toEqual({
      tokensIn: 24763,
      tokensCached: 24448,
      tokensOut: 122,
      model: 'gpt-5.5-codex',
      costUsd: 0,
    });
  });

  it('a failed turn or an error is an error result; junk lines are skipped', () => {
    const s = new CodexStream();
    expect(s.push('not json')).toEqual([]);
    s.push(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }));
    expect(s.result).toEqual({ isError: true, text: 'stream disconnected', denials: [] });
    const e = new CodexStream();
    expect(
      e.push(JSON.stringify({ type: 'error', message: 'You have hit your usage limit.' })),
    ).toEqual([{ kind: 'text', text: 'error: You have hit your usage limit.' }]);
    expect(e.result?.isError).toBe(true);
    expect(e.usage()).toMatchObject({ tokensIn: 0, tokensOut: 0, model: null });
  });

  it('running totals and the model come from the thread session file while it works', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const started = new Date(2026, 9, 26, 23, 59);
    const day = join(home, 'sessions', '2026', '10', '26');
    mkdirSync(day, { recursive: true });
    const s = new CodexStream(null, home, started);
    s.push(JSON.stringify({ type: 'thread.started', thread_id: THREAD }));
    s.poll();
    expect(s.usage()).toMatchObject({ tokensIn: 0, model: null }); // no file yet
    copyFileSync(
      fixture('codex-0.164.0-rollout.jsonl'),
      join(day, `rollout-2026-10-26T23-59-00-${THREAD}.jsonl`),
    );
    expect(findRollout(THREAD, home, [started])).toContain(THREAD);
    s.poll();
    expect(s.usage()).toEqual({
      tokensIn: 24763,
      tokensCached: 24448,
      tokensOut: 122,
      model: 'gpt-5.5-codex',
      costUsd: 0,
    });
  });
});

describe('codex preflight', () => {
  const help = readFileSync(fixture('codex-0.164.0-exec-help.txt'), 'utf8');
  it('accepts 0.164.0 and its exec help', () => {
    expect(codexAdapter.parseVersion('codex-cli 0.164.0\n')).toBe('0.164.0');
    expect(codexAdapter.preflight('0.164.0', help)).toEqual({ errors: [], warnings: [] });
  });
  it('refuses a codex exec without a flag Hivenod needs, warns on other versions', () => {
    const old = help.replace('--ignore-user-config', '--other-thing');
    expect(codexAdapter.preflight('0.120.0', old).errors[0]).toContain('--ignore-user-config');
    expect(codexAdapter.preflight('0.120.0', help).warnings[0]).toContain('older than 0.164.0');
    expect(codexAdapter.preflight('0.170.1', help).warnings[0]).toContain('newer than 0.164.0');
    expect(codexAdapter.preflight(null, help).warnings[0]).toContain('Could not read');
  });
  it('compares versions and finds flags as whole words', () => {
    expect(compareVersions('0.164.0', '0.164')).toBe(0);
    expect(compareVersions('0.99.0', '0.164.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.164.0')).toBe(1);
    expect(missingFlags('x', '  --jsonl\n', ['--json'])).toHaveLength(1);
    expect(missingFlags('x', '      --json\n', ['--json'])).toEqual([]);
    expect(versionWarnings('X', '1.0.0', '1.0.0')).toEqual([]);
    const m = missingFlags('codex exec', '', ['--json'], {
      found: '0.120.0',
      checked: '0.164.0',
      cli: 'Codex',
    });
    expect(m[0]).toContain('Found Codex 0.120.0; Hivenod was checked against 0.164.0');
    expect(m[0]).not.toContain('install codex exec again');
  });
});
