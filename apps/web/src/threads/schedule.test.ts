import { describe, expect, it } from 'vitest';
import type { ScheduleOf } from '@hive/shared';
import { cantRunText, scheduleCard, sentenceWithZone } from './schedule';

const S: ScheduleOf = {
  memberUid: 'm',
  agentUid: 'a',
  title: 'Send invoices',
  what: 'Prepare the invoices.',
  rule: { freq: 'monthly', at: '09:00', tz: 'Europe/Lisbon', monthDay: 1 },
  runTitle: 'Send invoices · {month} {year}',
  steps: [
    { type: 'reply', fields: { text: 'Invoices for {period} are ready.' } },
    { type: 'approval', fields: { what: 'Send the invoices for {period}' } },
  ],
  templateId: null,
  subjectId: null,
  state: 'proposed',
  proposal: { threadId: 't', outcomeId: 'o', by: 'a' },
  replaces: null,
  version: 1,
};
const NOW = Date.UTC(2026, 9, 30, 12);

describe('the schedule proposal card', () => {
  it('asks in words, names the zone, shows the next 3 runs and each run’s thread', () => {
    const c = scheduleCard(S, NOW);
    expect(c.ask).toBe('Set up “Send invoices” every month?');
    expect(c.sentence).toBe('Monthly · day 1 · 09:00 (Lisbon)');
    expect(c.runs).toEqual([
      'Sun 1 Nov 2026 · 09:00',
      'Tue 1 Dec 2026 · 09:00',
      'Fri 1 Jan 2027 · 09:00',
    ]);
    expect(c.runTitle).toBe('Send invoices · Nov 2026');
    expect(c.steps).toEqual([
      { title: 'Reply: “Invoices for Nov 2026 are ready.”', who: 'agent' },
      { title: 'Send the invoices for Nov 2026', who: 'you' },
    ]);
    expect(c.cantRun).toMatch(/at once \(high\)/);
  });

  it('a change asks to change; a passed one-off has no runs; rarer is louder', () => {
    expect(scheduleCard({ ...S, replaces: 's1' }, NOW).ask).toBe('Change “Send invoices”?');
    const once = scheduleCard(
      { ...S, rule: { freq: 'once', at: '10:00', date: '2026-10-01' } },
      NOW,
    );
    expect(once.runs).toEqual([]);
    expect(once.runTitle).toBe('Send invoices · {month} {year}');
    expect(
      sentenceWithZone({ freq: 'weekly', at: '16:00', tz: 'America/New_York', weekdays: [5] }),
    ).toBe('Weekly · Fri · 16:00 (New York)');
    expect(cantRunText('yearly')).toMatch(/urgent/);
    expect(cantRunText('daily')).toMatch(/digest/);
  });
});
