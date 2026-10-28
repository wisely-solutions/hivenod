#!/usr/bin/env node
// Usage: node scripts/emu-exec.mjs "<command>"   (what test:rules, test:rules:mutate and friends run)
// Runs the command inside Auth and Firestore emulators of its own: every port (auth, firestore, hub,
// logging, websocket) is picked for this run (the worktree's rules block when free, else any free ones)
// and handed to the emulators through a generated firebase.json, and to the command through
// FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST. So worktrees, releases and the e2e run side by
// side with no machine-wide lock (card 6gP0LNYO). The emulator UI is off.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emulatorConfig, pickPorts, RULES_OFFSET } from './e2e-lib.mjs';
import { emuExecPlan } from './emu-exec-lib.mjs';

const cmd = process.argv.slice(2).join(' ');
if (!cmd.trim()) {
  console.error('Usage: node scripts/emu-exec.mjs "<command>"');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ports = await pickPorts(root, undefined, RULES_OFFSET);
const tmp = mkdtempSync(join(tmpdir(), 'hive-emu-'));
const config = join(tmp, 'firebase.json');
writeFileSync(config, JSON.stringify(emulatorConfig(root, ports), null, 2));
console.log(
  `emu-exec: emulators on auth ${ports.auth}, firestore ${ports.firestore} (hub ${ports.hub})`,
);

const plan = emuExecPlan({ root, config, tmp, ports, cmd });
const child = spawn(plan.file, plan.args, { cwd: process.cwd(), stdio: 'inherit', env: plan.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => {
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code ?? (sig ? 1 : 0));
});
