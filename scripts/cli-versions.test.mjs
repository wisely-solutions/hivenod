/**
 * Minimum CLI version per event kind (item N9EEnCa1MzIw5UYfe70N): packages/shared/src/cliversion.ts
 * is the one table. The Go CLI embeds a copy, cli/internal/actions/cliversions.json.
 * UPDATE_GO_CONTRACT=1 pnpm test:scripts rewrites it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EVENT_MIN_VERSION } from '../packages/shared/src/cliversion.ts';

const goFile = join(import.meta.dirname, '..', 'cli/internal/actions/cliversions.json');

it('the Go CLI embeds the same minimum-version table', () => {
  const want = `${JSON.stringify(EVENT_MIN_VERSION, null, 2)}\n`;
  if (process.env.UPDATE_GO_CONTRACT === '1') writeFileSync(goFile, want);
  let have = '';
  try {
    have = readFileSync(goFile, 'utf8');
  } catch {
    /* missing: fails below */
  }
  expect(have === want, `${goFile} out of date: run UPDATE_GO_CONTRACT=1 pnpm test:scripts`).toBe(
    true,
  );
});
