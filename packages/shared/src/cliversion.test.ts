import { describe, expect, it } from 'vitest';
import {
  cliSupports,
  compareVersions,
  EVENT_MIN_VERSION,
  isOlder,
  minVersionFor,
} from './cliversion';

describe('compareVersions', () => {
  it('compares numbers, not strings', () => {
    expect(compareVersions('0.2.163', '0.2.163')).toBe(0);
    expect(compareVersions('0.2.9', '0.2.163')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.2.163')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('isOlder', () => {
  it('is false when either side is unknown', () => {
    expect(isOlder('0.2.159', '0.2.163')).toBe(true);
    expect(isOlder('0.2.163', '0.2.163')).toBe(false);
    expect(isOlder(null, '0.2.163')).toBe(false);
    expect(isOlder('0.2.1', undefined)).toBe(false);
  });
});

describe('the minimum version table', () => {
  it('has well-formed versions', () => {
    for (const v of Object.values(EVENT_MIN_VERSION)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('revise needs 0.2.163', () => {
    expect(minVersionFor('revise')).toBe('0.2.163');
    expect(cliSupports('revise', '0.2.159')).toBe('old');
    expect(cliSupports('revise', '0.2.163')).toBe('ok');
    expect(cliSupports('revise', '0.3.0')).toBe('ok');
    expect(cliSupports('revise', undefined)).toBe('unknown');
  });
  it('a kind without a row is ok for every CLI, and inherited names are no rows', () => {
    expect(cliSupports('new', '0.0.1')).toBe('ok');
    expect(minVersionFor('constructor')).toBeNull();
    expect(minVersionFor('toString')).toBeNull();
  });
});
