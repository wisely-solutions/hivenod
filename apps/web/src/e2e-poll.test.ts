import { describe, expect, it } from 'vitest';
import { pollFor } from '../e2e/poll';

describe('pollFor', () => {
  it('waits until the value shows up', async () => {
    let calls = 0;
    const got = await pollFor(async () => (++calls >= 3 ? 'uid-1' : undefined), 'nope', 1000, 5);
    expect(got).toBe('uid-1');
    expect(calls).toBe(3);
  });

  it('throws the given message after the timeout', async () => {
    await expect(
      pollFor(async () => undefined, 'No user for that email yet', 50, 5),
    ).rejects.toThrow('No user for that email yet');
  });
});
