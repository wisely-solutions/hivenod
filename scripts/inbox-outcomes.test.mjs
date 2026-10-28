/**
 * Inbox outcomes (item 4PEHrOW5IfXBQWgOK9wo): packages/shared/src/outcomes.ts is the one
 * registry. Its generated copies must match it: the rules block in firestore.rules (between
 * "BEGIN outcome registry" and "END outcome registry") and the Go CLI's embedded
 * cli/internal/actions/outcomes.json. UPDATE_GO_CONTRACT=1 pnpm test:scripts rewrites both.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OUTCOMES, outcomeRulesBlock } from '../packages/shared/src/outcomes.ts';

const root = join(import.meta.dirname, '..');
const rulesFile = join(root, 'firestore.rules');
const goFile = join(root, 'cli/internal/actions/outcomes.json');
const update = process.env.UPDATE_GO_CONTRACT === '1';
const hint = 'out of date: run UPDATE_GO_CONTRACT=1 pnpm test:scripts';

it('firestore.rules carries the generated outcome registry', () => {
  const rules = readFileSync(rulesFile, 'utf8');
  const re = /^ {6}\/\/ BEGIN outcome registry[\s\S]*?\/\/ END outcome registry$/m;
  expect(re.test(rules), 'firestore.rules has no outcome registry block').toBe(true);
  const want = outcomeRulesBlock();
  if (update) writeFileSync(rulesFile, rules.replace(re, want));
  expect(
    readFileSync(rulesFile, 'utf8').match(re)?.[0],
    `firestore.rules outcome registry ${hint}`,
  ).toBe(want);
});

it('the Go CLI embeds the same registry', () => {
  const want = `${JSON.stringify(OUTCOMES, null, 2)}\n`;
  if (update) writeFileSync(goFile, want);
  let have = '';
  try {
    have = readFileSync(goFile, 'utf8');
  } catch {
    /* missing: fails below */
  }
  expect(have === want, `${goFile} ${hint}`).toBe(true);
});
