/**
 * Thread summaries (item OE8FmrTaIxFVGcaeGG3N): packages/shared/src/summary.ts holds the limits
 * and shapes. firestore.rules carries the generated checks (between "BEGIN summary checks" and
 * "END summary checks"); UPDATE_GO_CONTRACT=1 pnpm test:scripts rewrites them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { summaryRulesBlock } from '../packages/shared/src/summary.ts';

const rulesFile = join(import.meta.dirname, '..', 'firestore.rules');

it('firestore.rules carries the generated summary checks', () => {
  const rules = readFileSync(rulesFile, 'utf8');
  const re = /^ {6}\/\/ BEGIN summary checks[\s\S]*?\/\/ END summary checks$/m;
  expect(re.test(rules), 'firestore.rules has no summary checks block').toBe(true);
  const want = summaryRulesBlock();
  if (process.env.UPDATE_GO_CONTRACT === '1') writeFileSync(rulesFile, rules.replace(re, want));
  expect(
    readFileSync(rulesFile, 'utf8').match(re)?.[0],
    'firestore.rules summary checks out of date: run UPDATE_GO_CONTRACT=1 pnpm test:scripts',
  ).toBe(want);
});
