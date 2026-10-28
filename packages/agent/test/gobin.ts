/**
 * The Go CLI binary for the integration tests (item zLwtX2WEEg3mER4CR74g): built once per test
 * file from cli/ with the Go toolchain (HIVENOD_GO, ~/.local/go/bin/go, /usr/local/go/bin/go or
 * `go` on PATH). Without Go the Go suites are skipped with a warning.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '../../..');

export function findGo(): string | null {
  const cands = [
    process.env.HIVENOD_GO,
    join(homedir(), '.local/go/bin/go'),
    '/usr/local/go/bin/go',
    'go',
  ].filter(Boolean) as string[];
  for (const g of cands) {
    if (g !== 'go' && !existsSync(g)) continue;
    if (spawnSync(g, ['version']).status === 0) return g;
  }
  return null;
}

export const GO = findGo();
if (!GO) console.warn('[go] Go not found: the Go CLI integration suites are skipped.');

let built = '';
/** Builds the binary (once) and returns its path. */
export function goBinary(): string {
  if (built) return built;
  if (!GO) throw new Error('Go is not installed');
  const out = join(mkdtempSync(join(tmpdir(), 'hivenod-go-')), 'hivenod');
  execFileSync(GO, ['build', '-o', out, './cmd/hivenod'], {
    cwd: join(REPO, 'cli'),
    stdio: 'inherit',
  });
  built = out;
  return out;
}

/** The environment for the binary on the emulators, with a fresh home folder. */
export function goEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    HIVENOD_HOME: home,
    HIVENOD_PROJECT_ID: 'hive-rules-test',
    HIVENOD_FIREBASE_API_KEY: 'fake-api-key',
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
    ...extra,
  };
}
