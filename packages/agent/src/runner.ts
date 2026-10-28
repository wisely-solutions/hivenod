/**
 * `hivenod run claude` (card MkUwvyWs): Hivenod owns the loop, the coding CLI runs headless once per
 * item. Waiting costs no model tokens (a live Firestore listener). For each item: claim, build
 * the prompt, start the CLI with a Hivenod MCP server bound to that item, heartbeat, count tokens
 * from the CLI's own JSON output, then complete (one step; stops at a human gate) or give the
 * item back. Guardrails are enforced here, outside the model: the wall-time
 * limit, the failure streak (Hivenod pauses the agent), revoke (the next call fails). What the CLI
 * may do on the machine is the person's own Claude Code config, never Hivenod's.
 *
 * Card OPpbi0MS (Build D): in a terminal the CLI is an interactive Claude Code session per item
 * instead (Remote Control, the person's own setup; see interactive.ts). The same guardrails
 * apply; tokens come from Claude's session log, and what the person's Claude settings do not allow
 * is asked (denied after 10 minutes without an answer) instead of denied at once.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { DEFAULT_AGENT_PERMISSIONS, formatTokens } from '@hive/shared';
import { bridgePath, serveBridge } from './bridge';
import { claudeAdapter, type CliAdapter } from './adapter';
import { describeExtraArgs, eurFromUsd, type Usage } from './claude';
import type { HiveClient, WorkRow } from './client';
import { hiveHome, legacyHome } from './credentials';
import { isRateLimited, isStoppedMessage, messageOf, REVOKED_MESSAGE } from './errors';
import {
  childEnv,
  claudeConfigDir,
  interactiveArgs,
  PERMISSION_TIMEOUT_MS,
  remoteUrl,
  SessionLog,
  sessionStatus,
  shellQuote,
} from './interactive';
import {
  interactivePrompt,
  interactiveRules,
  runPrompt,
  shapePrompt,
  type ItemBrief,
} from './prompt';
import { runTools, type Finish } from './runtools';
import type { ToolContext, ToolDef } from './tools';

export type RunnerClient = Pick<
  HiveClient,
  | 'waitForWork'
  | 'claim'
  | 'readItem'
  | 'heartbeat'
  | 'reportUsage'
  | 'complete'
  | 'releaseRun'
  | 'log'
  | 'whoami'
  | 'refreshAgent'
  | 'untrackRun'
  | 'ask'
  | 'progress'
  | 'attach'
  | 'raiseFinding'
  | 'checkProject'
  | 'markSeen'
  | 'markOffline'
  | 'setRemote'
  | 'watchRun'
  | 'shape'
  | 'skipStep'
  | 'askPathChange'
  | 'proposeStep'
>;

export interface Terminal {
  line(text: string): void;
}

export interface RunnerOptions {
  client: RunnerClient;
  /**
   * How to start `hivenod mcp` (node + this CLI's path). That server gets no credential: it forwards
   * the model's tool calls to this process over the run bridge, and the token never leaves here.
   */
  hiveCommand: string[];
  /** Which coding CLI runs the items (default Claude Code; card 3RiuFK00 adds Codex, Copilot). */
  adapter?: CliAdapter;
  /** The coding CLI's executable (default the adapter's, e.g. `claude`). */
  cliCommand?: string;
  cwd?: string;
  model?: string;
  projectId?: string;
  /** Do one item, then exit. */
  once?: boolean;
  maxRunMinutes?: number;
  /** Each wait for work lasts at most this long; every new wait re-checks revoke and pause. */
  waitSliceMs?: number;
  heartbeatMs?: number;
  /** How often running token totals are reported to Hivenod (tracked, never limited). */
  usageCheckMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Pause after a claim that did not work, so an item that stays listed is not retried hot. */
  claimRetryMs?: number;
  /** First wait after Hivenod/Firebase did not answer; doubles up to 2 minutes. */
  errorRetryMs?: number;
  /** How often the agent tells Hivenod it is online while it waits (the agents page shows it). */
  presenceMs?: number;
  /**
   * Interactive Claude Code per item in this terminal (card OPpbi0MS), with Remote Control and
   * the person's own setup; false runs it headless (`claude -p`).
   */
  interactive?: boolean;
  /** Interactive: load only the Hivenod MCP server, not the person's own MCP servers. */
  clean?: boolean;
  /** Claude only: the person's own arguments (`hivenod run claude -- <args>`), validated in cli.ts. */
  extraArgs?: readonly string[];
  /** Interactive: an unanswered permission prompt is denied after this long (10 minutes). */
  permissionTimeoutMs?: number;
  /** Interactive: after finish, close the session at the latest this long after (when Claude keeps talking). */
  closeGraceMs?: number;
  /** Interactive: how long to wait for Remote Control before noting in the run that it is off. */
  remoteWaitMs?: number;
  /** Claude Code's config folder (session logs and session state). */
  claudeConfigDir?: string;
  terminal: Terminal;
  signal?: AbortSignal;
}

