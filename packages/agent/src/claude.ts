/**
 * The Claude Code adapter for `hivenod run claude` (card MkUwvyWs): the command line for one
 * headless run, the agent's allow-list as Claude permission rules, and a parser for Claude's
 * stream-json output (session, model, token usage, short progress lines for the terminal).
 * Verified against Claude Code 2.1.310 on the Hivenod VM (plan wIQIiEIr, section 4).
 */
/** Hivenod tools are always allowed; read-only file tools too (they change nothing). */
const ALWAYS = ['mcp__hivenod__*', 'Read', 'Glob', 'Grep', 'TodoWrite'];

/**
 * What Claude may do on the person's machine is theirs to decide (their Claude Code settings:
 * `permissions.allow/deny`, default mode). Hivenod only adds what it needs itself: its own tools and
 * reading files, in a headless run where nobody can answer a prompt.
 */
export function allowedTools(): string[] {
  return [...ALWAYS];
}

export interface ClaudeRunSpec {
  prompt: string;
  /** JSON of the run-scoped MCP config ({ mcpServers: { hivenod: … } }). */
  mcpConfig: string;
  model?: string;
  /** Folders the model may not read or change with Claude's file tools (Hivenod's own folders). */
  deniedPaths?: readonly string[];
  /** The person's own Claude arguments (`hivenod run claude -- <args>`), already validated. */
  extraArgs?: readonly string[];
}

/**
 * Claude flags Hivenod sets itself (or that would break a run it supervises): refused after `--`
 * (checked against `claude --help`, Claude Code 2.1.310). Additive flags such as --allowedTools,
 * --disallowedTools, --add-dir, --effort, --system-prompt are fine: Hivenod's own flags come last
 * and its deny rules can only be added to.
 */
const REFUSED_LONG: Record<string, string> = {
  '--print': 'Hivenod runs Claude headless or interactive itself',
  '--session-id': 'Hivenod sets the session',
  '--name': 'Hivenod names the session',
  '--remote-control': 'Hivenod starts Remote Control itself',
  '--remote-control-session-name-prefix': 'Hivenod starts Remote Control itself',
  '--mcp-config': 'Hivenod gives Claude its own Hivenod tools',
  '--strict-mcp-config': 'use hivenod run claude --clean',
  '--settings': 'Hivenod passes its own session settings',
  '--append-system-prompt': 'Hivenod appends the run rules',
  '--output-format': 'Hivenod reads Claude output itself',
  '--input-format': 'Hivenod reads Claude output itself',
  '--permission-prompts': 'Hivenod sets who answers prompts',
  '--resume': 'every item is a fresh session',
  '--continue': 'every item is a fresh session',
  '--fork-session': 'every item is a fresh session',
  '--from-pr': 'every item is a fresh session',
  '--background': 'Hivenod needs Claude in the foreground',
  '--bg': 'Hivenod needs Claude in the foreground',
  '--cloud': 'Hivenod needs Claude on this machine',
  '--teleport': 'Hivenod needs Claude on this machine',
  '--desktop': 'Hivenod needs Claude in this terminal',
  '--tmux': 'Hivenod needs Claude in this terminal',
  '--no-session-persistence': 'Hivenod reads tokens from the session log',
  '--help': 'it would not run the item',
  '--version': 'it would not run the item',
};
const REFUSED_SHORT: Record<string, string> = {
  p: '--print',
  n: '--name',
  c: '--continue',
  r: '--resume',
  h: '--help',
  v: '--version',
};
const PERMISSION_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
];

const flagName = (a: string) => (a.startsWith('--') ? a.split('=')[0]! : a);

/** What is wrong with the arguments after `--`, or null. `hiveModel`: --model was also given to hive. */
export function claudeArgsProblem(extra: readonly string[], hiveModel?: string): string | null {
  for (const a of extra) {
    const f = flagName(a);
    const why = REFUSED_LONG[f];
    if (why) return `${f} is set by Hivenod and cannot be passed after -- (${why}).`;
    if (/^-[A-Za-z]+(=.*)?$/s.test(a)) {
      const hit = [...a.slice(1).split('=')[0]!].find((c) => REFUSED_SHORT[c]);
      if (hit)
        return `-${hit} (${REFUSED_SHORT[hit]}) is set by Hivenod and cannot be passed after --.`;
    }
    if (f === '--model' && hiveModel)
      return '--model was given twice (hivenod run claude --model and after --). Use one.';
  }
  return null;
}

/** True when the person passed a permission flag (then Hivenod does not force headless dontAsk). */
export function hasPermissionFlag(extra: readonly string[]): boolean {
  return extra.some((a) => PERMISSION_FLAGS.includes(flagName(a)));
}

/** True when the arguments turn on bypass permissions (YOLO). */
export function isBypass(extra: readonly string[]): boolean {
  return extra.some(
    (a, i) =>
      a === '--dangerously-skip-permissions' ||
      (flagName(a) === '--permission-mode' &&
        (a.split('=')[1] ?? extra[i + 1]) === 'bypassPermissions'),
  );
}

