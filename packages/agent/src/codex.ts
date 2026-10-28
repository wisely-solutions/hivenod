/**
 * EXPERIMENTAL, UNTESTED with a real account: the OpenAI Codex CLI adapter for `hivenod run codex`
 * (card 3RiuFK00). Checked against codex-cli 0.164.0 without signing in:
 *   - `codex exec --help`: --json, --sandbox, --skip-git-repo-check, --ignore-user-config, -m, -c;
 *     `--full-auto` is gone (exec rejects it), so Hivenod never passes it: `--sandbox` plus
 *     `-c approval_policy="never"` take its place.
 *   - `-c mcp_servers.hivenod.command/args/default_tools_approval_mode` parse (`codex mcp list`), and
 *     the enum values: approval_policy never; default_tools_approval_mode approve.
 *   - The exec JSONL vocabulary in the binary: thread.started (thread_id), turn.completed (usage:
 *     input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens), turn.failed,
 *     item.started / item.completed, error; the session file words turn_context, token_count,
 *     total_token_usage. The model is not in the exec stream.
 * Saved token (card l7waTKBB): Codex 0.164.0 has permission profiles with a per-path "none" access
 * (`-c default_permissions="p" -c permissions.p.extends=":workspace" -c 'permissions.p.filesystem={"~/.hivenod"="none"}'`
 * parses, and `deny_read` is in the binary), but `codex sandbox` cannot run in an environment without
 * user namespaces, so enforcement was NOT observed, nor how a profile combines with `--sandbox`.
 * So Hivenod does not rely on it: `hivenod run codex` refuses a saved token and requires HIVENOD_TOKEN.
 * UNVERIFIED (no real run): the exact shape of each event, that the session file under
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl carries the model (turn_context) and
 * running totals (token_count) as read here, whether MCP tool calls run without a prompt under
 * approval_policy never, and whether `git commit` works in the workspace-write sandbox.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_INFO, type AgentPermission } from '@hive/shared';
import { oneLine, type StreamNote, type Usage } from './claude';
import {
  count,
  missingFlags,
  TailReader,
  versionWarnings,
  type CliAdapter,
  type CliStream,
  type HeadlessSpec,
} from './adapter';

export const CODEX_CHECKED_VERSION = '0.164.0';
const NEEDED_FLAGS = ['--json', '--sandbox', '--skip-git-repo-check', '--ignore-user-config'];

/** Permissions that need to write in the folder (anything but reading). */
const WRITES: AgentPermission[] = [
  'editFiles',
  'runTests',
  'gitCommit',
  'gitPush',
  'installPackages',
  'runCommands',
];
/** Permissions that need the network. */
const NETWORK: AgentPermission[] = ['webAccess', 'gitPush', 'installPackages'];

/**
 * Codex has no per-command allow-list: the agent's permissions become its sandbox. Nothing but
 * reading: read-only. Anything that writes: workspace-write (edits in the folder). Web access,
 * git push or installing packages: network on. Commands always run, inside the sandbox.
 */
export function codexSandbox(perms: readonly AgentPermission[]): {
  sandbox: 'read-only' | 'workspace-write';
  network: boolean;
} {
  return {
    sandbox: perms.some((p) => WRITES.includes(p)) ? 'workspace-write' : 'read-only',
    network: perms.some((p) => NETWORK.includes(p)),
  };
}

