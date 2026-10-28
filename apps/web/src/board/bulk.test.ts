import { describe, expect, it } from 'vitest';
import type { Project } from '@hive/shared';
import { bulkBlocker, eligible, movableSteps, rangeKeys, type Who } from './bulk';
import type { ListRow } from './logic';

const ts = { toMillis: () => 0 };
const project = {
  name: 'P',
  steps: [
    { id: 's1', name: 'Plan', kind: 'agent' },
    { id: 's2', name: 'Review', kind: 'human', gate: { deciderUids: ['me'] } },
    { id: 's3', name: 'Build', kind: 'agent' },
  ],
} as unknown as Project;

function row(over: Record<string, unknown> = {}, stepIndex = 0, pid = 'p'): ListRow {
  const step = project.steps[stepIndex]!;
  return {
    pid,
    project,
    stepIndex,
    stepName: step.name,
    agentName: '',
    mine: false,
    row: {
      id: `i${Math.random()}`,
      data: {
        title: 't',
        summary: '',
        type: 'idea',
        stepId: step.id,
        status: step.kind === 'human' ? 'waiting' : 'queued',
        claim: null,
        gate: step.kind === 'human' ? { stepId: step.id, approvals: {}, rejections: {} } : null,
        createdBy: { type: 'human', id: 'other' },
        updatedAt: ts,
        ...over,
      },
    },
  } as unknown as ListRow;
}
const member: Who = { uid: 'me', isAdmin: false };
const admin: Who = { uid: 'boss', isAdmin: true };

describe('bulk permissions mirror the rules', () => {
  it('approves only where the person decides and has not yet', () => {
    const at = row({}, 1);
    const elsewhere = row({}, 0);
    expect(eligible([at, elsewhere], { kind: 'approve' }, member)).toEqual([at]);
    expect(eligible([at], { kind: 'approve' }, { uid: 'someone', isAdmin: true })).toEqual([]);
  });

  it('lets a member move back but not forward, an admin both; never a held item', () => {
    const back = { kind: 'move', toStepId: 's1' } as const;
    const fwd = { kind: 'move', toStepId: 's3' } as const;
    const r = row({}, 1);
    expect(bulkBlocker(r, back, member)).toBeNull();
    expect(bulkBlocker(r, fwd, member)).toMatch(/admin/);
    expect(bulkBlocker(r, fwd, admin)).toBeNull();
    expect(bulkBlocker(r, { kind: 'move', toStepId: 's2' }, admin)).toMatch(/already/);
    const held = row({ claim: { agentUid: 'a' }, status: 'working' }, 0);
    expect(bulkBlocker(held, back, admin)).toMatch(/agent/);
  });

  it('changes type and archives only for the creator or an admin, and not suggestions', () => {
    const mine = row({ createdBy: { type: 'human', id: 'me' } });
    const theirs = row();
    const t = { kind: 'type', type: 'bug' } as const;
    expect(bulkBlocker(mine, t, member)).toBeNull();
    expect(bulkBlocker(theirs, t, member)).toMatch(/creator/);
    expect(bulkBlocker(theirs, t, admin)).toBeNull();
    expect(bulkBlocker(row({ type: 'finding' }), t, admin)).toMatch(/suggestion/);
    expect(bulkBlocker(mine, { kind: 'archive' }, member)).toBeNull();
    expect(bulkBlocker(theirs, { kind: 'archive' }, member)).toMatch(/creator/);
  });

  it('offers move targets only inside one project', () => {
    expect(movableSteps([row({}, 2)], member).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(movableSteps([row({}, 2), row({}, 2, 'q')], member)).toEqual([]);
  });
});

describe('range selection', () => {
  it('selects between two rows in either direction', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(rangeKeys(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeKeys(order, 'c', 'a')).toEqual(['a', 'b', 'c']);
    expect(rangeKeys(order, 'zz', 'c')).toEqual(['c']);
  });
});

describe('restore', () => {
  it('restores archived items of the creator or an admin only', () => {
    const archived = row({ status: 'stopped', archivedAt: ts, gate: null });
    const mine = row({
      status: 'stopped',
      archivedAt: ts,
      gate: null,
      createdBy: { type: 'human', id: 'me' },
    });
    const open = row({});
    const a = { kind: 'restore' } as const;
    expect(eligible([archived, mine, open], a, member)).toEqual([mine]);
    expect(eligible([archived, open], a, admin)).toEqual([archived]);
  });

  it('restores a rejected item (stopped, never archived) but not a cancelled one', () => {
    const rejected = row({ status: 'stopped', gate: null });
    const cancelled = row({
      status: 'stopped',
      gate: null,
      workStopped: { mode: 'cancel', byUid: 'x' } as never,
    });
    const a = { kind: 'restore' } as const;
    expect(eligible([rejected, cancelled], a, admin)).toEqual([rejected]);
  });
});
