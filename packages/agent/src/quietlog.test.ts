import { describe, expect, it } from 'vitest';
import { quietBloomFilterWarning } from './quietlog';

describe('quietBloomFilterWarning', () => {
  it('drops only the BloomFilter warning', () => {
    const seen: unknown[][] = [];
    const target = { warn: (...a: unknown[]) => void seen.push(a) };
    const restore = quietBloomFilterWarning(target);
    target.warn('Firestore (4.19.0): BloomFilter error: ', new Error('Invalid hash count: 0'));
    target.warn('Firestore (4.19.0): Could not reach backend');
    expect(seen).toEqual([['Firestore (4.19.0): Could not reach backend']]);
    restore();
    target.warn('Firestore (4.19.0): BloomFilter error: ');
    expect(seen).toHaveLength(2);
  });
});