/** A TOML value for `-c key=value` (TOML basic strings take JSON's escapes). */
const toml = (v: string | string[]) =>
  Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(',')}]` : JSON.stringify(v);

/**
 * One headless run: `codex exec --json`, only the run's Hivenod MCP server (the person's
 * config.toml is not loaded; their login still is), no approval prompts, the sandbox from the
 * permissions. The prompt goes last, after `--`.
 */
export function codexArgs(
  spec: Pick<HeadlessSpec, 'prompt' | 'mcp' | 'permissions' | 'model'>,
): string[] {
  const { sandbox, network } = codexSandbox(spec.permissions);
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--sandbox',
    sandbox,
    '-c',
    'approval_policy="never"',
    '-c',
    `mcp_servers.hivenod.command=${toml(spec.mcp.command)}`,
    '-c',
    `mcp_servers.hivenod.args=${toml(spec.mcp.args)}`,
    '-c',
    'mcp_servers.hivenod.default_tools_approval_mode="approve"',
    '-c',
    'mcp_servers.hivenod.required=true',
    ...(sandbox === 'workspace-write'
      ? ['-c', `sandbox_workspace_write.network_access=${network}`]
      : []),
    ...(spec.model ? ['-m', spec.model] : []),
    '--',
    spec.prompt,
  ];
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/** OpenAI counts cached input inside input_tokens; output includes reasoning. */
function toUsage(u: CodexUsage, model: string | null): Usage {
  return {
    tokensIn: count(u.input_tokens),
    tokensCached: Math.min(count(u.cached_input_tokens), count(u.input_tokens)),
    tokensOut: count(u.output_tokens),
    model,
    // Codex reports no cost (ChatGPT plans are not billed per token); cost logic is out of scope.
    costUsd: 0,
  };
}

const ymd = (d: Date) => [
  String(d.getFullYear()),
  String(d.getMonth() + 1).padStart(2, '0'),
  String(d.getDate()).padStart(2, '0'),
];

/** The session file of a thread: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl. */
export function findRollout(threadId: string, home: string, days: Date[]): string | null {
  for (const d of days) {
    const dir = join(home, 'sessions', ...ymd(d));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(`${threadId}.jsonl`));
    if (hit) return join(dir, hit);
  }
  return null;
}

function itemNote(
  item: Record<string, unknown>,
  phase: 'started' | 'completed',
): StreamNote | null {
  const type = item.type;
  if (type === 'agent_message' && phase === 'completed' && typeof item.text === 'string') {
    const t = oneLine(item.text);
    return t ? { kind: 'text', text: t } : null;
  }
  // Codex reports an applied patch once, when it is done.
  if (type === 'file_change' && phase === 'completed' && Array.isArray(item.changes)) {
    const files = (item.changes as { path?: string }[])
      .map((c) => (c.path ?? '').split('/').pop())
      .filter(Boolean);
    return {
      kind: 'tool',
      text: `edit ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`,
    };
  }
  if (phase !== 'started') return null;
  if (type === 'command_execution' && typeof item.command === 'string')
    return { kind: 'tool', text: `$ ${oneLine(item.command, 80)}` };
  if (type === 'mcp_tool_call' && typeof item.tool === 'string')
    return {
      kind: 'tool',
      text: `${item.server === 'hivenod' ? 'hivenod' : String(item.server ?? 'mcp')} ${item.tool}`,
    };
  if (type === 'web_search' && typeof item.query === 'string')
    return { kind: 'tool', text: `web search ${oneLine(item.query, 60)}` };
  return null;
}

/**
 * Reads `codex exec --json` lines. Tokens arrive with turn.completed (one turn per exec); while it
 * runs, poll() reads running totals and the model from the thread's session file, if found.
 */
export class CodexStream implements CliStream {
  sessionId: string | null = null;
  result: CliStream['result'] = null;
  private final: CodexUsage | null = null;
  private running: CodexUsage | null = null;
  private fileModel: string | null = null;
  private readonly rollout = new TailReader();
  private readonly days: Date[];

  constructor(
    private readonly model: string | null = null,
    private readonly home = codexHome(),
    started = new Date(),
  ) {
    // A run that passes midnight writes into the day it started.
    this.days = [started, new Date(started.getTime() + 86_400_000)];
  }

  push(line: string): StreamNote[] {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    switch (e.type) {
      case 'thread.started':
        if (typeof e.thread_id === 'string') this.sessionId = e.thread_id;
        return [];
      case 'item.started':
      case 'item.completed': {
        const note = itemNote(
          (e.item ?? {}) as Record<string, unknown>,
          e.type === 'item.started' ? 'started' : 'completed',
        );
        return note ? [note] : [];
      }
      case 'turn.completed': {
        const u = (e.usage ?? {}) as CodexUsage;
        const prev = this.final ?? {};
        // Several turns (exec resume) add up.
        this.final = {
          input_tokens: count(prev.input_tokens) + count(u.input_tokens),
          cached_input_tokens: count(prev.cached_input_tokens) + count(u.cached_input_tokens),
          output_tokens: count(prev.output_tokens) + count(u.output_tokens),
        };
        this.result = { isError: false, text: '', denials: [] };
        return [];
      }
      case 'turn.failed': {
        const err = (e.error ?? {}) as { message?: string };
        this.result = { isError: true, text: err.message ?? 'the turn failed', denials: [] };
        return [];
      }
      case 'error':
        if (typeof e.message === 'string') {
          this.result = { isError: true, text: e.message, denials: [] };
          return [{ kind: 'text', text: `error: ${oneLine(e.message)}` }];
        }
        return [];
      default:
        return [];
    }
  }

  poll(): void {
    if (!this.sessionId) return;
    if (!this.rollout.path) this.rollout.path = findRollout(this.sessionId, this.home, this.days);
    for (const line of this.rollout.lines()) {
      let e: { type?: string; payload?: Record<string, unknown> };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      const p = e.payload ?? {};
      if (e.type === 'turn_context' && typeof p.model === 'string') this.fileModel = p.model;
      if (e.type === 'event_msg' && p.type === 'token_count') {
        const info = (p.info ?? {}) as { total_token_usage?: CodexUsage };
        if (info.total_token_usage) this.running = info.total_token_usage;
      }
    }
  }

  usage(): Usage {
    const model = this.model ?? this.fileModel;
    return toUsage(this.final ?? this.running ?? {}, model);
  }
}

export const codexAdapter: CliAdapter = {
  id: 'codex',
  name: CLI_INFO.codex.name,
  experimental: true,
  bin: 'codex',
  binEnv: 'HIVENOD_CODEX_BIN',
  checkedVersion: CODEX_CHECKED_VERSION,
  // "codex-cli 0.164.0"
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null,
  helpArgs: ['exec', '--help'],
  preflight: (version, help) => ({
    errors: missingFlags('codex exec', help, NEEDED_FLAGS, {
      found: version,
      checked: CODEX_CHECKED_VERSION,
      cli: 'Codex',
    }),
    warnings: versionWarnings('Codex', version, CODEX_CHECKED_VERSION),
  }),
  interactive: false,
  envTokenOnly:
    "the commands Codex runs can read any file you can, including the saved token in ~/.hivenod/agent.json (Codex's deny_read could not be verified to block that)",
  headless(spec) {
    return {
      args: codexArgs(spec),
      stream: new CodexStream(spec.model ?? null),
    };
  },
  headlessLine:
    '  Headless: Codex runs unattended (codex exec); Hivenod gives it a fixed sandbox (edits in this folder, no network).',
  permissionsLine:
    "Permissions: Hivenod's fixed defaults (Codex does not read your Claude Code settings): workspace-write sandbox, network off",
  notes: [
    '  ! EXPERIMENTAL, untested with a real account. Commands always run inside the sandbox; Codex can read files outside this folder, so Hivenod runs it only with HIVENOD_TOKEN, never a saved token.',
  ],
};
