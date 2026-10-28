import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('no dead ends', () => {
  it('no screen promises a later build', () => {
    const hits = Object.entries(sources)
      .filter(([f]) => !f.endsWith('noPlaceholders.test.ts'))
      .filter(([, src]) =>
        /arrives with Build|shortcut is ready; the screen is next/i.test(src as string),
      )
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });
});
