import { describe, expect, it } from 'vitest';
import { laterKeyboard, runKeyboard } from './telegram';

describe('run keyboards (scheduled tasks)', () => {
  it('one ask: Run now · Try later / Skip this one · Open', () => {
    expect(runKeyboard([{ code: 'c1', title: 'Send invoices' }], 'https://app/x')).toEqual([
      [
        { text: 'Run now', callback_data: 'xn:c1' },
        { text: 'Try later', callback_data: 'xl:c1' },
      ],
      [
        { text: 'Skip this one', callback_data: 'xs:c1' },
        { text: 'Open', url: 'https://app/x' },
      ],
    ]);
  });

  it('a digest: Run now · Skip per run, then Open', () => {
    const k = runKeyboard(
      [
        { code: 'a', title: 'Clean-up' },
        { code: 'b', title: 'A very long schedule title that does not fit a button' },
      ],
      'https://app/',
      true,
    );
    expect(k.map((r) => r.map((b) => b.callback_data ?? b.url))).toEqual([
      ['xn:a', 'xs:a'],
      ['xn:b', 'xs:b'],
      ['https://app/'],
    ]);
    expect(k[0]![0]!.text).toBe('Run now · Clean-up');
    expect(k[1]![0]!.text.length).toBeLessThanOrEqual(40);
  });

  it('Try later: in 1 hour, tomorrow 09:00, pick a time', () => {
    expect(
      laterKeyboard('c')
        .flat()
        .map((b) => [b.text, b.callback_data]),
    ).toEqual([
      ['In 1 hour', 'xh:c'],
      ['Tomorrow 09:00', 'xt:c'],
      ['Pick a time…', 'xp:c'],
    ]);
  });
});
