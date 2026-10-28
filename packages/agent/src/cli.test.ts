import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adapterFor,
  checkCli,
  main,
  renderItem,
  splitExtraArgs,
  tokenGuard,
  waitText,
} from './cli';
import { ADAPTERS } from './clis';
import { credentialsPath, saveCredentials } from './credentials';
import { encodeToken } from '@hive/shared';

const fake = (f: string) => fileURLToPath(new URL(`../test/fixtures/${f}`, import.meta.url));

// The run engine stays tested; `hivenod run` itself is paused unless HIVENOD_ALLOW_RUN=1 (card Ul32d6Ee).
beforeEach(() => vi.stubEnv('HIVENOD_ALLOW_RUN', '1'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('hivenod run is paused (card Ul32d6Ee)', () => {
  it('is hidden from --help and points to the channel plugin', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await main(['--help'])).toBe(0);
    const text = String(out.mock.calls[0]?.[0]);
    expect(text).not.toMatch(/hivenod run (claude|codex|copilot)/);
    expect(text).not.toContain('--headless');
    expect(text).toContain('hivenod pair');
    expect(text).toContain('hivenod run log <runId>');
  });

  it('prints the paused message and does nothing unless HIVENOD_ALLOW_RUN=1', async () => {
    vi.stubEnv('HIVENOD_ALLOW_RUN', '');
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const argv of [
      ['run', 'claude'],
      ['run', 'codex', '--once'],
      ['run', 'claude', '--', '-p'],
      ['--json', 'run', 'claude'],
      ['--project', 'p1', 'run', 'codex'],
      ['--help', 'run', 'claude'],
      ['run', '--help', 'claude'],
      ['run', 'claude', '--help'],
    ])
      expect(await main(argv)).toBe(1);
    for (const call of err.mock.calls)
      expect(String(call[0])).toBe(
        'hivenod: hivenod run is paused for now; use the Claude Code channel plugin (see https://hivenod.com/agents)\n',
      );
  });

  it('keeps run log and the other run subcommands working with an option first', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubEnv('HIVENOD_ALLOW_RUN', '');
    await main(['--json', 'run', 'log']);
    for (const call of err.mock.calls) expect(String(call[0])).not.toContain('is paused');
    out.mockRestore();
  });

  it('never tells people to pair with hivenod run claude when not paired', async () => {
    for (const cmd of [['whoami'], ['mcp']]) {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await main(cmd);
      const text = err.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('Run `hivenod pair`');
      expect(text).not.toContain('hivenod run claude');
      err.mockRestore();
    }
  });
});

describe('hivenod run claude -- <args> (card 19u5WLtk)', () => {
  it('splits at the first -- only for hivenod run <cli>', () => {
    expect(splitExtraArgs(['run', 'claude', '--headless', '--', '--model', 'opus'])).toEqual({
      argv: ['run', 'claude', '--headless'],
      extra: ['--model', 'opus'],
    });
    expect(splitExtraArgs(['run', 'claude', '--', '--a', '--', '--b']).extra).toEqual([
      '--a',
      '--',
      '--b',
    ]);
    expect(splitExtraArgs(['item', 'ask', 'i1', '--', '-q'])).toEqual({
      argv: ['item', 'ask', 'i1', '--', '-q'],
      extra: [],
    });
  });

  it('refuses Hive-owned flags and non-Claude CLIs with exit 2, before anything is claimed', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await main(['run', 'claude', '--', '--session-id', 'x'])).toBe(2);
      expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/--session-id is set by Hivenod/);
      expect(await main(['run', 'claude', '--', '-p'])).toBe(2);
      expect(await main(['run', 'claude', '--model', 'a', '--', '--model', 'b'])).toBe(2);
      expect(await main(['run', 'codex', '--', '--yolo'])).toBe(2);
      expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/only hivenod run claude/);
    } finally {
      err.mockRestore();
    }
  });

  it('help documents the -- form and the YOLO example', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await main(['run', 'claude', '--help']);
      const text = out.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('hivenod run claude -- --dangerously-skip-permissions');
      expect(text).toContain('Refused');
    } finally {
      out.mockRestore();
    }
  });
});

