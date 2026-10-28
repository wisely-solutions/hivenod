import type { Item, Step } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { editableSteps, pathView, skippedLine, trailRows } from './path';

const gate = (deciderUids: string[]) => ({
  deciderUids,
  groupIds: [],
  rule: 'any' as const,
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one' as const,
  remindAfterHours: 24,
});
const steps: Step[] = [
  { id: 'research', name: 'Research', kind: 'agent', description: '' },
  { id: 'spec', name: 'Spec', kind: 'human', description: '', gate: gate(['joao']) },
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'review', name: 'Review', kind: 'human', description: '', gate: gate(['me']) },
  { id: 'release', name: 'Release', kind: 'human', description: '', gate: gate(['joao']) },
];
const project = { steps };
const item = (over: Partial<Item>): Item =>
  ({
    title: 'Fix typo',
    type: 'task',
    stepId: 'build',
    status: 'queued',
    claim: null,
    gate: null,
    ...over,
  }) as Item;
const by = { type: 'agent' as const, id: 'scout' };

describe('the path strip', () => {
  it('typo fix: skips research, spec and release; you decide the review', () => {
    const v = pathView({
      project,
      item: item({
        stepId: 'review',
        status: 'waiting',
        pathSkips: { research: 'copy only' },
        gateSkips: { spec: 'tiny', release: 'static' },
      }),
      uid: 'me',
    });
    expect(v.segments.map((s) => s.state)).toEqual([
      'skipped',
      'skipped',
      'done',
      'current',
      'skipped',
    ]);
    expect(v.current).toEqual({ name: 'Review', kind: 'human', n: 2, m: 2, next: null });
    expect(v.status).toEqual({ text: 'You decide', tone: 'gate' });
    expect(skippedLine(v.skippedNames)).toBe('3 skipped: Research, Spec, Release');
    expect(trailRows(v).map((s) => s.who)).toEqual(['Done', 'You decide']);
  });

  it('a proposed people step is dashed and does not count in step n of m', () => {
    const v = pathView({
      project,
      item: item({
        stepId: 'build',
        status: 'working',
        gateSkips: { spec: '', release: '' },
        pathRequests: {
          spec: { op: 'add', by, reason: 'touches every screen', at: null as never },
        },
      }),
      uid: 'me',
      names: { joao: 'João' },
      agent: { name: 'Scout', live: true },
    });
    expect(v.segments.find((s) => s.id === 'spec')).toMatchObject({
      state: 'proposed',
      who: 'Proposed · João decides',
    });
    expect(v.current).toMatchObject({ n: 2, m: 3 });
    expect(v.status).toEqual({ text: 'Scout is working', tone: 'agent' });
    expect(v.pending).toEqual(['Spec proposed']);
  });

  it('an item waiting to be shaped says so, and every step is editable', () => {
    const it = item({ stepId: 'research', shape: null });
    const v = pathView({ project, item: it, uid: 'me' });
    expect(v.unshaped).toBe(true);
    expect(v.current).toBeNull();
    expect(v.status).toEqual({ text: 'Shaping…', tone: 'neutral' });
    expect(editableSteps(project, it)).toHaveLength(5);
    expect(
      pathView({ project, item: it, uid: 'me', agent: { name: 'Scout', live: true } }).status,
    ).toEqual({ text: 'Scout is shaping it', tone: 'agent' });
    expect(editableSteps(project, item({ stepId: 'build' })).map((s) => s.id)).toEqual([
      'review',
      'release',
    ]);
  });

  it('an item without a path is the full process', () => {
    const v = pathView({ project, item: item({ stepId: 'spec', status: 'waiting' }), uid: 'me' });
    expect(v.current).toMatchObject({ n: 2, m: 5 });
    expect(v.status).toEqual({ text: 'People decide', tone: 'gate' });
  });

  it('a done people step names who approved it and when', () => {
    const it = item({ stepId: 'build' });
    const atMs = new Date(2026, 9, 27, 14, 5).getTime();
    const v = pathView({
      project,
      item: it,
      uid: 'me',
      approvals: { spec: { name: 'João', atMs } },
    });
    expect(v.segments.find((s) => s.id === 'spec')?.who).toBe('Approved by João · 27 Oct, 14:05');
  });
});
