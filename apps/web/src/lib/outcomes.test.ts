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
  it('reply and book: the booking, the reply, then waiting', () => {
    const r = effectLines(
      'reply_book',
      {
        text: 'x',
        start: new Date(2026, 9, 29, 10).toISOString(),
        end: new Date(2026, 9, 29, 11).toISOString(),
        with: 'Sam, Rita',
      },
      { agent: 'Desk agent', channel: 'teams', to: 'Sam' },
    );
    expect(r.lead).toBe('When you approve, Desk agent will:');
    expect(r.lines).toEqual([
      'Book Thu 29 Oct 10:00–11:00 in your calendar and invite Sam, Rita',
      'Send the reply to Sam on teams, as you',
      'Mark the thread “Waiting on them” until they answer',
    ]);
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