/** Flags whose value is harmless to print. Every other flag's value is hidden. */
const LOGGED_VALUE_FLAGS = new Set(['--model', '--effort', '--permission-mode', '--add-dir']);
/** Flags without a value, safe to print (a value after them would be a positional, hidden). */
const LOGGED_BOOLEAN_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--verbose',
  '--debug',
  '--ide',
  '--chrome',
  '--no-chrome',
  '--fork-session',
  '--disable-slash-commands',
]);

/**
 * The arguments for the terminal and the run log. Allow-list: only the values of known harmless
 * flags are shown; every other value, `--flag=value` form, JSON blob and bare argument is ***.
 */
export function describeExtraArgs(extra: readonly string[]): string {
  const out: string[] = [];
  const safeName = (f: string) => /^--?[A-Za-z][\w-]{0,40}$/.test(f);
  const show = (v: string) => (/^[\w@%+:,./~-]+$/.test(v) ? v : JSON.stringify(v));
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i]!;
    if (!a.startsWith('-')) {
      out.push('***');
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!safeName(name)) {
      out.push('***');
      continue;
    }
    const hasInline = eq > 0;
    if (LOGGED_BOOLEAN_FLAGS.has(name) && !hasInline) {
      out.push(name);
    } else if (LOGGED_VALUE_FLAGS.has(name)) {
      if (hasInline) out.push(`${name}=${show(a.slice(eq + 1))}`);
      else if (i + 1 < extra.length && !extra[i + 1]!.startsWith('-'))
        out.push(name, show(extra[++i]!));
      else out.push(name);
    } else if (hasInline) {
      out.push(`${name}=***`);
    } else {
      out.push(name);
      if (i + 1 < extra.length && !extra[i + 1]!.startsWith('-')) {
        out.push('***');
        i++;
      }
    }
  }
  const text = out.join(' ');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * Deny rules for folders, for Claude's file tools (Read rules also cover Grep and Glob; Edit
 * rules cover Write and NotebookEdit). `//` starts an absolute path in Claude permission rules.
 */
export function deniedTools(paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    const abs = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const rule = `/${abs.startsWith('/') ? abs : `/${abs}`}/**`;
    return [`Read(${rule})`, `Edit(${rule})`];
  });
}

/**
 * One headless run: print mode, streamed JSON, only the Hivenod MCP server, permission mode
 * dontAsk (anything not on the allow-list is denied automatically, no prompt) unless the person
 * passed a permission flag of their own (`hivenod run claude -- --dangerously-skip-permissions`).
 */
export function claudeArgs(spec: ClaudeRunSpec): string[] {
  return [
    '-p',
    spec.prompt,
    // The person's own arguments, before Hivenod's: where a flag repeats, Hivenod's guards come last.
    ...(spec.extraArgs ?? []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    spec.mcpConfig,
    // Headless nobody can answer a prompt: deny what is not allowed, unless the person chose.
    ...(hasPermissionFlag(spec.extraArgs ?? []) ? [] : ['--permission-mode', 'dontAsk']),
    '--permission-prompts',
    'none',
    '--allowedTools',
    allowedTools().join(','),
    ...disallowed(spec),
    ...(spec.model ? ['--model', spec.model] : []),
  ];
}

function disallowed(spec: ClaudeRunSpec): string[] {
  const deny = deniedTools(spec.deniedPaths ?? []);
  return deny.length ? ['--disallowedTools', deny.join(',')] : [];
}

export interface Usage {
  /** All input tokens, cache reads and writes included. */
  tokensIn: number;
  tokensOut: number;
  /** Input tokens read from the cache (part of tokensIn; shown apart from new tokens). */
  tokensCached: number;
  model: string | null;
  /**
   * What the run cost in USD: Claude's own total (result.total_cost_usd) once the run has ended,
   * else an estimate from the tokens per model (see estimateUsd), e.g. when the CLI was stopped.
   */
  costUsd: number;
}

/** USD per million tokens (input, output), first-party API list prices (2026-10). */
const PRICES: [RegExp, number, number][] = [
  [/fable|mythos/, 10, 50],
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/haiku-5/, 0.1, 0.5],
  [/haiku/, 1, 5],
];
const FALLBACK_PRICE: [number, number] = [3, 15];

/**
 * Estimated USD for one model's tokens: cache reads at a tenth of the input price, cache writes
 * at twice it (Claude Code writes the 1-hour cache), plain input and output at list price.
 */
export function estimateUsd(
  model: string | null,
  u: { input: number; cacheRead: number; cacheWrite: number; output: number },
): number {
  const hit = model ? PRICES.find(([re]) => re.test(model)) : undefined;
  const [pin, pout] = hit ? [hit[1], hit[2]] : FALLBACK_PRICE;
  return (u.input * pin + u.cacheRead * pin * 0.1 + u.cacheWrite * pin * 2 + u.output * pout) / 1e6;
}

