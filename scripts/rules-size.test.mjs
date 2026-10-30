import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  RULES_COMPILED_BUDGET,
  RULES_COMPILED_LIMIT,
  estimateCompiledSize,
  measureCompiledSize,
  padRules,
  parseCompiledSize,
  rulesSizeVerdict,
  rulesTokenStats,
} from './rules-size-lib.mjs';

const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

describe('rules compiled size', () => {
  it("reads the size from Google's 400", () => {
    expect(
      parseCompiledSize(
        '{"error":{"code":400,"message":"Total size of compiled executables must be smaller than 256000 bytes (actual: 262622 bytes)."}}',
      ),
    ).toBe(262622);
    expect(parseCompiledSize('HTTP Error: 409, already exists')).toBeNull();
  });

  it('pads with identical unused functions inside the service block', () => {
    const src = "rules_version = '2';\nservice cloud.firestore {\n  match /x/{y} {}\n}\n";
    const p = padRules(src, 3);
    expect(p.match(/function zzSizePad\d{5}\(x\)/g)).toHaveLength(3);
    expect(p.indexOf('zzSizePad')).toBeGreaterThan(p.indexOf('service cloud.firestore {'));
    expect(padRules(src, 0)).toBe(src);
  });

  it('measures directly when over the limit, else pads until refused', async () => {
    const over = async () => 262622;
    expect(await measureCompiledSize('src', over)).toBe(262622);
    // A fake Google: 230000 bytes plus 749 per pad function, refused at 256000 or more.
    const tries = [];
    const fake = async (s) => {
      const pads = (s.match(/zzSizePad/g) ?? []).length;
      tries.push(pads);
      const size = 230000 + 749 * pads;
      return size >= RULES_COMPILED_LIMIT ? size : null;
    };
    const src = 'service cloud.firestore {\n}\n';
    expect(await measureCompiledSize(src, fake)).toBe(230000);
    expect(tries).toEqual([0, 40, 60]);
  });

  it('says how big the rules are and when they are too big', () => {
    expect(rulesSizeVerdict(262622)).toMatch(/^rules too big: 262622 of 256000 bytes/);
    expect(rulesSizeVerdict(230000)).toMatch(/230000 of 256000 bytes \(10% headroom\)/);
  });

  it('estimates tokens and name lengths, ignoring comments', () => {
    const a = rulesTokenStats("allow read: if d.x == 'ab'; // a comment\n");
    expect(a).toEqual({ tokens: 10, words: 6, chars: 17 });
    expect(estimateCompiledSize('x // more comment')).toBe(estimateCompiledSize('x'));
  });

  // The offline guard (docs/DEPLOY.md "Rules size"): the estimate tracks Google's compiled size
  // within about 1500 bytes. Over the budget, trim the rules before merging; the release refuses
  // anything at or over 256000 bytes.
  it(`firestore.rules stays within the budget of ${RULES_COMPILED_BUDGET} bytes`, () => {
    const est = estimateCompiledSize(RULES);
    expect(
      est,
      `estimated compiled size ${est} bytes is over the budget ${RULES_COMPILED_BUDGET}: trim the rules (docs/DEPLOY.md "Rules size")`,
    ).toBeLessThanOrEqual(RULES_COMPILED_BUDGET);
  });
});