describe('hivenod cli', () => {
  it('prints help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await main(['--help'])).toBe(0);
    expect(String(out.mock.calls[0]?.[0])).toContain('hivenod work claim');
  });

  it('explains a missing token, as JSON on request', async () => {
    delete process.env.HIVENOD_TOKEN;
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await main(['whoami', '--json'])).toBe(1);
    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({
      error: expect.stringContaining('HIVENOD_TOKEN is not set'),
    });
  });

  it('rejects a malformed token without a network call', async () => {
    process.env.HIVENOD_TOKEN = 'nope';
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await main(['whoami'])).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain('not a valid Hivenod agent token');
    } finally {
      delete process.env.HIVENOD_TOKEN;
    }
  });

  describe('a damaged or missing saved pairing', () => {
    const tok = encodeToken({
      w: 'w1',
      e: 'agent-abcdef123456@agents.hive-board.app',
      p: 'p'.repeat(32),
    });
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'hive-cli-damaged-'));
      vi.stubEnv('HIVENOD_HOME', home);
      vi.stubEnv('HIVENOD_TOKEN', '');
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));
    const bodies: Record<string, string> = {
      'bad JSON': 'not json',
      'a wrong token format': '{"token":"nope"}',
      'a damaged tail': JSON.stringify({ token: `${tok.slice(0, -6)}%%%` }),
    };

    for (const [name, body] of Object.entries(bodies)) {
      it(`whoami and mcp exit 1 with the damaged message for ${name}`, async () => {
        writeFileSync(credentialsPath(), body);
        const expected = `The saved pairing in ${credentialsPath()} is damaged; run \`hivenod pair\` again.`;
        for (const cmd of [['whoami'], ['mcp'], ['whoami', '--json']]) {
          const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
          expect(await main(cmd)).toBe(1);
          const text = String(err.mock.calls[0]?.[0]);
          expect(text).toContain(expected);
          expect(text).not.toContain('not paired');
          err.mockRestore();
        }
      });
    }

    it('whoami and mcp exit 1 with the not-paired message when there is no file', async () => {
      for (const cmd of [['whoami'], ['mcp']]) {
        const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        expect(await main(cmd)).toBe(1);
        const text = String(err.mock.calls[0]?.[0]);
        expect(text).toContain('not paired');
        expect(text).not.toContain('damaged');
        err.mockRestore();
      }
    });
  });

  it('rejects unknown flags', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await main(['whoami', '--bogus'])).toBe(2);
  });

  it('says timedOut in the plain-text wait answer, like --json', () => {
    expect(waitText({ timedOut: true, work: [] })).toMatch(/^timedOut: true\./);
    expect(
      waitText({
        timedOut: false,
        work: [{ itemId: 'i1', project: 'P', step: 'draft', title: 'T' }],
      }),
    ).toBe('i1  [P / draft]  T');
  });

  it('hivenod run codex|copilot --help documents the experimental status and what is verified', async () => {
    for (const cli of ['codex', 'copilot']) {
      const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      expect(await main(['run', cli, '--help'])).toBe(0);
      const t = String(out.mock.calls[0]?.[0]);
      expect(t).toContain(`hivenod run ${cli}`);
      expect(t).toContain('EXPERIMENTAL, UNTESTED');
      expect(t).toContain('Not verified');
      expect(t).toContain('Verified without an account');
      out.mockRestore();
    }
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await main(['run', 'copilot', '--help']);
    expect(String(out.mock.calls[0]?.[0])).toContain('AI Credits');
    out.mockClear();
  });

  it('knows claude, codex and copilot; gemini is dropped with a reason', async () => {
    expect(adapterFor('codex').id).toBe('codex');
    expect(adapterFor('copilot').experimental).toBe(true);
    expect(adapterFor('claude').experimental).toBe(false);
    expect(() => adapterFor('gemini')).toThrow(/personal Google accounts/);
    expect(() => adapterFor('aider')).toThrow(/not supported/);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await main(['run', 'gemini'])).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('gemini');
    err.mockClear();
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await main(['run', 'gemini', '--help'])).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain('personal Google accounts');
  });

  it('checks the installed CLI: version, needed flags, a clear error when missing', () => {
    expect(checkCli(ADAPTERS.codex, fake('fake-codex.mjs'))).toEqual({
      version: '0.164.0',
      warnings: [],
    });
    expect(checkCli(ADAPTERS.copilot, fake('fake-copilot.mjs'))).toEqual({
      version: '1.0.103',
      warnings: [],
    });
    expect(() => checkCli(ADAPTERS.codex, '/nonexistent/codex')).toThrow(
      /Codex \(\/nonexistent\/codex\) was not found/,
    );
    // A codex whose exec lost a flag Hivenod needs, and a newer version.
    const run = ((_c: string, a: string[]) =>
      a[0] === '--version'
        ? { status: 0, stdout: 'codex-cli 0.170.0' }
        : { status: 0, stdout: '  --json\n  --sandbox <MODE>\n', stderr: '' }) as never;
    expect(() => checkCli(ADAPTERS.codex, 'codex', run)).toThrow(/--skip-git-repo-check/);
  });

  it('hivenod run codex refuses a saved token and pairing, and asks for HIVENOD_TOKEN (card l7waTKBB)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-home-'));
    const old = { t: process.env.HIVENOD_TOKEN, h: process.env.HIVENOD_HOME };
    try {
      process.env.HIVENOD_HOME = home;
      delete process.env.HIVENOD_TOKEN;
      saveCredentials({
        token: encodeToken({
          w: 'w1',
          e: 'agent-abcdefghijkl@agents.hive-board.app',
          p: 'x'.repeat(24),
        }),
        workspaceId: 'w1',
        agentUid: 'u',
        agentName: 'a',
      });
      expect(() => tokenGuard(ADAPTERS.codex)).toThrow(/saved token exists/);
      rmSync(join(home, 'agent.json'), { force: true });
      expect(() => tokenGuard(ADAPTERS.codex)).toThrow(/needs HIVENOD_TOKEN/);
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await main(['run', 'codex'])).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain('HIVENOD_TOKEN');
      process.env.HIVENOD_TOKEN = 'hive_agt_x';
      expect(() => tokenGuard(ADAPTERS.codex)).not.toThrow();
      // A saved token still refuses, even with HIVENOD_TOKEN set (tester R92).
      saveCredentials({
        token: encodeToken({
          w: 'w1',
          e: 'agent-abcdefghijkl@agents.hive-board.app',
          p: 'x'.repeat(24),
        }),
        workspaceId: 'w1',
        agentUid: 'u',
        agentName: 'a',
      });
      expect(() => tokenGuard(ADAPTERS.codex)).toThrow(/saved token exists.*hivenod logout/);
      try {
        tokenGuard(ADAPTERS.codex);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain('Settings');
      }
      rmSync(join(home, 'agent.json'), { force: true });
      delete process.env.HIVENOD_TOKEN;
      expect(() => tokenGuard(ADAPTERS.claude)).not.toThrow();
      expect(() => tokenGuard(ADAPTERS.copilot)).not.toThrow();
    } finally {
      if (old.t === undefined) delete process.env.HIVENOD_TOKEN;
      else process.env.HIVENOD_TOKEN = old.t;
      if (old.h === undefined) delete process.env.HIVENOD_HOME;
      else process.env.HIVENOD_HOME = old.h;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('hivenod item read', () => {
  const item = (over: object = {}) =>
    ({
      title: 'T',
      project: 'P',
      status: 'working',
      step: null,
      summary: 'Edited by an admin',
      sendBackReasons: [],
      messages: [],
      attachments: [],
      ...over,
    }) as never;

  it('labels the brief neutrally (an admin may have edited it)', () => {
    const out = renderItem(item());
    expect(out).toContain('Brief (Markdown):');
    expect(out).not.toMatch(/written by the person/);
  });

  it('lists attachment sizes as given (the original size)', () => {
    const out = renderItem(item({ attachments: [{ name: 'a.pdf', kind: 'pdf', bytes: 588 }] }));
    expect(out).toContain('a.pdf (pdf, 588 bytes)');
  });
});

describe('hivenod mcp --channel --max-items (card cGSENsRF)', () => {
  it('refuses a bad --max-items or HIVENOD_MAX_ITEMS, and --max-items without --channel', async () => {
    const cases: [string[], Record<string, string>, RegExp][] = [
      [
        ['mcp', '--channel', '--max-items', '0'],
        {},
        /--max-items must be a whole number from 1 to 10/,
      ],
      [['mcp', '--channel', '--max-items', 'abc'], {}, /--max-items must be a whole number/],
      [
        ['mcp', '--channel'],
        { HIVENOD_MAX_ITEMS: '11' },
        /HIVENOD_MAX_ITEMS must be a whole number/,
      ],
      [
        ['mcp', '--max-items', '3'],
        { HIVENOD_TOKEN: 'x' },
        /--max-items needs hivenod mcp --channel/,
      ],
    ];
    for (const [argv, env, re] of cases) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await main(argv)).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toMatch(re);
      err.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