/** Hivenod shows cost in EUR; Claude reports USD. Approximate rate, HIVENOD_EUR_PER_USD overrides it. */
export function eurFromUsd(usd: number): number {
  const rate = Number(process.env.HIVENOD_EUR_PER_USD) || 0.86;
  return Math.round(usd * rate * 1e6) / 1e6;
}

export type StreamNote =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'rateLimit'; text: string };

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

/** "claude-opus-5-5", or "claude-opus-5-5 +1" when several models worked (most output first). */
export function modelLabel(outputsByModel: Map<string, number>): string | null {
  const sorted = [...outputsByModel.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return null;
  const [first] = sorted[0]!;
  return sorted.length > 1 ? `${first} +${sorted.length - 1}` : first;
}

export function oneLine(text: string, max = 110): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolText(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : null;
  if (name.startsWith('mcp__hivenod__')) return `hivenod ${name.slice('mcp__hivenod__'.length)}`;
  if (file) return `${name} ${file}`;
  if (name === 'Bash' && typeof input.command === 'string')
    return `$ ${oneLine(input.command, 80)}`;
  if (typeof input.pattern === 'string') return `${name} ${oneLine(input.pattern, 60)}`;
  return name;
}

/**
 * Reads Claude's stream-json lines. Usage while running is summed per message id (a message is
 * streamed as several events carrying the same usage), so it is a close running total; the final
 * `result` event's per-model usage replaces it when it arrives.
 */
export class ClaudeStream {
  sessionId: string | null = null;
  private initModel: string | null = null;
  private readonly messages = new Map<string, MsgUsage & { model: string | null }>();
  private final: Usage | null = null;
  /** Set by the result event. */
  result: { isError: boolean; text: string; denials: string[] } | null = null;

  push(line: string): StreamNote[] {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (typeof e.session_id === 'string') this.sessionId = e.session_id;
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init' && typeof e.model === 'string') this.initModel = e.model;
        return [];
      case 'assistant': {
        const m = (e.message ?? {}) as {
          id?: string;
          model?: string;
          usage?: MsgUsage;
          content?: {
            type: string;
            text?: string;
            name?: string;
            input?: Record<string, unknown>;
          }[];
        };
        if (m.id && m.usage) this.messages.set(m.id, { ...m.usage, model: m.model ?? null });
        const notes: StreamNote[] = [];
        for (const c of m.content ?? []) {
          if (c.type === 'text' && c.text) {
            const t = oneLine(c.text);
            if (t) notes.push({ kind: 'text', text: t });
          } else if (c.type === 'tool_use' && c.name) {
            notes.push({ kind: 'tool', text: toolText(c.name, c.input ?? {}) });
          }
        }
        return notes;
      }
      case 'rate_limit_event': {
        const info = (e.rate_limit_info ?? {}) as { status?: string; rateLimitType?: string };
        return info.status && info.status !== 'allowed'
          ? [
              {
                kind: 'rateLimit',
                text: `Claude usage limit (${info.rateLimitType ?? 'limit'}): ${info.status}`,
              },
            ]
          : [];
      }
      case 'result': {
        const mu = (e.modelUsage ?? {}) as Record<string, ModelUsage>;
        const outputs = new Map<string, number>();
        let tin = 0;
        let tout = 0;
        let cached = 0;
        let estimate = 0;
        for (const [model, u] of Object.entries(mu)) {
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
        if (!Object.keys(mu).length && e.usage) {
          const u = e.usage as MsgUsage;
          tin = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
          cached = n(u.cache_read_input_tokens);
          tout = n(u.output_tokens);
          estimate = this.usage().costUsd;
        }
        const total = e.total_cost_usd;
        this.final = {
          tokensIn: tin,
          tokensOut: tout,
          tokensCached: cached,
          model: modelLabel(outputs) ?? this.runningModel(),
          costUsd:
            typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : estimate,
        };
        const denials = Array.isArray(e.permission_denials)
          ? (
              e.permission_denials as { tool_name?: string; tool_input?: Record<string, unknown> }[]
            ).map((d) => toolText(d.tool_name ?? 'tool', d.tool_input ?? {}))
          : [];
        this.result = {
          isError:
            e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'),
          text: typeof e.result === 'string' ? e.result : '',
          denials,
        };
        return [];
      }
      default:
        return [];
    }
  }

  private runningModel(): string | null {
    const outputs = new Map<string, number>();
    for (const m of this.messages.values())
      if (m.model) outputs.set(m.model, (outputs.get(m.model) ?? 0) + n(m.output_tokens) + 1);
    return modelLabel(outputs) ?? this.initModel;
  }

  /** Usage so far (exact once the result event has arrived). */
  usage(): Usage {
    if (this.final) return this.final;
    let tin = 0;
    let tout = 0;
    let cached = 0;
    let costUsd = 0;
    for (const m of this.messages.values()) {
      tin += n(m.input_tokens) + n(m.cache_creation_input_tokens) + n(m.cache_read_input_tokens);
      cached += n(m.cache_read_input_tokens);
      tout += n(m.output_tokens);
      costUsd += estimateUsd(m.model ?? this.initModel, {
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
      model: this.runningModel(),
      costUsd,
    };
  }
}
