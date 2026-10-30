import { describe, expect, it } from 'vitest';
import { added, onlyFrom, redact } from './smoke-claude.mjs';

describe('smoke-claude guard helpers', () => {
  it('reports only pids that were not in the baseline', () => {
    const before = new Map([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(
      added(
        before,
        new Map([
          [1, 'a'],
          [2, 'b'],
        ]),
      ),
    ).toEqual([]);
    expect(
      added(
        before,
        new Map([
          [1, 'a'],
          [9, 'telegram'],
        ]),
      ),
    ).toEqual([9]);
  });
  it('redacts agent tokens and credentials', () => {
    expect(redact('x hive_agt_abc123-_ y')).toBe('x hive_agt_*** y');
    expect(redact('sk-ant-oat01-abcDEF')).toBe('sk-ant-***');
  });
  it('takes --only connect|basic|inbox', () => {
    expect(onlyFrom([])).toBe('');
    expect(onlyFrom(['--only', 'basic'])).toBe('basic');
    expect(() => onlyFrom(['--only', 'park'])).toThrow();
    expect(onlyFrom(['--only', 'connect'])).toBe('connect');
    expect(onlyFrom(['--only', 'inbox'])).toBe('inbox');
    expect(() => onlyFrom(['--only', 'x'])).toThrow(/connect, basic or inbox/);
  });
});
