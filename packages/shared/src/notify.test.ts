import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFY_PREFS,
  approvalNotice,
  gateKey,
  inQuietHours,
  itemLink,
  notifyPrefsSchema,
  reminderDue,
  reminderNote,
  subId,
  tabTitle,
} from './notify';

const quiet = (over = {}) => ({ ...DEFAULT_NOTIFY_PREFS.quiet, enabled: true, ...over });
const at = (iso: string) => new Date(iso);

describe('inQuietHours', () => {
  it('is never quiet when disabled', () => {
    expect(inQuietHours(quiet({ enabled: false }), at('2026-01-01T23:00:00Z'))).toBe(false);
  });
  it('covers a window that crosses midnight', () => {
    expect(inQuietHours(quiet(), at('2026-01-01T23:30:00Z'))).toBe(true);
    expect(inQuietHours(quiet(), at('2026-01-02T03:00:00Z'))).toBe(true);
    expect(inQuietHours(quiet(), at('2026-01-02T08:00:00Z'))).toBe(false);
    expect(inQuietHours(quiet(), at('2026-01-02T12:00:00Z'))).toBe(false);
  });
  it('covers a same-day window', () => {
    const q = quiet({ from: '13:00', to: '14:00' });
    expect(inQuietHours(q, at('2026-01-01T13:30:00Z'))).toBe(true);
    expect(inQuietHours(q, at('2026-01-01T14:00:00Z'))).toBe(false);
  });
  it('uses the person zone', () => {
    const q = quiet({ tz: 'Asia/Tokyo' }); // UTC+9
    expect(inQuietHours(q, at('2026-01-01T14:00:00Z'))).toBe(true); // 23:00 there
    expect(inQuietHours(q, at('2026-01-01T03:00:00Z'))).toBe(false); // 12:00 there
  });
  it('falls back to UTC for a zone it does not know', () => {
    expect(inQuietHours(quiet({ tz: 'Nowhere/Land' }), at('2026-01-01T23:00:00Z'))).toBe(true);
  });
  it('an empty window is never quiet', () => {
    expect(inQuietHours(quiet({ from: '08:00', to: '08:00' }), at('2026-01-01T08:00:00Z'))).toBe(
      false,
    );
  });
});

describe('reminders', () => {
  const H = 3_600_000;
  it('is due after the hours and never when 0', () => {
    expect(reminderDue(0, 24 * H, 24)).toBe(true);
    expect(reminderDue(0, 24 * H - 1, 24)).toBe(false);
    expect(reminderDue(0, 999 * H, 0)).toBe(false);
  });
  const item = { stepId: 's2', sendBackCount: 1 };
  it('says sent only for the same arrival', () => {
    const base = { sinceMs: 0, nowMs: 30 * H, remindAfterHours: 24, item };
    expect(reminderNote({ ...base, notified: { gateKey: gateKey(item), remindedAt: 5 } })).toBe(
      'sent',
    );
    expect(reminderNote({ ...base, notified: { gateKey: 's2:0', remindedAt: 5 } })).toBe('due');
    expect(reminderNote({ ...base, notified: null })).toBe('due');
    expect(reminderNote({ ...base, nowMs: 2 * H, notified: null })).toBeNull();
  });
});

describe('texts and ids', () => {
  it('links to the item on the board', () => {
    expect(itemLink('p1', 'i1')).toBe('/p/p1?item=i1');
    expect(
      approvalNotice({
        projectName: 'Blog',
        stepName: 'Review',
        itemTitle: 'Post',
        projectId: 'p1',
        itemId: 'i1',
      }).url,
    ).toBe('/p/p1?item=i1');
  });
  it('shows the count in the tab title', () => {
    expect(tabTitle('Needs you · Hivenod', 13)).toBe('(13) Needs you · Hivenod');
    expect(tabTitle('Needs you · Hivenod', 0)).toBe('Needs you · Hivenod');
    expect(tabTitle('Needs you · Hivenod', null)).toBe('Needs you · Hivenod');
  });
  it('makes stable short subscription ids', () => {
    const e = 'https://push.example/send/abc';
    expect(subId(e)).toBe(subId(e));
    expect(subId(e)).not.toBe(subId(`${e}x`));
    expect(subId(e).length).toBeLessThan(30);
  });
  it('defaults are valid', () => {
    expect(notifyPrefsSchema.safeParse(DEFAULT_NOTIFY_PREFS).success).toBe(true);
  });
});
