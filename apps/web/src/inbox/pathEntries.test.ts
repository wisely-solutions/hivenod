import type { Item, Project, Step, StepProposal } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { itemsToKeepOff } from './PathEntry';
import { entryTitle } from './InboxRow';
import { buildInbox, countByFilter, filterEntries } from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });
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
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'spec', name: 'Spec', kind: 'human', description: '', gate: gate(['me']) },
  { id: 'release', name: 'Release', kind: 'human', description: '', gate: gate(['ana']) },
];
const project = {
  name: 'Web',
  emoji: 'W',
  steps,
  createdBy: 'me',
  archivedAt: null,
} as unknown as Project;
const by = { type: 'agent' as const, id: 'scout' };
const item = (over: Partial<Item>): Item =>
  ({
    title: 'Dark mode',
    type: 'task',
    stepId: 'build',
    status: 'working',
    gate: null,
    updatedAt: ts(1000),
    ...over,
  }) as unknown as Item;

describe('Needs you: path changes and step proposals (card st5INNZj)', () => {
  it('lists a pending people-step change for that step’s deciders only', () => {
    const it0 = item({
      gateSkips: { spec: '' },
      pathRequests: {
        spec: { op: 'add', by, reason: 'touches every screen', at: ts(2000) as never },
        release: { op: 'drop', by, reason: 'static page', at: ts(3000) as never },
      },
    });
    const inbox = buildInbox({
      projects: [{ id: 'p', data: project }] as never,
      items: { p: [{ id: 'i', data: it0 }] } as never,
      questions: {},
      uid: 'me',
    });
    expect(inbox.todo.map((e) => e.key)).toEqual(['p:p:i:spec']);
    expect(entryTitle(inbox.todo[0]!)).toBe('Add Spec to “Dark mode”?');
    expect(countByFilter(inbox.todo).approvals).toBe(1);
    expect(filterEntries(inbox.todo, 'approvals')).toHaveLength(1);
  });

  it('drops a change for a step the item has passed', () => {
    const it0 = item({
      stepId: 'release',
      status: 'waiting',
      pathRequests: { spec: { op: 'drop', by, reason: 'too late now', at: ts(1) as never } },
    });
    const inbox = buildInbox({
      projects: [{ id: 'p', data: project }] as never,
      items: { p: [{ id: 'i', data: it0 }] } as never,
      questions: {},
      uid: 'me',
    });
    expect(inbox.todo.filter((e) => e.kind === 'path')).toHaveLength(0);
  });

  it('lists open step proposals for approvers (admins and the project creator)', () => {
    const proposal = {
      id: 'sp',
      data: {
        name: 'Legal review',
        status: 'open',
        itemId: 'i',
        at: ts(5),
      } as unknown as StepProposal,
    };
    const input = {
      projects: [{ id: 'p', data: project }] as never,
      items: { p: [{ id: 'i', data: item({}) }] } as never,
      questions: {},
      proposals: { p: [proposal] } as never,
    };
    const mine = buildInbox({ ...input, uid: 'me' });
    expect(mine.todo.map((e) => e.key)).toEqual(['s:p:sp']);
    expect(entryTitle(mine.todo[0]!)).toBe('Add the step “Legal review” to Web?');
    expect(buildInbox({ ...input, uid: 'dave' }).todo).toHaveLength(0);
    expect(buildInbox({ ...input, uid: 'dave', isAdmin: true }).todo).toHaveLength(1);
  });

  it('keeps an accepted step off open items that have not reached it', () => {
    const lib: Step[] = [
      ...steps.slice(0, 1),
      { id: 'new', name: 'New', kind: 'agent', description: '' },
      ...steps.slice(1),
    ];
    const rows = [
      { id: 'a', data: item({ stepId: 'build', status: 'queued' }) },
      { id: 'b', data: item({ stepId: 'spec', status: 'waiting' }) },
      { id: 'c', data: item({ stepId: 'build', status: 'done' }) },
      { id: 'd', data: item({ stepId: 'build', status: 'queued', shape: null }) },
      { id: 'prop', data: item({ stepId: 'build', status: 'working' }) },
    ];
    expect(itemsToKeepOff(rows as never, lib, 'new', 'prop').map((r) => r.id)).toEqual(['a']);
  });
});
