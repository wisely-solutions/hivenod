import { describe, expect, it } from 'vitest';
import { effectLines, isSentBack, outcomeName } from './outcomes';

describe('outcomes', () => {
  it('counts only sentBack as sent back', () => {
    expect(isSentBack('sentBack')).toBe(true);
    for (const o of ['approved', 'stopped', 'answered'] as const) expect(isSentBack(o)).toBe(false);
  });
  it('names outcomes as the app does', () => {
    expect(outcomeName('approved')).toBe('Approved');
    expect(outcomeName('sentBack')).toBe('Sent back');
    expect(outcomeName('stopped')).toBe('Stopped');
  });
});

describe('effectLines (item kt3E7, design 3.8)', () => {
  it('a retired booking is never approved (Calendar removed, slice 5)', () => {
    expect(effectLines('reply_book', { text: 'x' }, { agent: 'Desk agent' })).toEqual({
      lead: 'Bookings were removed with Calendar:',
      lines: ['This proposal can only be rejected'],
    });
  });
  it('types that take effect at once say nothing is sent', () => {
    expect(effectLines('ignore', {}, { agent: 'A' })).toEqual({
      lead: 'When you approve, it takes effect at once:',
      lines: ['Ignore the thread; nothing is sent'],
    });
    expect(effectLines('make_it_work', { title: 'Fix it' }, { agent: 'A' }).lines).toEqual([
      'Create the item “Fix it”',
      'Keep the thread waiting on the item',
    ]);
  });
});
