#!/usr/bin/env node
// MANUAL ONLY (never CI, never the e2e): `pnpm smoke:claude`. Card ZY6KC56r. See docs/AGENT-SMOKE.md.
// Verifies the hivenod channel plugin end to end in real Claude Code sessions (haiku) against the
// emulators, with an isolated Claude config so the live Telegram / agent-mail sessions are never touched.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = 'agent-mail/server.ts|agent-telegram|telegram';
const user = userInfo().username;

/** pid -> command line of the live processes the smoke must never start or touch. */
export function watched() {
  const r = spawnSync('pgrep', ['-u', user, '-af', WATCH], { encoding: 'utf8' });
  const m = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const mm = /^(\d+) (.*)$/.exec(line);
    if (mm) m.set(Number(mm[1]), mm[2]);
  }
  return m;
}
/** `--only connect|basic|max-items|park|inbox` (cards cGSENsRF, QjTTL, items EJ2Cxq4k, 4PEHr): which part of the smoke to run; '' = all. */
export function onlyFrom(argv) {
  const i = argv.indexOf('--only');
  if (i < 0) return '';
  const v = argv[i + 1];
  if (!['connect', 'basic', 'max-items', 'park', 'inbox'].includes(v))
    throw new Error('--only must be connect, basic, max-items, park or inbox');
  return v;
}

/** The pids in `now` that are not in `before`. */
export const added = (before, now) => [...now.keys()].filter((p) => !before.has(p));

function main() {
  let only;
  try {
    only = onlyFrom(process.argv.slice(2));
  } catch (e) {
    console.error(`[smoke] ${e.message}`);
    return 2;
  }
  const creds = join(
    process.env.CLAUDE_SMOKE_CREDENTIALS_FROM || join(homedir(), '.claude'),
    '.credentials.json',
  );
  if (!existsSync(creds)) {
    console.error(`no ${creds}: sign in to Claude Code first`);
    return 2;
  }
  const T = mkdtempSync(join(tmpdir(), 'hive-smoke-claude-'));
  const cfg = join(T, 'cfg');
  const socket = `smoke-${process.pid}`;
  let child = null;
  let failure = '';
  mkdirSync(cfg, { mode: 0o700 });
  const before = watched();
  console.log(
    `[smoke] guard baseline: ${before.size} live telegram/agent-mail process(es), never touched`,
  );
  let guardTimer = null;
  let finished = false;

  const killOurs = () => {
    // Everything that runs with our private config dir, plus the tmux server and the child group.
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      if (child?.pid) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* gone */
        }
      }
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
        try {
          if (
            readFileSync(`/proc/${d}/environ`, 'utf8')
              .split('\0')
              .includes(`CLAUDE_CONFIG_DIR=${cfg}`)
          )
            process.kill(Number(d), sig);
        } catch {
          /* not ours or gone */
        }
      }
    }
  };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearInterval(guardTimer);
    try {
      killOurs();
    } catch (e) {
      console.error('[smoke] kill step failed', e.message);
    }
    // shred the copied credentials, then remove everything
    spawnSync('shred', ['-u', join(cfg, '.credentials.json')], { stdio: 'ignore' });
    rmSync(T, { recursive: true, force: true });
    console.log(
      `[smoke] cleanup done: processes killed, ${existsSync(T) ? 'FAILED to remove' : 'removed'} ${T}`,
    );
  };
  const guard = (when) => {
    const bad = added(before, watched());
    if (bad.length) {
      failure = `GUARD: new telegram/agent-mail process ${bad.join(',')} (${when}); aborting`;
      console.error(`[smoke] ${failure}`);
      killOurs();
      return false;
    }
    return true;
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, () => {
      failure ||= `got ${sig}`;
      cleanup();
      process.exit(130);
    });
  process.on('exit', cleanup);

  try {
    copyFileSync(creds, join(cfg, '.credentials.json'));
    chmodSync(join(cfg, '.credentials.json'), 0o600);
    writeFileSync(
      join(cfg, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        numStartups: 5,
        theme: 'dark',
        mcpServers: {},
      }),
      { mode: 0o600 },
    );
    guardTimer = setInterval(() => guard('while running'), 1000);
    const cmd = `cd cli/e2e && npx vitest run -c vitest.config.ts test/claude.channel.smoke.test.ts`;
    child = spawn('node', ['scripts/emu-exec.mjs', cmd], {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HIVE_SMOKE_CLAUDE_CHANNEL: '1',
        HIVE_SMOKE_CLAUDE_CONFIG_DIR: cfg,
        HIVE_SMOKE_DIR: T,
        HIVE_SMOKE_TMUX: socket,
        HIVE_SMOKE_ONLY: only,
      },
    });
    const show = (b) => process.stdout.write(redact(String(b)));
    child.stdout.on('data', show);
    child.stderr.on('data', show);
    return new Promise((resolve) => {
      child.on('exit', (code) => {
        // The guard compares once more at the end.
        if (!guard('at the end')) return resolve(3);
        if (code === 0)
          console.log(
            `[smoke] guard: no new telegram/agent-mail process at start, during or at the end`,
          );
        resolve(code === 0 ? 0 : 1);
      });
      setTimeout(() => {
        failure ||= 'timeout 35 min';
        console.error('[smoke] overall timeout');
        killOurs();
      }, 35 * 60_000).unref();
    }).then((code) => {
      cleanup();
      return code;
    });
  } catch (e) {
    console.error('[smoke] error:', e.message);
    cleanup();
    return 1;
  }
}

/** Never print a token or credential. */
export function redact(s) {
  return s
    .replace(/hive_agt_[A-Za-z0-9_-]+/g, 'hive_agt_***')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]+/g, 'jwt***');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Promise.resolve(main()).then((c) => process.exit(c));
}