/** Exit codes of `hivenod run`. */
export const EXIT = { ok: 0, error: 1, revoked: 3, paused: 4, interrupted: 130 } as const;

type Ending =
  | { kind: 'finished'; finish: Finish | null }
  | { kind: 'timeout' }
  | { kind: 'revoked' }
  | { kind: 'interrupted' }
  /** An interactive session closed by the person before the item was finished. */
  | { kind: 'closed' }
  /** A person pressed Stop work in Hivenod (card BrK0r2FE): the run is already ended there. */
  | { kind: 'stopped'; summary: string | null };

interface CliResult {
  ending: Ending;
  usage: Usage;
  error: string;
}

const isRevoked = (e: unknown) => messageOf(e) === REVOKED_MESSAGE;
const isPausedMsg = (e: unknown) => /This agent is (now )?paused/.test(messageOf(e));

function tokensText(u: Usage): string {
  const fresh = Math.max(0, u.tokensIn - u.tokensCached);
  const eur = eurFromUsd(u.costUsd);
  const cost = eur > 0 ? ` · €${eur < 0.01 ? eur.toFixed(4) : eur.toFixed(2)}` : '';
  return `${formatTokens(fresh)} tokens in${u.tokensCached ? ` (+${formatTokens(u.tokensCached)} cached)` : ''} / ${formatTokens(u.tokensOut)} out${u.model ? ` · ${u.model}` : ''}${cost}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export class Runner {
  private readonly o: Required<
    Pick<
      RunnerOptions,
      | 'cliCommand'
      | 'cwd'
      | 'maxRunMinutes'
      | 'waitSliceMs'
      | 'heartbeatMs'
      | 'usageCheckMs'
      | 'killGraceMs'
      | 'claimRetryMs'
      | 'errorRetryMs'
      | 'presenceMs'
      | 'permissionTimeoutMs'
      | 'closeGraceMs'
      | 'remoteWaitMs'
      | 'claudeConfigDir'
      | 'adapter'
    >
  > &
    RunnerOptions;
  private readonly say: (s: string) => void;

  constructor(opts: RunnerOptions) {
    const adapter = opts.adapter ?? claudeAdapter;
    this.o = {
      adapter,
      cliCommand: adapter.bin,
      cwd: process.cwd(),
      maxRunMinutes: 60,
      waitSliceMs: 55_000,
      heartbeatMs: 60_000,
      usageCheckMs: 10_000,
      killGraceMs: 10_000,
      claimRetryMs: 5_000,
      errorRetryMs: 10_000,
      presenceMs: 30_000,
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
      closeGraceMs: 20_000,
      remoteWaitMs: 120_000,
      claudeConfigDir: claudeConfigDir(),
      ...opts,
    };
    // Interactive sessions per item exist only for Claude Code.
    if (!adapter.interactive) this.o.interactive = false;
    this.say = (s) => (this.held ? this.held.push(s) : opts.terminal.line(s));
  }

  /** The loop. Resolves with the process exit code. On the way out the agent shows as offline. */
  async run(): Promise<number> {
    const code = await this.loop();
    // A revoked agent can no longer write; Hivenod shows it as revoked anyway.
    if (code !== EXIT.revoked) await this.o.client.markOffline().catch(() => undefined);
    return code;
  }

  private lastSeen = 0;
  private async seen() {
    if (Date.now() - this.lastSeen < this.o.presenceMs) return;
    this.lastSeen = Date.now();
    await this.o.client.markSeen().catch(() => undefined);
  }

  private async loop(): Promise<number> {
    const { client } = this.o;
    let projectId = this.o.projectId;
    if (projectId) {
      // A project this agent cannot use is a mistake to fix, not something to retry.
      try {
        projectId = await client.checkProject(projectId);
      } catch (e) {
        const code = this.stopCode(e);
        if (code !== null) return code;
        this.say(`✗ ${messageOf(e)}`);
        return EXIT.error;
      }
    }
    // Presence also while idle or inside a long wait slice: never more than ~presenceMs apart, so
    // the other-terminal check (2 minute window) cannot see a gap (card wvLiSoy8).
    const beat =
      this.o.presenceMs > 0
        ? setInterval(() => {
            this.lastSeen = Date.now();
            void this.o.client.markSeen().catch(() => undefined);
          }, this.o.presenceMs)
        : undefined;
    try {
      return await this.loopBody(projectId);
    } finally {
      if (beat) clearInterval(beat);
    }
  }

  private async loopBody(projectId: string | undefined): Promise<number> {
    const { client, signal } = this.o;
    this.say(
      'Waiting for AI work… (Ctrl+C to stop; revoke the agent in Hivenod to stop it remotely)',
    );
    let failures = 0;
    for (;;) {
      if (signal?.aborted) return EXIT.interrupted;
      await this.seen();
      let rows: WorkRow[];
      try {
        const r = await client.waitForWork({
          projectId,
          timeoutMs: this.o.waitSliceMs,
          signal,
        });
        failures = 0;
        if (r.timedOut) continue;
        rows = r.work;
      } catch (e) {
        const code = this.stopCode(e);
        if (code !== null) return code;
        const waitMs = Math.min(this.o.errorRetryMs * 2 ** failures, 120_000);
        failures += 1;
        const secs = Math.max(1, Math.round(waitMs / 1000));
        this.say(
          isRateLimited(e)
            ? `! Firebase is limiting requests for a moment, retrying in ${secs} s.`
            : `! Hivenod did not answer (${messageOf(e)}). Trying again in ${secs} s.`,
        );
        await sleep(waitMs, signal);
        continue;
      }
      // An item this agent still holds (e.g. after a restart) comes first.
      const row = rows.find((r) => r.claim?.mine) ?? rows[0];
      if (!row) continue;
      const code = await this.item(row);
      this.lastSeen = Date.now(); // the run's heartbeats showed it online
      if (code === 'skipped') continue;
      if (code !== null) return code;
      if (this.o.once) return EXIT.ok;
      this.say('Waiting for AI work…');
    }
  }

  /** Revoked or paused: a message and the exit code. Anything else: null (keep going). */
  private stopCode(e: unknown): number | null {
    if (isRevoked(e)) {
      this.say(
        '✗ This agent was revoked in Hivenod. Stopping. (Pair again with a new agent to continue.)',
      );
      return EXIT.revoked;
    }
    if (isPausedMsg(e)) {
      this.say(`■ ${messageOf(e)}`);
      return EXIT.paused;
    }
    return null;
  }

  /** One item. Returns an exit code to stop the loop, null to wait for the next item, or
   * 'skipped' when it could not be claimed. */
  private async item(row: WorkRow): Promise<number | null | 'skipped'> {
    const { client } = this.o;
    this.say(
      row.job === 'shape'
        ? `▶ New item to shape “${row.title}”  (${row.project}): choosing the steps it needs`
        : `▶ New item “${row.title}”  (${row.project} · step ${row.step})`,
    );
    let runId: string;
    try {
      const c = await client.claim(row.itemId, row.projectId);
      runId = c.runId;
      // The wrapper beats itself (so it notices a revoke); the client's own timer is not needed.
      client.untrackRun(runId);
    } catch (e) {
      const code = this.stopCode(e);
      if (code !== null) return code;
      this.say(`  could not claim it: ${messageOf(e)}`);
      await sleep(this.o.claimRetryMs, this.o.signal);
      return 'skipped';
    }
    let ending: Ending;
    let usage: Usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, model: null, costUsd: 0 };
    let cliError: string;
    const dir = mkdtempSync(join(tmpdir(), 'hivenod-run-'));
    try {
      const brief = await client.readItem(row.itemId, row.projectId);
      const me = client.whoami();
      this.say(`  claimed · run ${runId} started`);
      if (this.o.extraArgs?.length)
        client
          .log(runId, `Extra Claude arguments: ${describeExtraArgs(this.o.extraArgs)}`)
          .catch(() => undefined);
      const r = await this.spawnCli(row, runId, brief, me, dir);
      ending = r.ending;
      usage = r.usage;
      cliError = r.error;
    } catch (e) {
      const code = this.stopCode(e);
      if (code !== null) return code;
      ending = { kind: 'finished', finish: null };
      cliError = messageOf(e);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return this.settle(row, runId, ending, usage, cliError);
  }

  private async spawnCli(
    row: WorkRow,
    runId: string,
    brief: ItemBrief,
    me: { name: string },
    dir: string,
  ): Promise<CliResult> {
    const { client } = this.o;
    // The item's tools run here, with this process's client; the CLI's MCP server only forwards.
    const got: { finish: Finish | null } = { finish: null };
    const tools = runTools({
      runId,
      itemId: row.itemId,
      projectId: row.projectId,
      cwd: this.o.cwd,
      deny: [dir],
      onFinish: (f) => (got.finish = f),
      job: row.job,
    });
    // Shaping is a short job: always headless, also when items open interactively.
    const interactive = this.o.interactive && row.job !== 'shape';
    if (interactive) tools.push(this.permissionTool(runId));
    const bridge = await serveBridge(bridgePath(dir), tools, client as HiveClient);
    const prompt = row.job === 'shape' ? shapePrompt(brief, me.name) : runPrompt(brief, me.name);
    try {
      return interactive
        ? await this.runInteractive(row, runId, brief, me, bridge.path, dir, () => got.finish)
        : await this.runCli(runId, prompt, bridge.path, dir, () => got.finish, row.job);
    } finally {
      await bridge.close();
    }
  }

  /** How the CLI starts the one-item server: `hivenod mcp --run R --bridge S`, with no credential. */
  private mcpServer(
    runId: string,
    bridge: string,
    job: 'shape' | null = null,
  ): { command: string; args: string[] } {
    const [cmd, ...pre] = this.o.hiveCommand;
    return {
      command: cmd!,
      args: [...pre, 'mcp', '--run', runId, '--bridge', bridge, ...(job ? ['--job', job] : [])],
    };
  }

  /** The run-scoped MCP config for Claude's --mcp-config. */
  private mcpConfig(runId: string, bridge: string): string {
    const { command, args } = this.mcpServer(runId, bridge);
    return JSON.stringify({ mcpServers: { hivenod: { command, args, env: {} } } });
  }

  private async runCli(
    runId: string,
    prompt: string,
    bridge: string,
    dir: string,
    finished: () => Finish | null,
    job: 'shape' | null = null,
  ): Promise<CliResult> {
    const { client, adapter } = this.o;
    const run = adapter.headless({
      prompt,
      mcp: this.mcpServer(runId, bridge, job),
      // Only CLIs that do not read the person's own permission settings use these (Codex, Copilot).
      permissions: DEFAULT_AGENT_PERMISSIONS,
      model: this.o.model,
      extraArgs: this.o.extraArgs,
      // Hivenod's saved credentials and this run's private folder are not the model's business.
      deniedPaths: [hiveHome(), legacyHome(), dir],
      dir,
    });
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.HIVENOD_TOKEN; // the CLI and its tools never see the token
    delete env.HIVENOD_TOKEN_FILE;
    // A token left over from the old `hive` CLI still works server-side: never pass it on either.
    delete env.HIVE_TOKEN;
    delete env.HIVE_TOKEN_FILE;
    for (const [k, v] of Object.entries(run.env ?? {}))
      if (v === undefined) delete env[k];
      else env[k] = v;
    const child = spawn(this.o.cliCommand, run.args, {
      cwd: this.o.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const stream = run.stream;
    let stderr = '';
    let lastMirror = 0;
    let mirrored = 0;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      for (const note of stream.push(line)) {
        if (note.kind === 'rateLimit') this.say(`  ! ${note.text}`);
        else this.say(`  ${adapter.id} ▸ ${note.text}`);
        // Mirror a short line to the run log now and then, so people can follow in Hivenod.
        if (note.kind === 'text' && Date.now() - lastMirror > 20_000 && mirrored < 100) {
          lastMirror = Date.now();
          mirrored++;
          client.log(runId, note.text).catch(() => undefined);
        }
      }
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });

    const { ending, exit } = await this.supervise(child, runId, () => {
      stream.poll?.();
      return stream.usage();
    });
    stream.poll?.(); // e.g. Copilot's usage file, written as it ends
    const usage = stream.usage();
    if (ending) return { ending, usage, error: '' };
    const finish = finished();
    let error = '';
    if (exit.error) error = this.spawnError(exit.error);
    else if (!finish) {
      const r = stream.result;
      error = r?.isError
        ? `the CLI stopped with an error${r.text ? `: ${r.text.slice(0, 300)}` : ''}`
        : exit.code !== 0
          ? `the CLI exited with code ${exit.code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()!.slice(0, 300)}` : ''}`
          : 'the CLI ended without calling finish';
      if (r?.denials.length)
        error += ` (denied: ${[...new Set(r.denials)].slice(0, 5).join(', ')})`;
    }
    return { ending: { kind: 'finished', finish }, usage, error };
  }

  private spawnError(e: Error): string {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? `${this.o.cliCommand} was not found on PATH`
      : e.message;
  }

  /** True while an interactive Claude session owns the terminal (Ctrl+C is Claude's then). */
  get inSession(): boolean {
    return this.held !== null;
  }
  /** Lines held back while Claude owns the terminal; printed when the session closes. */
  private held: string[] | null = null;

  /**
   * One interactive Claude Code session for the item (card OPpbi0MS): in this terminal, with
   * Remote Control, the person's own setup and the Hivenod item tools. Hivenod closes it once the model
   * has called finish and Claude has stopped talking; closing it earlier gives the item back.
   */
  private async runInteractive(
    row: WorkRow,
    runId: string,
    brief: ItemBrief,
    me: { name: string },
    bridge: string,
    dir: string,
    finished: () => Finish | null,
  ): Promise<CliResult> {
    const { client } = this.o;
    const sessionId = randomUUID();
    const configDir = this.o.claudeConfigDir;
    const name = `Hivenod: ${row.title}`.slice(0, 80);
    const args = interactiveArgs({
      prompt: interactivePrompt(brief),
      rules: interactiveRules(me.name),
      sessionId,
      mcpConfig: this.mcpConfig(runId, bridge),
      hookCommand: `exec ${shellQuote([...this.o.hiveCommand, 'hook', 'permission', '--bridge', bridge])}`,
      hookTimeoutSec: Math.ceil(this.o.permissionTimeoutMs / 1000) + 60,
      name,
      model: this.o.model,
      deniedPaths: [hiveHome(), legacyHome(), dir],
      clean: this.o.clean,
      extraArgs: this.o.extraArgs,
    });
    this.say(
      '  Opening Claude Code for this item, with Remote Control (claude.ai/code and the Claude app).',
    );
    this.say('  Type to Claude any time. Hivenod closes the session when the item is finished.');
    const child = spawn(this.o.cliCommand, args, {
      cwd: this.o.cwd,
      stdio: 'inherit',
      env: childEnv(process.env),
    });
    this.held = [];
    const log = new SessionLog(sessionId, configDir);
    const startedAt = Date.now();
    let remote: string | null = null;
    let remoteNoted = false;
    const watchRemote = () => {
      if (remote || remoteNoted) return;
      const url = log.bridgeSessionId ? remoteUrl(log.bridgeSessionId) : null;
      if (url) {
        remote = url;
        client.setRemote(runId, { url, sessionId }).catch(() => undefined);
        client.log(runId, `Remote Control: ${url}`).catch(() => undefined);
      } else if (Date.now() - startedAt > this.o.remoteWaitMs) {
        remoteNoted = true;
        client
          .log(
            runId,
            'Remote Control did not start for this session (it needs a claude.ai login with Remote Control). The session runs in the terminal only.',
            'warn',
          )
          .catch(() => undefined);
      }
    };
    // Once finish is called: close the session when Claude has stopped talking (or after a grace).
    let finishedAt = 0;
    const closer = setInterval(() => {
      if (!finished()) return;
      finishedAt ||= Date.now();
      const st = child.pid ? sessionStatus(child.pid, configDir) : null;
      const quiet = st?.status === 'idle' && Date.now() - finishedAt > 1000;
      if (quiet || Date.now() - finishedAt > this.o.closeGraceMs) {
        clearInterval(closer);
        this.kill(child);
      }
    }, 500);
    const usageNow = () => {
      log.poll();
      watchRemote();
      return log.usage();
    };
    let result: Awaited<ReturnType<Runner['supervise']>>;
    try {
      result = await this.supervise(child, runId, usageNow);
    } finally {
      clearInterval(closer);
      const held = this.held;
      this.held = null;
      for (const l of held) this.say(l);
    }
    log.poll();
    let usage = log.usage();
    if (!log.readable) {
      usage = { ...usage, model: 'unknown' };
      client
        .log(runId, "Could not read Claude's session log: tokens and model are unknown.", 'warn')
        .catch(() => undefined);
      this.say("  ! Could not read Claude's session log: tokens and model are unknown.");
    }
    if (remote) this.say(`  Remote Control: ${remote}`);
    const { ending, exit } = result;
    if (ending) return { ending, usage, error: '' };
    const finish = finished();
    if (finish) return { ending: { kind: 'finished', finish }, usage, error: '' };
    if (exit.error)
      return {
        ending: { kind: 'finished', finish: null },
        usage,
        error: this.spawnError(exit.error),
      };
    // Closed by the person (/exit, Ctrl+C twice, the window) before the item was finished.
    if (
      exit.code === 0 ||
      exit.code === 130 ||
      exit.signal === 'SIGINT' ||
      exit.signal === 'SIGHUP'
    )
      return { ending: { kind: 'closed' }, usage, error: '' };
    return {
      ending: { kind: 'finished', finish: null },
      usage,
      error: `Claude exited with code ${exit.code ?? exit.signal} before the item was finished`,
    };
  }

  /**
   * Bridge-only tool for the permission hook (not an MCP tool): a prompt for a tool off the
   * allow-list is shown in the terminal and via Remote Control; nobody answering within the
   * timeout means deny. When the person answers, Claude ends the hook and the wait ends with it.
   */
  private permissionTool(runId: string): ToolDef {
    const { client } = this.o;
    const minutes = Math.round(this.o.permissionTimeoutMs / 60_000);
    return {
      name: 'permission_wait',
      description: 'Used by the permission hook of hivenod run.',
      input: { request: z.string().max(400) },
      run: async (_c: HiveClient, a: Record<string, unknown>, ctx?: ToolContext) => {
        const what = String(a.request);
        await client
          .log(
            runId,
            `Waiting for permission: ${what}. Answer in the terminal or on claude.ai/code; denied if nobody answers within ${minutes} minutes.`,
            'warn',
          )
          .catch(() => undefined);
        await sleep(this.o.permissionTimeoutMs, ctx?.signal);
        if (ctx?.signal.aborted) return {};
        await client
          .log(
            runId,
            `Nobody answered the permission prompt within ${minutes} minutes: denied ${what}.`,
            'warn',
          )
          .catch(() => undefined);
        return {
          behavior: 'deny',
          message: `Nobody answered this permission prompt within ${minutes} minutes, so Hivenod denied it. Do not ask for it again: finish without it, or finish as failed and say which permission the agent needs.`,
        };
      },
    } as unknown as ToolDef;
  }

  /**
   * The guardrails while the CLI runs, the same in both modes: running token totals (reported,
   * never limited), heartbeats (a revoke stops it), the wall-time cap, Ctrl+C.
   */
  private async supervise(
    child: ChildProcess,
    runId: string,
    usageNow: () => Usage,
  ): Promise<{
    ending: Ending | null;
    exit: { code: number | null; signal?: NodeJS.Signals | null; error?: Error };
  }> {
    const { client } = this.o;
    // A holder, so TypeScript sees the writes made from the callbacks below.
    const state: { ending: Ending | null } = { ending: null };
    let lastReported = '';
    let checking = false;

    const stop = (e: Ending) => {
      if (state.ending) return;
      state.ending = e;
      this.kill(child);
    };
    const onAbort = () => stop({ kind: 'interrupted' });
    this.o.signal?.addEventListener('abort', onAbort);
    // Stop work in Hivenod (card BrK0r2FE): the run's own document says so, live, within seconds.
    const unwatch = client.watchRun(runId, (run) =>
      stop({ kind: 'stopped', summary: run.summary ?? null }),
    );

    // Usage: reported to Hivenod for display; nothing here stops a run over tokens.
    const checkUsage = async (force: boolean) => {
      if (checking || state.ending) return;
      const u = usageNow();
      const key = `${u.tokensIn}/${u.tokensOut}/${u.tokensCached}/${u.model}/${eurFromUsd(u.costUsd)}`;
      if (!force && key === lastReported) return;
      checking = true;
      try {
        if (key === lastReported) await client.heartbeat(runId);
        else {
          await client.reportUsage(runId, {
            tokensIn: u.tokensIn,
            tokensOut: u.tokensOut,
            tokensCached: u.tokensCached,
            ...(u.model ? { model: u.model } : {}),
            costEur: eurFromUsd(u.costUsd),
          });
          lastReported = key;
        }
      } catch (e) {
        if (isRevoked(e)) stop({ kind: 'revoked' });
        // The live watch missed it (offline for a while): the run was stopped in Hivenod.
        else if (isStoppedMessage(e)) stop({ kind: 'stopped', summary: null });
        else if (!state.ending) this.say(`  ! heartbeat: ${messageOf(e)}`);
      } finally {
        checking = false;
      }
    };
    const usageTimer = setInterval(() => void checkUsage(false), this.o.usageCheckMs);
    const beatTimer = setInterval(() => {
      void checkUsage(true);
      void this.seen(); // the agent's presence stays fresh during a run: it is how a second terminal is refused
    }, this.o.heartbeatMs);
    const wallTimer = setTimeout(() => stop({ kind: 'timeout' }), this.o.maxRunMinutes * 60_000);

    const exit = await new Promise<{
      code: number | null;
      signal?: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearInterval(usageTimer);
    clearInterval(beatTimer);
    clearTimeout(wallTimer);
    unwatch();
    this.o.signal?.removeEventListener('abort', onAbort);
    // A last look at the final usage.
    while (checking) await sleep(50);
    if (!state.ending) await checkUsage(false);
    return { ending: state.ending, exit };
  }

  private kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, this.o.killGraceMs);
    t.unref();
  }

  private outcome(u: Usage, summary: string) {
    return {
      tokensIn: u.tokensIn,
      tokensOut: u.tokensOut,
      tokensCached: u.tokensCached,
      ...(u.model ? { model: u.model } : {}),
      // Claude's own cost (or an estimate from tokens), in EUR: the Runs panel and agent totals.
      costEur: eurFromUsd(u.costUsd),
      summary: summary.slice(0, 4000),
    };
  }

  /** Ends the run the way the CLI ended. Returns an exit code to stop, or null to go on. */
  private async settle(
    row: WorkRow,
    runId: string,
    ending: Ending,
    usage: Usage,
    cliError: string,
  ): Promise<number | null> {
    const { client } = this.o;
    try {
      switch (ending.kind) {
        case 'revoked':
          this.say('✗ This agent was revoked in Hivenod. The CLI was stopped.');
          return EXIT.revoked;
        case 'stopped':
          // Nothing to write: the person's stop already ended the run and cleared the claim.
          this.stopped(ending.summary);
          return null;
        case 'interrupted': {
          await client.releaseRun(runId, {
            status: 'released',
            outcome: this.outcome(usage, 'Stopped by the person at the terminal (Ctrl+C).'),
          });
          this.say('■ Stopped. The item is back in the queue.');
          return EXIT.interrupted;
        }
        case 'closed': {
          await client.releaseRun(runId, {
            status: 'released',
            outcome: this.outcome(
              usage,
              'Claude was closed at the terminal before the item was finished.',
            ),
          });
          // The person's own choice, not an interruption of hivenod run: a clean stop (exit 0).
          this.say(
            '■ You closed Claude before the item was finished. The item is back in the queue; hivenod run stops here.',
          );
          return EXIT.ok;
        }
        case 'timeout':
          return this.fail(
            runId,
            usage,
            `Stopped after ${this.o.maxRunMinutes} minutes (time limit per run).`,
          );
        case 'finished': {
          const f = ending.finish;
          if (row.job === 'shape' && f?.outcome === 'done') {
            if (!f.shape)
              return this.fail(runId, usage, 'The shaping run ended without shape_item.');
            const r = await client.shape(
              row.itemId,
              runId,
              f.shape,
              this.outcome(usage, f.summary),
              row.projectId,
            );
            this.say(
              `✓ Shaped “${row.title}”: ${r.skipped.length ? `skips ${r.skipped.join(', ')}` : 'the full process'}${r.askedToSkip.length ? ` · asked people to skip ${r.askedToSkip.join(', ')}` : ''} · ${tokensText(usage)}`,
            );
            return null;
          }
          if (f?.outcome === 'done') {
            const r = await client.complete(
              row.itemId,
              runId,
              this.outcome(usage, f.summary),
              row.projectId,
            );
            const where = r.movedTo
              ? `moved to ${r.movedTo.name}${r.waitingForPeople ? ' (waiting for people)' : ''}`
              : 'item done';
            this.say(`✓ Finished step ${row.step} · ${tokensText(usage)} · ${where}`);
            return null;
          }
          if (f?.outcome === 'needs_answer') {
            await client.releaseRun(runId, {
              status: 'released',
              ...(f.questionId ? { holdFor: f.questionId } : {}),
              outcome: this.outcome(usage, f.summary),
            });
            this.say(
              `  ? Question sent to Hivenod: “${(f.question ?? '').slice(0, 200)}” → Needs you`,
            );
            this.say(`■ Item given back until people answer · ${tokensText(usage)}`);
            return null;
          }
          return this.fail(
            runId,
            usage,
            f ? `The agent could not finish: ${f.summary}` : `Failed: ${cliError}.`,
          );
        }
      }
    } catch (e) {
      const code = this.stopCode(e);
      if (code !== null) return code;
      // Stopped in Hivenod while the CLI was finishing: the stop wins, nothing else to report.
      if (isStoppedMessage(e)) {
        this.stopped(null);
        return null;
      }
      this.say(`! Could not report the run to Hivenod: ${messageOf(e)}`);
      return null;
    }
  }

  private stopped(summary: string | null) {
    this.say(
      `■ ${summary ?? 'Stopped in Hivenod.'} The CLI was stopped; this run is not counted as a failure.`,
    );
  }

  private async fail(runId: string, usage: Usage, summary: string): Promise<number | null> {
    const r = await this.o.client.releaseRun(runId, {
      status: 'failed',
      outcome: this.outcome(usage, summary),
    });
    this.say(`✗ ${summary} · ${tokensText(usage)} · the item is back in the queue`);
    if (r.agentPaused) {
      this.say(`■ ${r.agentPaused}`);
      return EXIT.paused;
    }
    return null;
  }
}

