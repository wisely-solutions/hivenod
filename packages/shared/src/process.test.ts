import { describe, expect, it } from 'vitest';
import {
  defaultGate,
  diffProcess,
  moveTargets,
  plainSummary,
  plainWords,
  resolveDeciders,
  splitDeciders,
  validateProcess,
  type GroupRef,
} from './process';
import { saveProcess } from './actions';
import { stepSchema, type Gate, type Step } from './schema';

const names = { j: 'João', a: 'Ana', b: 'Bia', c: 'Caio' };
const product: GroupRef = { id: 'g1', name: 'Product', memberUids: ['j', 'a', 'b'] };
const gate = (over: Partial<Gate>): Gate => ({ ...defaultGate(['j', 'a', 'b']), ...over });

describe('plainWords', () => {
  it('matches the design copy for "2 of Product, João must be one"', () => {
    const g = gate({
      rule: 'atLeast',
      n: 2,
      groupIds: ['g1'],
      mustInclude: ['j'],
      remindAfterHours: 0,
    });
    expect(plainWords(g, names, [product])).toBe(
      'At least 2 of Product (3 people) must approve, and João must be one of them. One rejection sends it back.',
    );
  });
  it('covers every rule', () => {
    const base = { groupIds: [], remindAfterHours: 0 };
    expect(plainWords(gate({ ...base, rule: 'any' }), names)).toBe(
      'Any one of João, Ana and Bia can approve. One rejection sends it back.',
    );
    expect(plainWords(gate({ ...base, rule: 'atLeast', n: 2 }), names)).toBe(
      'At least 2 of João, Ana and Bia must approve. One rejection sends it back.',
    );
    expect(plainWords(gate({ ...base, rule: 'all' }), names)).toBe(
      'Everyone in João, Ana and Bia must approve. One rejection sends it back.',
    );
    expect(plainWords(gate({ ...base, rule: 'specific' }), names)).toBe(
      'João, Ana and Bia must each approve. One rejection sends it back.',
    );
  });
  it('handles one decider, several must-includes, majority and reminders', () => {
    expect(plainWords(gate({ deciderUids: ['j'], remindAfterHours: 1 }), names)).toBe(
      'João decides. One rejection sends it back. If nobody decides in 1 hour, a reminder badge shows.',
    );
    expect(
      plainWords(
        gate({
          rule: 'any',
          mustInclude: ['j', 'a'],
          rejectPolicy: 'majority',
          remindAfterHours: 48,
        }),
        names,
      ),
    ).toBe(
      'Any one of João, Ana and Bia can approve, and João and Ana must all be among them. It goes back only if most of them reject. If nobody decides in 48 hours, a reminder badge shows.',
    );
  });
  it('mixes a group with extra people', () => {
    const g = gate({
      deciderUids: ['j', 'a', 'b', 'c'],
      groupIds: ['g1'],
      rule: 'any',
      remindAfterHours: 0,
    });
    expect(plainWords(g, names, [product])).toBe(
      'Any one of Product and Caio can approve. One rejection sends it back.',
    );
  });
  it('explains the empty and impossible cases', () => {
    expect(plainWords(gate({ deciderUids: [] }), names)).toMatch(/Nobody is chosen/);
    expect(plainWords(gate({ rule: 'atLeast', n: 5, remindAfterHours: 0 }), names)).toMatch(
      /needs 5 approvals but only 3 people/,
    );
  });
  it('summary carries the reject policy, not the reminder', () => {
    expect(plainSummary(gate({ rule: 'all' }), names)).toBe(
      'Everyone in João, Ana and Bia must approve. One rejection sends it back.',
    );
    expect(plainSummary(gate({ rule: 'all', rejectPolicy: 'majority' }), names)).toBe(
      'Everyone in João, Ana and Bia must approve. It goes back only if most of them reject.',
    );
  });
  it('reads naturally for one person, alone or through a group', () => {
    const solo = { deciderUids: ['j'], remindAfterHours: 0 };
    const team: GroupRef = { id: 'g2', name: 'R26 deciders', memberUids: ['j'] };
    for (const rule of ['atLeast', 'all', 'specific'] as const) {
      expect(plainWords(gate({ ...solo, rule, n: 1 }), names)).toBe(
        'João must approve. One rejection sends it back.',
      );
      expect(plainWords(gate({ ...solo, rule, n: 1, groupIds: ['g2'] }), names, [team])).toBe(
        'João must approve. One rejection sends it back.',
      );
    }
    expect(plainWords(gate({ ...solo, rule: 'any' }), names)).toBe(
      'João decides. One rejection sends it back.',
    );
  });
  it('uses "any one of" for at least 1 of several', () => {
    expect(plainWords(gate({ rule: 'atLeast', n: 1, remindAfterHours: 0 }), names)).toBe(
      'Any one of João, Ana and Bia can approve. One rejection sends it back.',
    );
  });
  it('always reflects the reject policy: every rule x policy x decider shape', () => {
    const shapes: Array<[string, Partial<Gate>, GroupRef[]]> = [
      ['one person', { deciderUids: ['j'], groupIds: [] }, []],
      [
        'one person via group',
        { deciderUids: ['j'], groupIds: ['g2'] },
        [{ id: 'g2', name: 'R26 deciders', memberUids: ['j'] }],
      ],
      ['three people', {}, []],
      ['group of three', { groupIds: ['g1'] }, [product]],
    ];
    for (const [, shape, groups] of shapes) {
      for (const rule of ['any', 'atLeast', 'all', 'specific'] as const) {
        const one = gate({ ...shape, rule, n: 1, rejectPolicy: 'one', remindAfterHours: 0 });
        const maj = gate({ ...shape, rule, n: 1, rejectPolicy: 'majority', remindAfterHours: 0 });
        expect(plainWords(one, names, groups)).toContain('One rejection sends it back.');
        expect(plainWords(one, names, groups)).not.toMatch(/most/);
        expect(plainWords(maj, names, groups)).toMatch(/goes back only if most/);
        expect(plainWords(maj, names, groups)).not.toContain('One rejection');
        expect(plainSummary(maj, names, groups)).toMatch(/goes back only if most/);
        expect(plainSummary(one, names, groups)).toContain('One rejection sends it back.');
        expect(plainWords(maj, names, groups)).not.toMatch(/At least 1 of/);
      }
    }
  });
});

