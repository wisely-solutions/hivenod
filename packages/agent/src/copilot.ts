/**
 * EXPERIMENTAL, UNTESTED with a real account: the GitHub Copilot CLI adapter for `hivenod run copilot`
 * (card 3RiuFK00). Every item spends the person's GitHub AI Credits. Checked against Copilot CLI
 * 1.0.103 without signing in:
 *   - `copilot --help` / `copilot help permissions|monitoring|environment`: -p, --output-format json,
 *     --no-ask-user, --no-auto-update, --disable-builtin-mcps, --additional-mcp-config,
 *     --allow-tool / --deny-tool (kinds shell(…), write, <mcp server>, url; deny wins),
 *     --usage-output-file, COPILOT_OTEL_FILE_EXPORTER_PATH, COPILOT_ALLOW_ALL.
 *   - The full command line below parses (it stops at "No authentication information found").
 *   - The MCP config shape ({ mcpServers: { hivenod: { type: 'local', command, args, tools } } }) is
 *     accepted (`copilot mcp list --json`).
 *   - The usage file's top level (totalPremiumRequestCost, totalNanoAiu, modelMetrics, …) was
 *     written by that run; per-model usage (inputTokens incl. cache, outputTokens, cacheReadTokens,
 *     cacheWriteTokens) and the JSON stream's final `result` line (sessionId, exitCode) are from
 *     the 1.0.103 package source. The JSON stream leaves token usage out (assistant.usage is
 *     filtered), so running totals come from the OpenTelemetry file.
 * UNVERIFIED (no real run): the event shapes other than `result`, the OpenTelemetry file format
 * and its attribute names, that -p works with explicit --allow-tool rules and no --allow-all-tools
 * (its help says that flag is "required for non-interactive mode"), and multi-word shell patterns
 * such as shell(npm test:*).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_INFO, type AgentPermission } from '@hive/shared';
import { modelLabel, oneLine, type StreamNote, type Usage } from './claude';
import {
  count,
  missingFlags,
  TailReader,
  versionWarnings,
  type CliAdapter,
  type CliStream,
  type HeadlessSpec,
} from './adapter';

export const COPILOT_CHECKED_VERSION = '1.0.103';
const NEEDED_FLAGS = [
  '--output-format',
  '--no-ask-user',
  '--additional-mcp-config',
  '--allow-tool',
  '--deny-tool',
  '--usage-output-file',
];

/** Copilot permission patterns for each Hivenod permission. */
const RULES: Record<AgentPermission, string[]> = {
  editFiles: ['write'],
  runTests: [
    'shell(npm test:*)',
    'shell(npm run test:*)',
    'shell(npm run lint:*)',
    'shell(npm run build:*)',
    'shell(npm run typecheck:*)',
    'shell(pnpm test:*)',
    'shell(pnpm run test:*)',
    'shell(pnpm lint:*)',
    'shell(pnpm build:*)',
    'shell(pnpm typecheck:*)',
    'shell(pnpm exec vitest:*)',
    'shell(npx vitest:*)',
    'shell(yarn test:*)',
    'shell(pytest:*)',
    'shell(python -m pytest:*)',
    'shell(go test:*)',
    'shell(cargo test:*)',
    'shell(make test:*)',
  ],
  // Copilot approves git per first-level subcommand ("git push").
  gitCommit: [
    'shell(git status)',
    'shell(git diff)',
    'shell(git log)',
    'shell(git add)',
    'shell(git commit)',
    'shell(git switch)',
    'shell(git checkout)',
    'shell(git branch)',
  ],
  gitPush: ['shell(git push)', 'shell(git fetch)', 'shell(git pull)'],
  installPackages: [
    'shell(npm install:*)',
    'shell(npm ci:*)',
    'shell(pnpm install:*)',
    'shell(pnpm add:*)',
    'shell(yarn install:*)',
    'shell(yarn add:*)',
    'shell(pip install:*)',
  ],
  runCommands: ['shell'],
  webAccess: ['url'],
};

/** The run's Hivenod MCP server, all of its tools. Reading files needs no rule. */
const ALWAYS = ['hivenod'];

export function copilotAllowed(perms: readonly AgentPermission[]): string[] {
  return [...new Set([...ALWAYS, ...perms.flatMap((p) => RULES[p] ?? [])])];
}

/** Kinds with no rule at all are denied outright (deny wins over every allow). */
export function copilotDenied(perms: readonly AgentPermission[]): string[] {
  const allowed = copilotAllowed(perms);
  return ['shell', 'write', 'url'].filter(
    (k) => !allowed.some((a) => a === k || a.startsWith(`${k}(`)),
  );
}

export const usageFile = (dir: string) => join(dir, 'copilot-usage.json');
export const otelFile = (dir: string) => join(dir, 'copilot-otel.jsonl');

