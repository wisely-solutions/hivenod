/**
 * Golden files for the Go CLI contract suite (item MlWOc3O5NyfZcLgetrVo): one JSON file per test
 * in ../golden, named after the test. They were first recorded when the TypeScript client and
 * the Go CLI gave the same masked results, so they keep that behaviour now that only Go is left.
 * After an intended change, rewrite them with UPDATE_GOLDEN=1 and review the diff.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

const DIR = join(import.meta.dirname, '../golden');

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

/** The current test's result must equal its golden file (UPDATE_GOLDEN=1 rewrites it). */
export function matchesGolden(value: unknown) {
  // The test's own name, without its describe blocks.
  const name = (expect.getState().currentTestName ?? 'unnamed').split(' > ').pop()!;
  const file = join(DIR, `${slug(name)}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  expect(existsSync(file), `${file} is missing: record it with UPDATE_GOLDEN=1`).toBe(true);
  expect(JSON.parse(text), `differs from ${file} (UPDATE_GOLDEN=1 if intended)`).toEqual(
    JSON.parse(readFileSync(file, 'utf8')),
  );
}
