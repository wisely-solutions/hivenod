import { describe, expect, it } from 'vitest';
import { effectLines } from './outcomes';

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
  });
  it('a retired Build it step is never approved (Projects removed, slice 11)', () => {
    expect(effectLines('make_it_work', { title: 'Fix it' }, { agent: 'A' })).toEqual({
      lead: 'Items were removed with Projects:',
      lines: ['This proposal can only be rejected'],
    });
  });
});