describe('deciders', () => {
  it('resolves people and groups without duplicates, and splits back', () => {
    const d = { people: ['c', 'j'], groupIds: ['g1'] };
    const all = resolveDeciders(d, [product]);
    expect(all).toEqual(['c', 'j', 'a', 'b']);
    expect(splitDeciders({ deciderUids: all, groupIds: ['g1'] }, [product])).toEqual({
      people: ['c'],
      groupIds: ['g1'],
    });
  });
  it('drops groups that no longer exist', () => {
    expect(splitDeciders({ deciderUids: ['j'], groupIds: ['gone'] }, [])).toEqual({
      people: ['j'],
      groupIds: [],
    });
  });
});

const agent = (id: string): Step => ({ id, name: id, kind: 'agent', description: '' });
const human = (id: string, g: Gate = defaultGate(['j'])): Step => ({
  id,
  name: id,
  kind: 'human',
  description: '',
  gate: g,
});

describe('validateProcess', () => {
  it('rejects a gate without deciders and an impossible n', () => {
    const issues = validateProcess([agent('x'), human('g', defaultGate([]))]);
    expect(issues).toEqual([{ stepId: 'g', message: 'g needs someone to decide.' }]);
    expect(
      validateProcess([human('g', { ...defaultGate(['j']), rule: 'atLeast', n: 2 })]),
    ).toHaveLength(1);
    expect(validateProcess([agent('x'), human('g')])).toEqual([]);
  });
  it('refuses reserved step ids (constructor, toString, __proto__, prototype)', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'prototype']) {
      expect(validateProcess([agent(id)]).map((i) => i.stepId)).toEqual([id]);
      expect(stepSchema.safeParse(agent(id)).success).toBe(false);
      expect(() =>
        saveProcess({ actor: { type: 'human', id: 'u', name: 'U' } } as never, {
          projectId: 'p',
          steps: [agent(id)],
        }),
      ).toThrow(/reserved/);
    }
    expect(validateProcess([agent('s-abc12345')])).toEqual([]);
  });
  it('rejects a blank name and no steps', () => {
    expect(validateProcess([{ ...agent('x'), name: '  ' }])).toHaveLength(1);
    expect(validateProcess([])).toHaveLength(1);
  });
});

describe('diffProcess', () => {
  it('reports added, removed, reordered and changed steps', () => {
    const before = [agent('a'), agent('b'), human('g')];
    const after = [agent('b'), { ...agent('a'), name: 'A2' }, agent('n')];
    expect(diffProcess(before, after)).toEqual({
      added: ['n'],
      removed: ['g'],
      reordered: true,
      changed: { a: ['name'] },
    });
  });
});

describe('moveTargets', () => {
  const before = [agent('a'), agent('b'), human('g'), agent('c')];
  it('offers earlier steps, and the next one after an agent step', () => {
    expect(
      moveTargets(
        before,
        'b',
        before.filter((s) => s.id !== 'b'),
      ).map((s) => s.id),
    ).toEqual(['a', 'g']);
    expect(
      moveTargets(
        before,
        'g',
        before.filter((s) => s.id !== 'g'),
      ).map((s) => s.id),
    ).toEqual(['a', 'b']);
    expect(
      moveTargets(
        before,
        'a',
        before.filter((s) => s.id !== 'a'),
      ).map((s) => s.id),
    ).toEqual(['b']);
  });
});
