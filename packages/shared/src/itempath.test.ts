import { describe, expect, it } from 'vitest';
import {
  firstOnPath,
  isUnshaped,
  libraryOrder,
  nextOnPath,
  pathChangeKind,
  pathOf,
  pathPosition,
  skipReason,
  skips,
  stepsOnPath,
} from './itempath';
import { allowedAgentsFor } from './agents';
import { isReservedStepId } from './schema';
import type { Step } from './schema';

const gate = {
  deciderUids: ['alice'],
  groupIds: [],
  rule: 'any' as const,
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one' as const,
  remindAfterHours: 24,
};
const lib: Step[] = [
  { id: 'intake', name: 'Intake', kind: 'agent', description: '' },
  { id: 'research', name: 'Research', kind: 'agent', description: '' },
  { id: 'go', name: 'Go/no-go', kind: 'human', description: '', gate },
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'accept', name: 'Accept', kind: 'human', description: '', gate },
  { id: 'release', name: 'Release', kind: 'human', description: '', gate },
];
const project = { steps: lib };
const by = { type: 'agent' as const, id: 'a' };

describe('item paths', () => {
  it('a legacy item (no skips) goes through the full library', () => {
    expect(pathOf(project, { stepId: 'build' })).toEqual(lib.map((s) => s.id));
    expect(pathPosition(project, { stepId: 'build', status: 'queued' })).toEqual({ n: 4, m: 6 });
    expect(isUnshaped({})).toBe(false);
    expect(nextOnPath(project, { stepId: 'build' })?.id).toBe('accept');
  });

  it('an unshaped item is marked by shape: null', () => {
    expect(isUnshaped({ shape: null })).toBe(true);
  });

  it('shows skipped, proposed, done, current and ahead steps', () => {
    const item = {
      stepId: 'build',
      status: 'working' as const,
      pathSkips: { research: 'Copy only' },
      gateSkips: { go: 'Small change' },
      pathRequests: {
        release: { op: 'drop' as const, by, reason: 'x', at: null as never },
        go: { op: 'add' as const, by, reason: 'y', at: null as never },
      },
    };
    expect(stepsOnPath(project, item).map((x) => [x.step.id, x.state, x.request ?? null])).toEqual([
      ['intake', 'done', null],
      ['research', 'skipped', null],
      ['go', 'proposed', 'add'],
      ['build', 'current', null],
      ['accept', 'ahead', null],
      ['release', 'ahead', 'drop'],
    ]);
    expect(stepsOnPath(project, item)[1]!.note).toBe('Copy only');
    // A proposed people step does not count until it is added.
    expect(pathPosition(project, item)).toEqual({ n: 2, m: 4 });
  });

  it('moves to the next step that is not skipped, and starts at the first one', () => {
    const item = { stepId: 'intake', pathSkips: { research: '' }, gateSkips: { go: '' } };
    expect(nextOnPath(project, item)?.id).toBe('build');
    expect(firstOnPath(project, { pathSkips: { intake: '' } })?.id).toBe('research');
    // A people step in pathSkips is not skipped: only gateSkips skips it.
    expect(nextOnPath(project, { stepId: 'research', pathSkips: { go: '' } })?.id).toBe('go');
    expect(nextOnPath(project, { stepId: 'release' })).toBeNull();
  });

  it('a finished item has every path step done', () => {
    const item = { stepId: 'release', status: 'done' as const, gateSkips: { go: '' } };
    expect(stepsOnPath(project, item).filter((x) => x.state === 'done').length).toBe(5);
  });

  it('keeps library order and drops unknown ids', () => {
    expect(libraryOrder(project, ['release', 'intake', 'zzz', 'intake'])).toEqual([
      'intake',
      'release',
    ]);
  });

  it('tells agent-step changes from people-step changes', () => {
    expect(
      pathChangeKind(project, ['intake', 'research', 'go', 'build'], ['intake', 'build', 'accept']),
    ).toEqual({
      agentAdded: [],
      agentDropped: ['research'],
      gateAdded: ['accept'],
      gateDropped: ['go'],
    });
  });
});

describe('inherited property names as step ids', () => {
  const ids = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
  const steps: Step[] = [
    { id: 'first', name: 'First', kind: 'agent', description: '' },
    ...ids.flatMap((id) => [
      { id, name: `A ${id}`, kind: 'agent' as const, description: '' },
      { id: `${id}-g`, name: `G ${id}`, kind: 'human' as const, description: '', gate },
    ]),
  ];
  const humanOf = (id: string) => ({
    ...steps.find((s) => s.id === id)!,
    id,
    kind: 'human' as const,
  });
  const proj = { steps };

  it.each(ids)('%s is not skipped or pending on an item with empty maps', (id) => {
    const item = { stepId: 'first', pathSkips: {}, gateSkips: {}, pathRequests: {} };
    const agent = steps.find((s) => s.id === id)!;
    expect(skips(item, agent)).toBe(false);
    expect(skips(item, humanOf(id))).toBe(false);
    expect(skipReason(item, agent)).toBe('');
    expect(skipReason(item, humanOf(id))).toBe('');
    expect(pathOf(proj, item)).toContain(id);
    const st = stepsOnPath(proj, item).find((x) => x.step.id === id)!;
    expect(st.state).not.toBe('skipped');
    expect(st.request ?? null).toBe(null);
    expect(allowedAgentsFor({ stepAgents: {} }, id)).toEqual([]);
  });

  it.each(ids)('%s is skipped when the item really holds it', (id) => {
    const agent = steps.find((s) => s.id === id)!;
    const item = {
      stepId: 'first',
      pathSkips: Object.defineProperty({}, id, { value: 'why', enumerable: true }),
    };
    expect(skips(item, agent)).toBe(true);
    expect(skipReason(item, agent)).toBe('why');
    expect(pathOf(proj, item)).not.toContain(id);
    expect(stepsOnPath(proj, item).find((x) => x.step.id === id)!.state).toBe('skipped');
  });

  it.each(ids)('%s is proposed when it has a real pending add', (id) => {
    const agent = steps.find((s) => s.id === id)!;
    const item = {
      stepId: 'first',
      pathSkips: Object.defineProperty({}, id, { value: '', enumerable: true }),
      pathRequests: Object.defineProperty({}, id, {
        value: { op: 'add', by, reason: 'r', at: null as never },
        enumerable: true,
      }),
    };
    const st = stepsOnPath(proj, item).find((x) => x.step.id === id)!;
    expect(st.state).toBe('proposed');
    expect(skips(item, agent)).toBe(true);
  });

  it('reserved ids are recognised and ordinary ones are not', () => {
    for (const id of ids) expect(isReservedStepId(id)).toBe(true);
    expect(isReservedStepId('prototype')).toBe(true);
    expect(isReservedStepId('build')).toBe(false);
    expect(isReservedStepId('s-ab12cd34')).toBe(false);
  });
});
