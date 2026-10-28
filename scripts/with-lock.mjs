#!/usr/bin/env node
// Usage: node scripts/with-lock.mjs <command...>
// Runs the command while holding a machine-wide lock (default /tmp/hive-emulators.lock), so two
// worktrees never start the emulators (9099, 8080) at the same time. Waits for the other
// holder; a lock whose process died is taken over. HIVE_LOCK_TIMEOUT_MIN (default 40) bounds the wait.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAlive } from './lock-lib.mjs';

const cmd = process.argv.slice(2);
if (cmd.length === 0) {
  console.error('Usage: node scripts/with-lock.mjs <command...>');
  process.exit(2);
}
const dir = process.env.HIVE_LOCK_DIR || join(tmpdir(), 'hive-emulators.lock');
const deadline = Date.now() + Number(process.env.HIVE_LOCK_TIMEOUT_MIN || 40) * 60000;

for (let announced = false; ;) {
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, 'pid'), `${process.pid}\n${process.cwd()}\n`);
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let info = '';
    try {
      info = readFileSync(join(dir, 'pid'), 'utf8');
    } catch {
      /* no pid file yet */
    }
    const pid = Number(info.split('\n')[0]);
    if (!isAlive(pid, process.kill)) {
      rmSync(dir, { recursive: true, force: true }); // holder died: take over
      continue;
    }
    if (Date.now() > deadline) {
      console.error(`Gave up waiting for the emulator lock held by pid ${pid}.`);
      process.exit(1);
    }
    if (!announced)
      console.log(`Waiting for the emulator lock (held by ${info.split('\n').join(' ')})`);
    announced = true;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const release = () => rmSync(dir, { recursive: true, force: true });
// Inside the lock nothing else uses the ports, so a leftover preview server is stale: never reuse it.
const child = spawn(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, E2E_FRESH_SERVER: '1' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => {
  release();
  process.exit(code ?? (sig ? 1 : 0));
});
