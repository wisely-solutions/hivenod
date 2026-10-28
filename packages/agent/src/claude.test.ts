import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allowedTools,
  claudeArgs,
  claudeArgsProblem,
  describeExtraArgs,
  hasPermissionFlag,
  isBypass,
  ClaudeStream,
  estimateUsd,
  eurFromUsd,
  modelLabel,
} from './claude';

const fixture = readFileSync(
  new URL('../test/fixtures/claude-2.1.310-stream.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n');

describe("claude adapter: permissions (the user's own Claude Code config rules, card rifzGl8M)", () => {
  it('only allows the Hivenod tools and reading up front; nothing from Hivenod permissions', () => {
    expect(allowedTools()).toEqual(['mcp__hivenod__*', 'Read', 'Glob', 'Grep', 'TodoWrite']);
  });

  it('runs headless with only the Hivenod MCP server and denies instead of asking', () => {
    const args = claudeArgs({
      prompt: 'do it',
      mcpConfig: '{"mcpServers":{}}',
      model: 'sonnet',
    });
    expect(args.slice(0, 2)).toEqual(['-p', 'do it']);
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--strict-mcp-config');
    expect(flag('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(flag('--permission-prompts')).toBe('none');
    expect(flag('--allowedTools')).toBe('mcp__hivenod__*,Read,Glob,Grep,TodoWrite');
    expect(flag('--model')).toBe('sonnet');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(claudeArgs({ prompt: 'x', mcpConfig: '{}' })).not.toContain('--model');
  });
});

describe('claude adapter: extra arguments after -- (card 19u5WLtk)', () => {
  it('headless: person flags go in, a permission flag drops the forced dontAsk, guards stay', () => {
    const base = { prompt: 'p', mcpConfig: '{}', deniedPaths: ['/h/.hivenod'] };
    const yolo = claudeArgs({ ...base, extraArgs: ['--dangerously-skip-permissions'] });
    expect(yolo).toContain('--dangerously-skip-permissions');
    expect(yolo).not.toContain('--permission-mode');
    expect(yolo).toContain('--disallowedTools');
    expect(yolo.slice(0, 3)).toEqual(['-p', 'p', '--dangerously-skip-permissions']);
    const plain = claudeArgs({ ...base, extraArgs: ['--effort', 'high'] });
    expect(plain[plain.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(claudeArgs(base)).toEqual(claudeArgs({ ...base, extraArgs: [] }));
  });

  it('detects permission and bypass flags in every spelling', () => {
    expect(hasPermissionFlag(['--permission-mode=plan'])).toBe(true);
    expect(hasPermissionFlag(['--allow-dangerously-skip-permissions'])).toBe(true);
    expect(hasPermissionFlag(['--model', 'opus'])).toBe(false);
    expect(isBypass(['--dangerously-skip-permissions'])).toBe(true);
    expect(isBypass(['--permission-mode', 'bypassPermissions'])).toBe(true);
    expect(isBypass(['--permission-mode=bypassPermissions'])).toBe(true);
    expect(isBypass(['--permission-mode', 'plan'])).toBe(false);
    expect(isBypass(['--allow-dangerously-skip-permissions'])).toBe(false);
  });

  it('refuses the flags Hivenod owns, and passes additive ones', () => {
    for (const bad of [
      ['-p'],
      ['--print'],
      ['--session-id', 'x'],
      ['--session-id=x'],
      ['-n', 'x'],
      ['--name', 'x'],
      ['--remote-control'],
      ['--mcp-config', 'x'],
      ['--strict-mcp-config'],
      ['--settings', '{}'],
      ['--append-system-prompt', 'x'],
      ['--output-format', 'json'],
      ['--input-format', 'x'],
      ['--permission-prompts', 'host'],
      ['-c'],
      ['--resume', 'x'],
      ['--bg'],
      ['--tmux'],
      ['-h'],
      ['-pc'],
    ])
      expect(claudeArgsProblem(bad), bad.join(' ')).toMatch(/set by Hivenod/);
    for (const ok of [
      ['--dangerously-skip-permissions'],
      ['--model', 'opus', '--effort', 'high'],
      ['--add-dir', '../x', '--allowedTools', 'Bash(git *)', '--disallowedTools', 'WebFetch'],
      ['--system-prompt', 'be brief'],
      ['--permission-mode', 'acceptEdits'],
    ])
      expect(claudeArgsProblem(ok), ok.join(' ')).toBeNull();
    expect(claudeArgsProblem(['--model', 'x'], 'sonnet')).toMatch(/twice/);
    expect(claudeArgsProblem(['--model', 'x'])).toBeNull();
  });

  it('refuses short flags with =', () => {
    for (const x of ['-p=x', '-n=foo', '-c=1'])
      expect(claudeArgsProblem([x]), x).toMatch(/set by Hivenod/);
  });

  it('shows only known harmless values', () => {
    expect(
      describeExtraArgs(['--model', 'opus', '--dangerously-skip-permissions', '--effort=high']),
    ).toBe('--model opus --dangerously-skip-permissions --effort=high');
    expect(describeExtraArgs(['--system-prompt', 'be brief'])).toBe('--system-prompt ***');
    const secrets = [
      'github_pat_11FAKEabc',
      'gho_abc123',
      'ghs_abc123',
      'ghu_abc123',
      'xoxb-123-456',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOi.eyJzdWIi.sig',
      'sk-proj-abc123',
      'ghp_abc123',
      'hive_agt_abc123',
    ];
    for (const t of secrets) {
      for (const args of [
        [t],
        ['--x', t],
        [`--x=${t}`],
        ['--agents', JSON.stringify({ x: t })],
        ['--dangerously-skip-permissions', '--agents', `{"x":"${t}"}`],
        ['--append', `use ${t} now`],
      ]) {
        const d = describeExtraArgs(args);
        expect(d, args.join(' ')).not.toContain(t.slice(0, 8));
      }
    }
    expect(describeExtraArgs(['--agents', '{"x":"y"}'])).toBe('--agents ***');
    expect(describeExtraArgs(['--x=1'])).toBe('--x=***');
    expect(describeExtraArgs(['--add-dir', '../x'])).toBe('--add-dir ../x');
    expect(
      describeExtraArgs(['--system-prompt', 'a'.repeat(500)].concat(Array(100).fill('--verbose')))
        .length,
    ).toBeLessThanOrEqual(300);
  });
});

describe('claude adapter: stream-json (recorded from Claude Code 2.1.310)', () => {
  it('reads session, progress lines and the exact final usage per model', () => {
    const s = new ClaudeStream();
    const notes = fixture.flatMap((l) => s.push(l));
    expect(s.sessionId).toBe('1d232589-0fce-4a95-b992-6f5a2ef75b32');
    expect(notes).toEqual(
      expect.arrayContaining([
        { kind: 'tool', text: 'Write hello.txt' },
        { kind: 'tool', text: '$ echo test-bash-ok' },
        expect.objectContaining({ kind: 'text', text: expect.stringMatching(/^DONE/) }),
      ]),
    );
    // result.modelUsage: 4 input + 35070 cache read + 12963 cache write; 439 out.
    expect(s.usage()).toEqual({
      tokensIn: 4 + 35070 + 12963,
      tokensCached: 35070,
      tokensOut: 439,
      model: 'claude-haiku-5-5',
      costUsd: 0.0031632,
    });
    expect(s.result).toEqual({ isError: false, text: expect.stringMatching(/^DONE/), denials: [] });
  });

  it('gives a running total before the result (one count per message id)', () => {
    const s = new ClaudeStream();
    for (const l of fixture.filter((l) => !l.includes('"type": "result"'))) s.push(l);
    const u = s.usage();
    // Two distinct messages: (2 + 12402 + 11334) and (2 + 561 + 23736).
    expect(u.tokensIn).toBe(2 + 12402 + 11334 + 2 + 561 + 23736);
    expect(u.tokensCached).toBe(11334 + 23736);
    expect(u.model).toBe('claude-haiku-5-5');
    expect(s.result).toBeNull();
  });

  it('reports errors, denials and limits; ignores noise', () => {
    const s = new ClaudeStream();
    expect(s.push('not json')).toEqual([]);
    expect(
      s.push(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
        }),
      ),
    ).toEqual([{ kind: 'rateLimit', text: expect.stringContaining('five_hour') }]);
    s.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
      }),
    );
    expect(s.result).toEqual({ isError: true, text: '', denials: ['$ rm -rf /'] });
    expect(s.usage()).toMatchObject({ tokensIn: 15, tokensCached: 5, tokensOut: 3 });
  });

  it('labels several models by output', () => {
    expect(modelLabel(new Map())).toBeNull();
    expect(modelLabel(new Map([['a', 1]]))).toBe('a');
    expect(
      modelLabel(
        new Map([
          ['haiku', 10],
          ['opus', 900],
        ]),
      ),
    ).toBe('opus +1');
  });
});