/** Shown when the session starts. */
export const PERMISSIONS_LINE = 'Permissions: your Claude Code settings (~/.claude/settings.json)';

export function headerLines(
  me: ReturnType<HiveClient['whoami']>,
  projects: string[],
  extra: {
    cli: string;
    cliVersion: string;
    saved?: string;
    mode?: 'interactive' | 'interactive-clean' | 'headless';
    /** Where permissions come from (default: the user's Claude Code settings). */
    permissionsLine?: string;
    /** The headless line of the CLI's adapter (default Claude's). */
    headlessLine?: string;
    /** Bypass permissions (YOLO): the permissions line is the whole story, no headless/prompt line. */
    bypass?: boolean;
    /** More lines from the adapter (e.g. EXPERIMENTAL). */
    notes?: string[];
  },
): string[] {
  const g = me.guardrails;
  const mode = extra.bypass
    ? null
    : extra.mode === 'headless'
      ? (extra.headlessLine ?? claudeAdapter.headlessLine)
      : extra.mode
        ? `  Interactive: each item opens Claude Code here with Remote Control and ${extra.mode === 'interactive-clean' ? 'only the Hivenod tools (--clean)' : 'your own Claude setup'}; permission prompts follow your Claude Code settings (denied after 10 minutes without an answer).`
        : null;
  return [
    `Agent ${me.name} · projects: ${projects.join(', ') || 'none'}${extra.saved ? ` · token saved to ${extra.saved}` : ''}`,
    `✓ Connected. Guardrails: stop after ${g.maxFailedRuns} failed runs · cannot decide gates`,
    `  ${extra.cli} ${extra.cliVersion} · ${extra.permissionsLine ?? PERMISSIONS_LINE}`,
    ...(mode ? [mode] : []),
    ...(extra.notes ?? []),
  ];
}
