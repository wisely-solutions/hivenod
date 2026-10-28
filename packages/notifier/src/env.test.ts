import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('reads KEY=VALUE, quotes, export and comments', () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\n\nbad\nD=a=b')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x',
      D: 'a=b',
    });
  });
});
