import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  copilotAdapter,
  copilotAllowed,
  copilotArgs,
  copilotDenied,
  copilotEnv,
  CopilotStream,
  otelCalls,
  otelFile,
  usageFile,
  usageFromFile,
} from './copilot';

const fixture = (f: string) => fileURLToPath(new URL(`../test/fixtures/${f}`, import.meta.url));
const read = (f: string) => readFileSync(fixture(f), 'utf8');
const mcp = {
  command: '/usr/bin/node',
  args: ['/x/cli.js', 'mcp', '--run', 'R1', '--bridge', '/t/b.sock'],
};

describe('copilot command line (EXPERIMENTAL)', () => {
  it('prompt mode, JSON, no questions, the Hivenod MCP server, usage file in the run folder', () => {
    const a = copilotArgs({
      prompt: '-p looks like a flag',
      mcp,
      permissions: [],
      model: 'gpt-5.4',
      dir: '/run',
    });
    expect(a[0]).toBe('--prompt=-p looks like a flag');
    for (const f of [
      '--output-format=json',
      '--no-ask-user',
      '--no-auto-update',
      '--disable-builtin-mcps',
    ])
      expect(a).toContain(f);
    const cfg = a.find((x) => x.startsWith('--additional-mcp-config='))!;
    expect(JSON.parse(cfg.slice('--additional-mcp-config='.length))).toEqual({
      mcpServers: { hivenod: { type: 'local', ...mcp, env: {}, tools: ['*'] } },
    });
    expect(a).toContain('--usage-output-file=/run/copilot-usage.json');
    expect(a).toContain('--model=gpt-5.4');
    // Never a blanket grant.
    for (const f of [
      '--allow-all-tools',
      '--allow-all',
      '--yolo',
      '--allow-all-paths',
      '--allow-all-urls',
    ])
      expect(a).not.toContain(f);
  });

  it('maps the allow-list to --allow-tool rules and denies kinds with no rule', () => {
    expect(copilotAllowed([])).toEqual(['hivenod']);
    expect(copilotDenied([])).toEqual(['shell', 'write', 'url']);
    expect(copilotAllowed(['editFiles', 'gitCommit'])).toEqual(
      expect.arrayContaining(['hivenod', 'write', 'shell(git commit)', 'shell(git add)']),
    );
    expect(copilotAllowed(['gitCommit'])).not.toContain('shell(git push)');
    // Some shell rules: shell cannot be denied as a whole (deny wins over every allow).
    expect(copilotDenied(['gitCommit'])).toEqual(['write', 'url']);
    expect(copilotDenied(['runCommands', 'editFiles', 'webAccess'])).toEqual([]);
    const a = copilotArgs({ prompt: 'p', mcp, permissions: ['runTests'], dir: '/run' });
    expect(a).toContain('--allow-tool=shell(npm test:*)');
    expect(a).toContain('--deny-tool=write');
    expect(a).not.toContain('--deny-tool=shell');
  });

  it('environment: OpenTelemetry to a file in the run folder, COPILOT_ALLOW_ALL removed', () => {
    const env = copilotEnv('/run');
    expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/run/copilot-otel.jsonl');
    expect(env.COPILOT_OTEL_EXPORTER_TYPE).toBe('file');
    expect(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe('false');
    expect('COPILOT_ALLOW_ALL' in env && env.COPILOT_ALLOW_ALL === undefined).toBe(true);
  });
});

describe('copilot output readers (recorded-style fixtures, 1.0.103 shapes)', () => {
  it('reads progress and the final result line from the JSON stream', () => {
    const s = new CopilotStream('/nonexistent');
    const notes = read('copilot-1.0.103-output.jsonl')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => s.push(l));
    expect(notes).toEqual([
      { kind: 'text', text: 'Reading the brief first.' },
      { kind: 'tool', text: 'hivenod read_item' },
      { kind: 'tool', text: '$ npm test' },
      { kind: 'tool', text: 'create post-4.md' },
      { kind: 'text', text: 'Drafted the post.' },
    ]);
    expect(s.sessionId).toBe('7c1f0f7e-2b8a-4c1e-9a55-5b8d7f0e4a21');
    expect(s.result).toEqual({ isError: false, text: '', denials: [] });
    const bad = new CopilotStream('/nonexistent');
    bad.push(JSON.stringify({ type: 'result', sessionId: 'x', exitCode: 1 }));
    expect(bad.result?.isError).toBe(true);
  });

  it('the usage file: tokens per model (input includes cache), the busiest model first', () => {
    expect(usageFromFile(read('copilot-1.0.103-usage.json'))).toEqual({
      tokensIn: 31000,
      tokensOut: 950,
      tokensCached: 20000,
      model: 'gpt-5.4 +1',
      costUsd: 0,
    });
    expect(usageFromFile('{"modelMetrics":{}}')).toMatchObject({ tokensIn: 0, model: null });
    expect(usageFromFile('nope')).toBeNull();
  });

  it('OpenTelemetry lines: model calls from spans in OTLP or flat JSON; metrics ignored', () => {
    const calls = read('copilot-1.0.103-otel.jsonl').split('\n').filter(Boolean).flatMap(otelCalls);
    expect(calls).toEqual([
      { id: 's1', call: { model: 'gpt-5.4', input: 12000, output: 300, cacheRead: 8000 } },
      { id: 's2', call: { model: 'gpt-5.4', input: 18000, output: 600, cacheRead: 12000 } },
    ]);
  });

  it('running totals from the OTel file while it works, then the usage file when it ends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-run-'));
    const s = new CopilotStream(dir);
    s.poll();
    expect(s.usage()).toMatchObject({ tokensIn: 0, tokensOut: 0, model: null });
    copyFileSync(fixture('copilot-1.0.103-otel.jsonl'), otelFile(dir));
    s.poll();
    s.poll(); // read once: no double counting
    expect(s.usage()).toEqual({
      tokensIn: 30000,
      tokensOut: 900,
      tokensCached: 20000,
      model: 'gpt-5.4',
      costUsd: 0,
    });
    copyFileSync(fixture('copilot-1.0.103-usage.json'), usageFile(dir));
    s.poll();
    expect(s.usage()).toMatchObject({ tokensIn: 31000, tokensOut: 950, model: 'gpt-5.4 +1' });
  });
});

describe('copilot preflight', () => {
  const help = read('copilot-1.0.103-help.txt');
  it('accepts 1.0.103 and its help', () => {
    expect(copilotAdapter.parseVersion('GitHub Copilot CLI 1.0.103.\nRun copilot update')).toBe(
      '1.0.103',
    );
    expect(copilotAdapter.preflight('1.0.103', help)).toEqual({ errors: [], warnings: [] });
  });
  it('refuses a copilot without --usage-output-file', () => {
    const p = copilotAdapter.preflight('1.0.90', help.replaceAll('--usage-output-file', '--x'));
    expect(p.errors[0]).toContain('--usage-output-file');
    expect(p.warnings[0]).toContain('older than 1.0.103');
  });
});
