/**
 * The Go port of the agent's shared actions (cli/internal/actions) must build the same plans as
 * the TypeScript ones. cli/contract/cases.ts runs the TypeScript actions on fixed inputs; this
 * test keeps their output in the committed fixture cli/internal/actions/testdata/contract.json,
 * which the Go test (contract_test.go) checks the Go actions against.
 *
 * After changing a shared action (or the cases): UPDATE_GO_CONTRACT=1 pnpm test:scripts, then
 * make `cd cli && go test ./internal/actions` pass again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { buildCases } from '../cli/contract/cases.ts';

const root = join(import.meta.dirname, '..');
const fixture = join(root, 'cli/internal/actions/testdata/contract.json');

describe('Go actions contract', () => {
  it('the fixture matches the TypeScript actions', async () => {
    const built = JSON.parse(JSON.stringify(buildCases()));
    if (process.env.UPDATE_GO_CONTRACT) {
      mkdirSync(dirname(fixture), { recursive: true });
      writeFileSync(
        fixture,
        await format(JSON.stringify(built), {
          ...(await resolveConfig(fixture)),
          filepath: fixture,
        }),
      );
      return;
    }
    const hint =
      'The Go contract fixture is out of date: run UPDATE_GO_CONTRACT=1 pnpm test:scripts (then cd cli && go test ./internal/actions)';
    expect(existsSync(fixture), hint).toBe(true);
    const stored = JSON.parse(readFileSync(fixture, 'utf8'));
    const byName = (cs) => Object.fromEntries(cs.map((c) => [c.name, c]));
    const want = byName(built.cases);
    const have = byName(stored.cases);
    const missing = Object.keys(want).filter((n) => !(n in have));
    const extra = Object.keys(have).filter((n) => !(n in want));
    const changed = Object.keys(want).filter(
      (n) => n in have && JSON.stringify(want[n]) !== JSON.stringify(have[n]),
    );
    expect({ missing, extra, changed }, hint).toEqual({ missing: [], extra: [], changed: [] });
    expect(stored, hint).toEqual(built);
  });

  it('every case has a unique name and an action', () => {
    const { cases } = buildCases();
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    for (const c of cases) expect(typeof c.action).toBe('string');
  });
});