describe('claude adapter: cost (tester R80: cost was always €0)', () => {
  it('takes the cost from the result (total_cost_usd) and converts it to EUR', () => {
    const s = new ClaudeStream();
    for (const l of fixture) s.push(l);
    // Recorded result: "total_cost_usd": 0.0031632.
    expect(s.usage().costUsd).toBeCloseTo(0.0031632, 7);
    const before = process.env.HIVENOD_EUR_PER_USD;
    process.env.HIVENOD_EUR_PER_USD = '0.5';
    try {
      expect(eurFromUsd(0.0031632)).toBeCloseTo(0.0015816, 6);
    } finally {
      if (before === undefined) delete process.env.HIVENOD_EUR_PER_USD;
      else process.env.HIVENOD_EUR_PER_USD = before;
    }
    expect(eurFromUsd(1)).toBeGreaterThan(0.5);
  });

  it('estimates the cost from tokens before the result (e.g. a run stopped early)', () => {
    const s = new ClaudeStream();
    for (const l of fixture.filter((l) => !l.includes('"type": "result"'))) s.push(l);
    const est = s.usage().costUsd;
    // Close to what Claude charged for the whole run (same messages, list prices).
    expect(est).toBeGreaterThan(0.0031632 * 0.7);
    expect(est).toBeLessThan(0.0031632 * 1.3);
  });

  it('prices by model family, with a fallback for unknown models', () => {
    const u = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 };
    expect(estimateUsd('claude-opus-5-5', u)).toBe(24);
    expect(estimateUsd('claude-sonnet-5-5', u)).toBe(12);
    expect(estimateUsd('claude-haiku-5-5', u)).toBeCloseTo(0.6, 6);
    expect(estimateUsd('claude-fable-5-1', u)).toBe(60);
    expect(estimateUsd('something-else', u)).toBe(18);
    expect(
      estimateUsd('claude-sonnet-5-5', { ...u, input: 0, output: 0, cacheRead: 1e6 }),
    ).toBeCloseTo(0.2, 6);
  });

  it('uses the per-model costUSD when the result has no total', () => {
    const s = new ClaudeStream();
    s.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        modelUsage: {
          'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.25 },
          'claude-haiku-5-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.05 },
        },
      }),
    );
    expect(s.usage().costUsd).toBeCloseTo(0.3, 6);
  });
});

describe("claude adapter: Hivenod's own folders are denied", () => {
  const deny = (paths?: string[]) => {
    const args = claudeArgs({ prompt: 'x', mcpConfig: '{}', deniedPaths: paths });
    const i = args.indexOf('--disallowedTools');
    return i < 0 ? [] : args[i + 1]!.split(',');
  };

  it("denies nothing of the user's machine, only the given folders (credentials, run folder)", () => {
    expect(deny()).toEqual([]);
    expect(deny(['/home/x/.hivenod', '/tmp/hivenod-run-ab12'])).toEqual([
      'Read(//home/x/.hivenod/**)',
      'Edit(//home/x/.hivenod/**)',
      'Read(//tmp/hivenod-run-ab12/**)',
      'Edit(//tmp/hivenod-run-ab12/**)',
    ]);
  });
});
