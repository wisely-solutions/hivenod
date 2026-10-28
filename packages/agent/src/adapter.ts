/**
 * One adapter per coding CLI for `hivenod run <cli>` (cards MkUwvyWs, 3RiuFK00): the command line
 * of one headless run, a reader for the CLI's output (tokens, model, progress lines) and a
 * preflight check of the installed version. The loop and the guardrails stay in runner.ts.
 *
 * Claude Code is verified on the Hivenod VM. Codex and GitHub Copilot CLI are EXPERIMENTAL: built
 * from their help output, docs and package source, and tested only against fixtures, never with
 * a real account (README, "Verified or not").
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { CLI_INFO, type AgentPermission, type RunCli } from '@hive/shared';
import { claudeArgs, ClaudeStream, type StreamNote, type Usage } from './claude';

export interface CliStream {
  /** One line of the CLI's stdout: notes for the terminal (and now and then the run log). */
  push(line: string): StreamNote[];
  /** Usage so far; exact once the CLI reported its end. */
  usage(): Usage;
  /** Reads side files (session log, telemetry) for running totals; called every few seconds. */
  poll?(): void;
  /** Set once the CLI reported how its run ended. */
  result: { isError: boolean; text: string; denials: string[] } | null;
}

export interface HeadlessSpec {
  prompt: string;
  /** How the CLI starts the one-item Hivenod MCP server (`hivenod mcp --run R --bridge S`). */
  mcp: { command: string; args: string[] };
  /**
   * Only for CLIs that do not read the person's own permission settings (Codex, Copilot): Hivenod's
   * fixed defaults (DEFAULT_AGENT_PERMISSIONS). Claude ignores it: the user's own config rules.
   */
  permissions: readonly AgentPermission[];
  model?: string;
  /** Claude only: the person's own arguments after `--` (validated in cli.ts). */
  extraArgs?: readonly string[];
  /** Folders the model may not read or change (Hivenod's credentials), where the CLI can say so. */
  deniedPaths: readonly string[];
  /** The run's private temp folder (0700, removed after the run): for the CLI's side files. */
  dir: string;
}

export interface HeadlessRun {
  args: string[];
  /** Changes to the CLI's environment (undefined removes a variable). */
  env?: Record<string, string | undefined>;
  stream: CliStream;
}

export interface Preflight {
  /** The install cannot be used (a flag Hivenod needs is missing). */
  errors: string[];
  /** Shown, then the session goes on (e.g. a version Hivenod was not checked against). */
  warnings: string[];
}

export interface CliAdapter {
  id: RunCli;
  name: string;
  experimental: boolean;
  /** The executable, unless the env variable `binEnv` names another. */
  bin: string;
  binEnv: string;
  /** Environment for the version/help checks (e.g. no self-update). */
  checkEnv?: Record<string, string>;
  /**
   * Set when the CLI's commands can read the saved token (~/.hivenod/agent.json) and Hivenod cannot stop
   * them: `hivenod run` then needs HIVENOD_TOKEN (no file) and refuses a saved token. The text is the reason.
   */
  envTokenOnly?: string;
  /** The version Hivenod's command line was checked against. */
  checkedVersion: string;
  parseVersion(versionOutput: string): string | null;
  /** Arguments that print the help text preflight reads (none: no help check). */
  helpArgs?: string[];
  preflight(version: string | null, help: string): Preflight;
  /** Interactive sessions per item (Build D) exist only for Claude Code. */
  interactive: boolean;
  headless(spec: HeadlessSpec): HeadlessRun;
  /** The header line about unattended runs. */
  headlessLine: string;
  /** Where permissions come from, when not the person's Claude Code settings (Codex, Copilot). */
  permissionsLine?: string;
  /** Extra header lines (e.g. what is untested). */
  notes: string[];
}

/** -1, 0 or 1; missing parts count as 0 ("1.2" = "1.2.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Warnings for a version other than the checked one. */
export function versionWarnings(name: string, version: string | null, checked: string): string[] {
  if (!version)
    return [
      `Could not read the ${name} version; Hivenod's command line was checked against ${checked}.`,
    ];
  const c = compareVersions(version, checked);
  if (c < 0)
    return [
      `${name} ${version} is older than ${checked}, the version Hivenod was checked against: update it if runs fail.`,
    ];
  if (c > 0)
    return [
      `${name} ${version} is newer than ${checked}, the version Hivenod was checked against: its flags may have changed.`,
    ];
  return [];
}

/** Errors for flags Hivenod needs that this install's help text does not list. */
export function missingFlags(
  name: string,
  help: string,
  flags: readonly string[],
  versions?: { found: string | null; checked: string; cli?: string },
): string[] {
  const missing = flags.filter(
    (f) => !new RegExp(`(^|[\\s,=\\[])${f.replace(/-/g, '\\-')}(?![\\w-])`, 'm').test(help),
  );
  return missing.length
    ? [
        `${name} does not offer ${missing.join(', ')}, which hivenod run needs. ${
          versions
            ? `Found ${versions.cli ?? name} ${versions.found ?? '(version unknown)'}; Hivenod was checked against ${versions.checked}. Update it to ${versions.checked} or newer, or install that version.`
            : `This version is not supported; update ${name}.`
        }`,
      ]
    : [];
}

export const claudeAdapter: CliAdapter = {
  id: 'claude',
  name: CLI_INFO.claude.name,
  experimental: false,
  bin: 'claude',
  binEnv: 'HIVENOD_CLAUDE_BIN',
  checkedVersion: '2.1.310',
  parseVersion: (out) => out.trim().split(/\s+/)[0] || null,
  preflight: () => ({ errors: [], warnings: [] }),
  interactive: true,
  headless(spec) {
    return {
      args: claudeArgs({
        prompt: spec.prompt,
        mcpConfig: JSON.stringify({
          mcpServers: { hivenod: { command: spec.mcp.command, args: spec.mcp.args, env: {} } },
        }),
        model: spec.model,
        deniedPaths: spec.deniedPaths,
        extraArgs: spec.extraArgs,
      }),
      stream: new ClaudeStream(),
    };
  },
  headlessLine:
    "  Headless: Claude runs unattended; what your Claude Code settings don't allow is denied.",
  notes: [],
};

/** Reads the lines appended to a file since the last call (a file that may not exist yet). */
export class TailReader {
  private offset = 0;
  private partial = '';
  constructor(public path: string | null = null) {}

  /** New complete lines (empty when the file is missing or unchanged). */
  lines(): string[] {
    if (!this.path) return [];
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0; // replaced: start over
        this.partial = '';
      }
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const got = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += got;
      const text = this.partial + buf.subarray(0, got).toString('utf8');
      const parts = text.split('\n');
      this.partial = parts.pop() ?? '';
      return parts.filter((l) => l.trim());
    } finally {
      closeSync(fd);
    }
  }
}

/** A whole number >= 0 from an unknown value (else 0). */
export const count = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
