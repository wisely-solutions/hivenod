import { describe, expect, it } from 'vitest';
import {
  RULES_COMPILE_DEADLINE_MS,
  TINY_RULES,
  compileVerdict,
  probeCompile,
} from './rules-compile-lib.mjs';

const ok = (ms) => ({ status: 200, ms, errors: 0, message: '' });
const slow = (ms = 6100) => ({
  status: 503,
  ms,
  errors: 0,
  message: 'The service is currently unavailable.',
});

describe('rules compile time', () => {
  it('passes when every try compiles, and says how long it took', () => {
    const v = compileVerdict({ ours: [ok(2100), ok(2600), ok(2300)] });
    expect(v.verdict).toBe('ok');
    expect(v.message).toMatch(/2300 ms/);
    expect(v.message).toMatch(/Google times out ~6 s/);
  });

  it('fails fast when our rules never compile but a tiny ruleset does', () => {
    const v = compileVerdict({ ours: [slow(6131), slow(6171), slow(6050)], tiny: [ok(300)] });
    expect(v.verdict).toBe('too-slow');
    expect(v.message).toBe('rules compile too slow: 6131 ms (Google times out ~6 s)');
  });

  it('tells a Google outage apart: the tiny ruleset fails too', () => {
    const v = compileVerdict({ ours: [slow(), slow(), slow()], tiny: [slow(900)] });
    expect(v.verdict).toBe('outage');
    expect(v.message).toMatch(/Google's rules API is unavailable/);
  });

  it('warns but goes on when every try compiles close to the deadline', () => {
    const v = compileVerdict({ ours: [ok(5100), ok(5800), ok(4900)] });
    expect(v.verdict).toBe('borderline');
    expect(v.message).toMatch(/5100 ms, over the budget of 4500 ms/);
  });

  it('warns but goes on when only some tries compile (borderline)', () => {
    const v = compileVerdict({ ours: [ok(5200), slow(), ok(5400)] });
    expect(v.verdict).toBe('borderline');
    expect(v.message).toMatch(/1 of 3 tries timed out/);
  });

  it('refuses rules with a compile error (they compile fast and look healthy)', () => {
    const bad = { status: 200, ms: 900, errors: 1, message: 'ERROR: Expression is too complex' };
    const v = compileVerdict({ ours: [bad, bad, bad] });
    expect(v.verdict).toBe('invalid');
    expect(v.message).toMatch(/Expression is too complex/);
  });

  it('probes our rules, and the tiny ruleset only when ours never compile', async () => {
    const seen = [];
    const compile = async (source) => {
      seen.push(source === TINY_RULES ? 'tiny' : 'ours');
      return source === TINY_RULES ? ok(250) : slow();
    };
    const v = await probeCompile({ source: 'ours', compile, tries: 3 });
    expect(seen).toEqual(['ours', 'ours', 'ours', 'tiny']);
    expect(v.verdict).toBe('too-slow');

    seen.length = 0;
    const fine = await probeCompile({ source: 'ours', compile: async () => ok(1800), tries: 2 });
    expect(fine.verdict).toBe('ok');
    expect(RULES_COMPILE_DEADLINE_MS).toBe(6000);
  });

  it('counts a network failure as a try that did not compile', async () => {
    const compile = async () => {
      throw new Error('fetch failed');
    };
    const v = await probeCompile({ source: 'ours', compile, tries: 2 });
    expect(v.verdict).toBe('outage');
  });
});
