/**
 * Interactive Claude Code per item (card OPpbi0MS, Build D). Instead of `claude -p` (headless),
 * `hivenod run claude` opens a real Claude Code session in the person's terminal for each item, with
 * Remote Control on (claude.ai/code and the Claude app), the person's own setup (skills, MCP
 * servers, plugins, CLAUDE.md) plus the Hivenod item tools. Verified against Claude Code 2.1.310:
 *
 * - The command line: the prompt first (the option lists such as --allowedTools take every word
 *   after them), `--session-id` so Hivenod knows the session, `--remote-control <name>`.
 * - Permissions: the person's own Claude Code settings and default mode apply (no permission
 *   mode is forced). Only Hivenod's own tools and reading are allowed up front; a prompt shows in
 *   the terminal and on the phone. A `PermissionRequest` hook (passed with `--settings`) runs while the prompt is
 *   shown; it asks `hivenod run` over the run bridge, which answers "deny" after 10 minutes. When
 *   the person answers first, Claude ends the hook and the person's answer counts.
 * - Tokens, model, cost and the Remote Control session come from Claude's session log
 *   (`<config>/projects/<folder>/<session>.jsonl`): `assistant` entries carry each message's
 *   usage (one entry per content block, the same message id), `cost-state` entries Claude's
 *   per-model totals and cost, `bridge-session` entries the Remote Control session id.
 * - `<config>/sessions/<pid>.json` says whether the session is busy or idle (used to close it
 *   once the item is finished and Claude has stopped talking).
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { allowedTools, deniedTools, estimateUsd, modelLabel, type Usage } from './claude';

/** Claude Code's config folder (CLAUDE_CONFIG_DIR, else ~/.claude). */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** 10 minutes: an unanswered permission prompt is denied after this long. */
export const PERMISSION_TIMEOUT_MS = 10 * 60_000;

export interface InteractiveSpec {
  /** The first message: the item. */
  prompt: string;
  /** The run's rules, appended to Claude's system prompt. */
  rules: string;
  sessionId: string;
  /** JSON of the run-scoped MCP config ({ mcpServers: { hivenod: … } }). */
  mcpConfig: string;
  /** The shell command of the permission hook (`hivenod hook permission --bridge S`). */
  hookCommand: string;
  /** Seconds Claude lets the hook run (a little more than the permission timeout). */
  hookTimeoutSec: number;
  /** Shown on claude.ai/code and in the Claude app. */
  name: string;
  model?: string;
  deniedPaths?: readonly string[];
  /** Only the Hivenod MCP server (the person's own MCP servers are not loaded). */
  clean?: boolean;
  /** The person's own Claude arguments (`hivenod run claude -- <args>`), already validated. */
  extraArgs?: readonly string[];
}

/**
 * Settings for this session only: the permission hook, and auto mode off (Claude's permission
 * prompt offers "switch to auto mode", which would let a person at the terminal skip the
 * allow-list; `disableBypassPermissionsMode` does not cover it). The person's own settings
 * otherwise rule.
 */
export function sessionSettings(hookCommand: string, timeoutSec: number): string {
  return JSON.stringify({
    permissions: { disableAutoMode: 'disable' },
    hooks: {
      PermissionRequest: [
        { matcher: '', hooks: [{ type: 'command', command: hookCommand, timeout: timeoutSec }] },
      ],
    },
  });
}

export function interactiveArgs(spec: InteractiveSpec): string[] {
  const deny = deniedTools(spec.deniedPaths ?? []);
  return [
    // First: the option lists below are variadic and would swallow a prompt placed after them.
    spec.prompt,
    // The person's own arguments, before Hivenod's: where a flag repeats, Hivenod's guards come last.
    ...(spec.extraArgs ?? []),
    '--session-id',
    spec.sessionId,
    '--name',
    spec.name,
    '--remote-control',
    spec.name,
    '--append-system-prompt',
    spec.rules,
    '--mcp-config',
    spec.mcpConfig,
    ...(spec.clean ? ['--strict-mcp-config'] : []),
    '--settings',
    sessionSettings(spec.hookCommand, spec.hookTimeoutSec),
    '--allowedTools',
    allowedTools().join(','),
    ...(deny.length ? ['--disallowedTools', deny.join(',')] : []),
    ...(spec.model ? ['--model', spec.model] : []),
  ];
}

