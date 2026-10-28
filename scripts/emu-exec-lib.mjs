// Pure helpers for scripts/emu-exec.mjs (kept apart so they test without starting emulators).
import { join } from 'node:path';

/**
 * How to start `firebase emulators:exec` for one run: the repo's firebase, the run's own config (its
 * ports), its own TMPDIR (the emulator hub writes a per-project locator file there, so runs must not
 * share one) and the emulator hosts for the command and anything it spawns.
 */
export function emuExecPlan({ root, config, tmp, ports, cmd, env = process.env }) {
  return {
    file: join(root, 'node_modules/.bin/firebase'),
    args: [
      'emulators:exec',
      '--config',
      config,
      '--only',
      'auth,firestore',
      '--project',
      'hive-board-43be',
      cmd,
    ],
    env: {
      ...env,
      TMPDIR: tmp,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
      // A preview server left over from another run is never ours: always start a fresh one.
      E2E_FRESH_SERVER: '1',
    },
  };
}