/**
 * One headless run: prompt mode, JSON lines, no questions to a person, no self-update, no
 * built-in GitHub MCP servers, the run's Hivenod MCP server, the allow-list as --allow-tool rules
 * (anything else is denied, not asked), usage to a file in the run's temp folder. Copilot keeps
 * file tools inside this folder (no --allow-all-paths), so Hivenod's credentials stay out of reach
 * of its file tools; a granted shell can still read them.
 */
export function copilotArgs(
  spec: Pick<HeadlessSpec, 'prompt' | 'mcp' | 'permissions' | 'model' | 'dir'>,
): string[] {
  const mcp = {
    mcpServers: {
      hivenod: {
        type: 'local',
        command: spec.mcp.command,
        args: spec.mcp.args,
        env: {},
        tools: ['*'],
      },
    },
  };
  return [
    `--prompt=${spec.prompt}`,
    '--output-format=json',
    '--no-ask-user',
    '--no-auto-update',
    '--disable-builtin-mcps',
    `--additional-mcp-config=${JSON.stringify(mcp)}`,
    ...copilotAllowed(spec.permissions).map((r) => `--allow-tool=${r}`),
    ...copilotDenied(spec.permissions).map((r) => `--deny-tool=${r}`),
    `--usage-output-file=${usageFile(spec.dir)}`,
    ...(spec.model ? [`--model=${spec.model}`] : []),
  ];
}

/** Environment: the OpenTelemetry file (running token totals), and nothing that grants all. */
export function copilotEnv(dir: string): Record<string, string | undefined> {
  return {
    COPILOT_OTEL_FILE_EXPORTER_PATH: otelFile(dir),
    COPILOT_OTEL_EXPORTER_TYPE: 'file',
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
    COPILOT_AUTO_UPDATE: 'false',
    // A person's COPILOT_ALLOW_ALL would approve every tool and bypass the allow-list.
    COPILOT_ALLOW_ALL: undefined,
  };
}

type Attr = { key?: string; value?: Record<string, unknown> };

/** OTel attributes as a flat map: OTLP JSON ([{ key, value: { intValue } }]) or a plain object. */
function attributes(a: unknown): Record<string, unknown> {
  if (Array.isArray(a)) {
    const out: Record<string, unknown> = {};
    for (const x of a as Attr[]) {
      if (!x?.key || !x.value) continue;
      const v = Object.values(x.value)[0];
      out[x.key] = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    }
    return out;
  }
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
}

interface ModelCall {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
}

/** Model calls (spans with GenAI token attributes) anywhere in one OTel JSON line. */
export function otelCalls(line: string): { id: string | null; call: ModelCall }[] {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch {
    return [];
  }
  const found: { id: string | null; call: ModelCall }[] = [];
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    const rec = o as Record<string, unknown>;
    if ('attributes' in rec) {
      const at = attributes(rec.attributes);
      if ('gen_ai.usage.input_tokens' in at || 'gen_ai.usage.output_tokens' in at) {
        const model = at['gen_ai.response.model'] ?? at['gen_ai.request.model'];
        const id = rec.spanId ?? rec.span_id ?? (rec.context as { span_id?: unknown })?.span_id;
        found.push({
          id: typeof id === 'string' ? id : null,
          call: {
            model: typeof model === 'string' ? model : null,
            input: count(at['gen_ai.usage.input_tokens']),
            output: count(at['gen_ai.usage.output_tokens']),
            cacheRead: count(at['gen_ai.usage.cache_read.input_tokens']),
          },
        });
        return;
      }
    }
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  walk(root, 0);
  return found;
}

interface ModelMetric {
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

/** The usage file Copilot writes when it ends (--usage-output-file). */
export function usageFromFile(text: string): Usage | null {
  let u: { modelMetrics?: Record<string, ModelMetric> };
  try {
    u = JSON.parse(text) as typeof u;
  } catch {
    return null;
  }
  if (!u || typeof u !== 'object' || !u.modelMetrics) return null;
  const outputs = new Map<string, number>();
  let tin = 0;
  let tout = 0;
  let cached = 0;
  for (const [model, m] of Object.entries(u.modelMetrics)) {
    tin += count(m.usage?.inputTokens);
    tout += count(m.usage?.outputTokens);
    cached += count(m.usage?.cacheReadTokens);
    outputs.set(model, count(m.usage?.outputTokens));
  }
  return {
    tokensIn: tin,
    tokensOut: tout,
    tokensCached: Math.min(cached, tin),
    model: modelLabel(outputs),
    // Copilot bills AI Credits, not a USD price per token; cost logic is out of scope.
    costUsd: 0,
  };
}

function toolNote(name: string, args: unknown): StreamNote {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (/^hivenod[-_.]/.test(name)) return { kind: 'tool', text: `hivenod ${name.slice(8)}` };
  if (typeof a.command === 'string') return { kind: 'tool', text: `$ ${oneLine(a.command, 80)}` };
  const file = typeof a.path === 'string' ? a.path.split('/').pop() : null;
  return { kind: 'tool', text: file ? `${name} ${file}` : name };
}

/**
 * Reads `copilot -p … --output-format json` lines (progress and the final result), the
 * OpenTelemetry file (running totals while it works) and the usage file (exact, at the end).
 */
export class CopilotStream implements CliStream {
  sessionId: string | null = null;
  result: CliStream['result'] = null;
  private final: Usage | null = null;
  private readonly calls = new Map<string, ModelCall>();
  private anon = 0;
  private readonly otel: TailReader;

