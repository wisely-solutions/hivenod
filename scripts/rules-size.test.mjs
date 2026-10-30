import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  RULES_COMPILED_BUDGET,
  RULES_COMPILED_LIMIT,
  RULES_SOURCE_LIMIT,
  SourcesTooBigError,
  compactRules,
  estimateCompiledSize,
  isSourcesTooBig,
  measureCompiledSize,
  padRules,
  parseCompiledSize,
  rulesSizeOutcome,
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
    expect(await measureCompiledSize('src', over)).toEqual({ size: 262622, exact: true });
    // A fake Google: 230000 bytes plus 749 per pad function, refused at 256000 or more.
    const tries = [];
    const fake = async (s) => {
      const pads = (s.match(/zzSizePad/g) ?? []).length;
      tries.push(pads);
      const size = 230000 + 749 * pads;
      return size >= RULES_COMPILED_LIMIT ? size : null;
    };
    const src = 'service cloud.firestore {\n}\n';
    expect(await measureCompiledSize(src, fake)).toEqual({ size: 230000, exact: true });
    expect(tries).toEqual([0, 40, 60]);
  });

  it('recognises the source-size refusal', () => {
    expect(isSourcesTooBig('Total size of sources must be smaller than 262144 bytes')).toBe(true);
    expect(isSourcesTooBig('compiled executables must be smaller than 256000 bytes')).toBe(false);
  });

  it('compacts the rules: no comments, indentation or blank lines', () => {
    const c = compactRules(
      'service cloud.firestore {\n  // note\n\n  match /x/{y} {\n    allow read;\n  }\n}\n',
    );
    expect(c).toBe('service cloud.firestore {\nmatch /x/{y} {\nallow read;\n}\n}');
  });

  it('never pads past the source limit; when the compiled limit is out of reach it reports an upper bound', async () => {
    // 108 KB of rules whose compiled size is small: each pad adds only 300 compiled bytes, so the
    // compiled limit is never reached within 256 KiB of source (the release 182 case).
    const big = `service cloud.firestore {\n${'match /a/{b} { allow read: if true; }\n'.repeat(2500)}}\n`;
    const sizes = [];
    const fake = async (s) => {
      sizes.push(s.length);
      if (s.length >= RULES_SOURCE_LIMIT) throw new SourcesTooBigError();
      const pads = (s.match(/zzSizePad/g) ?? []).length;
      const size = 126000 + 300 * pads;
      return size >= RULES_COMPILED_LIMIT ? size : null;
    };
    const m = await measureCompiledSize(big, fake);
    expect(m.exact).toBe(false);
    expect(m.size).toBeNull();
    expect(Math.max(...sizes)).toBeLessThan(RULES_SOURCE_LIMIT);
    expect(m.atMost).toBeLessThan(RULES_COMPILED_LIMIT);
    expect(m.pads).toBeGreaterThan(100);
    expect(rulesSizeOutcome(m)).toMatchObject({ pass: true, size: null });
    expect(rulesSizeOutcome(m).message).toMatch(
      /^rules fit: compiled size is at most \d+ of 256000/,
    );
  });

  it('treats a source-size refusal from Google as the same upper bound', async () => {
    const fake = async (s) => {
      if (s.includes('zzSizePad')) throw new SourcesTooBigError();
      return null;
    };
    const m = await measureCompiledSize('service cloud.firestore {\n}\n', fake);
    expect(m).toMatchObject({ exact: false, size: null, pads: 0 });
  });

  it('turns a measurement into a pass or a stop', () => {
    expect(rulesSizeOutcome({ size: 262622, exact: true })).toMatchObject({
      pass: false,
      size: 262622,
    });
    expect(rulesSizeOutcome({ size: 126000, exact: true })).toMatchObject({
      pass: true,
      size: 126000,
    });
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

  // The offline guard (docs/DEPLOY.md "Rules size and compile time"): the estimate tracks Google's compiled size
  // within about 1500 bytes. Over the budget, trim the rules before merging; the release refuses
  // anything at or over 256000 bytes.
  it(`firestore.rules stays within the budget of ${RULES_COMPILED_BUDGET} bytes`, () => {
    const est = estimateCompiledSize(RULES);
    expect(
      est,
      `estimated compiled size ${est} bytes is over the budget ${RULES_COMPILED_BUDGET}: trim the rules (docs/DEPLOY.md "Rules size and compile time")`,
    ).toBeLessThanOrEqual(RULES_COMPILED_BUDGET);
  });
});