/** POSIX shell quoting for the hook command. */
export function shellQuote(parts: readonly string[]): string {
  return parts
    .map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** The Remote Control link for a bridge session id (`cse_…` in the log, `session_…` in links). */
export function remoteUrl(bridgeSessionId: string): string | null {
  const m = /^(?:cse_|session_)([A-Za-z0-9]{8,64})$/.exec(bridgeSessionId);
  return m ? `https://claude.ai/code/session_${m[1]}` : null;
}

/**
 * Environment for the item's Claude: without the Hivenod token, and without the markers of a Claude
 * session that may have started `hivenod run` (they would make it a child session that saves no
 * session log, so no tokens could be read).
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.HIVENOD_TOKEN;
  delete out.HIVENOD_TOKEN_FILE;
  // A token left over from the old `hive` CLI still works server-side: never pass it on either.
  delete out.HIVE_TOKEN;
  delete out.HIVE_TOKEN_FILE;
  for (const k of Object.keys(out))
    if (
      k === 'CLAUDECODE' ||
      k === 'CLAUDE_PID' ||
      (k.startsWith('CLAUDE_CODE_') &&
        k !== 'CLAUDE_CODE_USE_BEDROCK' &&
        k !== 'CLAUDE_CODE_USE_VERTEX')
    )
      delete out[k];
  return out;
}

/** Where Claude writes this session's log, once it exists. */
export function findSessionLog(sessionId: string, configDir = claudeConfigDir()): string | null {
  const root = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** Busy, idle or waiting (e.g. "permission prompt"), from `<config>/sessions/<pid>.json`. */
export function sessionStatus(
  pid: number,
  configDir = claudeConfigDir(),
): { status: string | null; waitingFor: string | null } | null {
  try {
    const d = JSON.parse(readFileSync(join(configDir, 'sessions', `${pid}.json`), 'utf8')) as {
      status?: unknown;
      waitingFor?: unknown;
    };
    return {
      status: typeof d.status === 'string' ? d.status : null,
      waitingFor: typeof d.waitingFor === 'string' ? d.waitingFor : null,
    };
  } catch {
    return null;
  }
}

interface MsgUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}
const n = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/**
 * Reads a session log as it grows (only the new bytes each time). Fails soft: lines it does not
 * understand are skipped, and `readable` says whether the log was found at all.
 */
export class SessionLog {
  private path: string | null = null;
  private offset = 0;
  private rest = '';
  private readonly messages = new Map<string, MsgUsage & { model: string | null }>();
  private costState: {
    modelUsage: Record<string, ModelUsage>;
    totalCostUSD: number | null;
  } | null = null;
  bridgeSessionId: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly configDir = claudeConfigDir(),
  ) {}

  get readable(): boolean {
    return this.path !== null;
  }

  /** Reads what was added since the last call. */
  poll(): void {
    this.path ??= findSessionLog(this.sessionId, this.configDir);
    if (!this.path) return;
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(1 << 16);
      for (;;) {
        const got = readSync(fd, buf, 0, buf.length, this.offset);
        if (got <= 0) break;
        this.offset += got;
        this.rest += buf.subarray(0, got).toString('utf8');
        const lines = this.rest.split('\n');
        this.rest = lines.pop() ?? '';
        for (const l of lines) this.line(l);
      }
    } finally {
      closeSync(fd);
    }
  }

  private line(line: string): void {
    // Request bodies are logged too; only short entries and assistant messages matter here.
    if (!/"type":"(assistant|cost-state|bridge-session)"/.test(line)) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (e.sessionId !== undefined && e.sessionId !== this.sessionId) return;
    switch (e.type) {
      case 'assistant': {
        const m = (e.message ?? {}) as { id?: string; model?: string; usage?: MsgUsage };
        if (m.id && m.usage && m.model !== '<synthetic>')
          this.messages.set(m.id, { ...m.usage, model: m.model ?? null });
        return;
      }
      case 'cost-state': {
        const mu = e.modelUsage;
        if (mu && typeof mu === 'object')
          this.costState = {
            modelUsage: mu as Record<string, ModelUsage>,
            totalCostUSD: typeof e.totalCostUSD === 'number' ? e.totalCostUSD : null,
          };
        return;
      }
      case 'bridge-session':
        if (typeof e.bridgeSessionId === 'string') this.bridgeSessionId = e.bridgeSessionId;
        return;
      default:
        return;
    }
  }

  /**
   * Usage so far. Claude's own totals (cost-state, what it charges, side calls included) when it
   * has written them and they are not behind the messages; else the sum of the messages.
   */
  usage(): Usage {
    const fromMessages = this.messageUsage();
    const cs = this.costState;
    if (cs) {
      const outputs = new Map<string, number>();
      let tin = 0;
      let tout = 0;
      let cached = 0;
      let estimate = 0;
      for (const [model, u] of Object.entries(cs.modelUsage)) {
        tin += n(u.inputTokens) + n(u.cacheReadInputTokens) + n(u.cacheCreationInputTokens);
        cached += n(u.cacheReadInputTokens);
        tout += n(u.outputTokens);
        outputs.set(model, n(u.outputTokens));
        estimate +=
          typeof u.costUSD === 'number' && u.costUSD >= 0
            ? u.costUSD
            : estimateUsd(model, {
                input: n(u.inputTokens),
                cacheRead: n(u.cacheReadInputTokens),
                cacheWrite: n(u.cacheCreationInputTokens),
                output: n(u.outputTokens),
              });
      }
      if (tout >= fromMessages.tokensOut && tin >= fromMessages.tokensIn)
        return {
          tokensIn: tin,
          tokensOut: tout,
          tokensCached: cached,
          model: modelLabel(outputs) ?? fromMessages.model,
          costUsd: cs.totalCostUSD !== null && cs.totalCostUSD >= 0 ? cs.totalCostUSD : estimate,
        };
    }
    return fromMessages;
  }

  private messageUsage(): Usage {
    let tin = 0;
    let tout = 0;
    let cached = 0;
    let costUsd = 0;
    const outputs = new Map<string, number>();
    for (const m of this.messages.values()) {
      tin += n(m.input_tokens) + n(m.cache_creation_input_tokens) + n(m.cache_read_input_tokens);
      cached += n(m.cache_read_input_tokens);
      tout += n(m.output_tokens);
      if (m.model) outputs.set(m.model, (outputs.get(m.model) ?? 0) + n(m.output_tokens) + 1);
      costUsd += estimateUsd(m.model, {
        input: n(m.input_tokens),
        cacheRead: n(m.cache_read_input_tokens),
        cacheWrite: n(m.cache_creation_input_tokens),
        output: n(m.output_tokens),
      });
    }
    return {
      tokensIn: tin,
      tokensOut: tout,
      tokensCached: cached,
      model: modelLabel(outputs),
      costUsd,
    };
  }
}

/** What the permission hook prints for Claude: deny, with the reason shown to Claude. */
export function hookDecision(answer: unknown): string {
  const a = (answer ?? {}) as { behavior?: unknown; message?: unknown };
  if (a.behavior !== 'deny') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: typeof a.message === 'string' ? a.message : 'Denied by Hivenod.',
      },
    },
  });
}

/** A short description of the tool call a permission prompt is about (for the run log). */
export function describeRequest(input: unknown): string {
  const r = (input ?? {}) as { tool_name?: unknown; tool_input?: unknown };
  const tool = typeof r.tool_name === 'string' ? r.tool_name.slice(0, 80) : 'a tool';
  const ti = (r.tool_input ?? {}) as Record<string, unknown>;
  const detail =
    typeof ti.command === 'string'
      ? ti.command
      : typeof ti.file_path === 'string'
        ? ti.file_path
        : typeof ti.url === 'string'
          ? ti.url
          : '';
  const one = detail.split('\n')[0]!.trim();
  return one ? `${tool}: ${one.length > 120 ? `${one.slice(0, 119)}…` : one}` : tool;
}