  constructor(
    private readonly dir: string,
    private readonly model: string | null = null,
  ) {
    this.otel = new TailReader(otelFile(dir));
  }

  push(line: string): StreamNote[] {
    let e: { type?: string; data?: Record<string, unknown> } & Record<string, unknown>;
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return [];
    }
    const d = e.data ?? {};
    if (typeof e.sessionId === 'string') this.sessionId = e.sessionId;
    switch (e.type) {
      case 'assistant.message': {
        const t = typeof d.content === 'string' ? oneLine(d.content) : '';
        return t ? [{ kind: 'text', text: t }] : [];
      }
      case 'tool.execution_start':
        return typeof d.toolName === 'string' ? [toolNote(d.toolName, d.arguments)] : [];
      case 'session.error': {
        const m = typeof d.message === 'string' ? d.message : 'error';
        return [{ kind: 'text', text: `error: ${oneLine(m)}` }];
      }
      case 'result': {
        const code = typeof e.exitCode === 'number' ? e.exitCode : 0;
        this.result = {
          isError: code !== 0,
          text: code !== 0 ? `Copilot ended with exit code ${code}` : '',
          denials: [],
        };
        return [];
      }
      default:
        return [];
    }
  }

  poll(): void {
    for (const line of this.otel.lines())
      for (const { id, call } of otelCalls(line)) this.calls.set(id ?? `#${this.anon++}`, call);
    if (!this.final) {
      try {
        this.final = usageFromFile(readFileSync(usageFile(this.dir), 'utf8'));
      } catch {
        /* not written yet */
      }
    }
  }

  usage(): Usage {
    if (this.final)
      return { ...this.final, model: this.model ?? this.final.model ?? this.runningModel() };
    let tin = 0;
    let tout = 0;
    let cached = 0;
    for (const c of this.calls.values()) {
      tin += c.input;
      tout += c.output;
      cached += c.cacheRead;
    }
    return {
      tokensIn: tin,
      tokensOut: tout,
      tokensCached: Math.min(cached, tin),
      model: this.model ?? this.runningModel(),
      costUsd: 0,
    };
  }

  private runningModel(): string | null {
    const outputs = new Map<string, number>();
    for (const c of this.calls.values())
      if (c.model) outputs.set(c.model, (outputs.get(c.model) ?? 0) + c.output + 1);
    return modelLabel(outputs);
  }
}

export const copilotAdapter: CliAdapter = {
  id: 'copilot',
  name: CLI_INFO.copilot.name,
  experimental: true,
  bin: 'copilot',
  binEnv: 'HIVENOD_COPILOT_BIN',
  checkEnv: { COPILOT_AUTO_UPDATE: 'false' },
  checkedVersion: COPILOT_CHECKED_VERSION,
  // "GitHub Copilot CLI 1.0.103."
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null,
  helpArgs: ['--help'],
  preflight: (version, help) => ({
    errors: missingFlags('copilot', help, NEEDED_FLAGS, {
      found: version,
      checked: COPILOT_CHECKED_VERSION,
      cli: 'GitHub Copilot CLI',
    }),
    warnings: versionWarnings('GitHub Copilot CLI', version, COPILOT_CHECKED_VERSION),
  }),
  interactive: false,
  headless(spec) {
    return {
      args: copilotArgs(spec),
      env: copilotEnv(spec.dir),
      stream: new CopilotStream(spec.dir, spec.model ?? null),
    };
  },
  headlessLine:
    "  Headless: Copilot runs unattended (copilot -p); tools off Hivenod's fixed rules are denied.",
  permissionsLine:
    "Permissions: Hivenod's fixed defaults (Copilot does not read your Claude Code settings): edit files, run tests, git commit",
  notes: [
    '  ! EXPERIMENTAL, untested with a real account. Every item spends AI Credits from your GitHub Copilot plan.',
  ],
};
