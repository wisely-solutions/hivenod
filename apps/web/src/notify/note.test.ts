import type { Notified, Project } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { gateWaitNote } from './note';

const H = 3_600_000;
const project = {
  steps: [
    { id: 'draft', name: 'Draft', kind: 'agent' },
    { id: 'review', name: 'Review', kind: 'human', gate: { remindAfterHours: 24 } },
  ],
} as unknown as Project;
const item = { stepId: 'review', sendBackCount: 0, status: 'waiting' as const };
const note = (over: {
  hours: number;
  got?: Notified;
  status?: 'waiting' | 'working';
  stepId?: string;
}) =>
  gateWaitNote({
    project,
    item: { ...item, status: over.status ?? 'waiting', stepId: over.stepId ?? 'review' },
    itemId: 'i1',
    sinceMs: 0,
    nowMs: over.hours * H,
    reminders: new Map(over.got ? [['i1', over.got]] : []),
  });
const sent: Notified = {
  itemId: 'i1',
  projectId: 'p',
  gateKey: 'review:0',
  sent: [],
  remindedAt: 1,
  at: 1,
};

describe('gateWaitNote', () => {
  it('is silent before the reminder time', () => {
    expect(note({ hours: 5 })).toBeNull();
  });
  it('says the reminder is due when the time passed and nothing was sent', () => {
    expect(note({ hours: 30 })).toBe('Waiting 30 h · reminder due');
  });
  it('says the reminder was sent once the notifier sent it', () => {
    expect(note({ hours: 30, got: sent })).toBe('Waiting 30 h · reminder sent');
  });
  it('ignores a reminder from an earlier arrival at the gate', () => {
    expect(note({ hours: 30, got: { ...sent, gateKey: 'review:1' } })).toBe(
      'Waiting 30 h · reminder due',
    );
  });
  it('is silent for items that are not waiting at a gate', () => {
    expect(note({ hours: 30, status: 'working' })).toBeNull();
    expect(note({ hours: 30, stepId: 'draft' })).toBeNull();
  });
});
