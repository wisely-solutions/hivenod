import { defaultGate, type Step } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import {
  canChangeGate,
  checkDraft,
  insertAfter,
  newStep,
  stepsDiffer,
  planMoves,
  withKind,
  type Removed,
} from './logic';

const agent = (id: string): Step => ({ id, name: id, kind: 'agent', description: '' });
const gate = (id: string): Step => ({
  id,
  name: id,
  kind: 'human',
  description: '',
  gate: defaultGate(['u']),
});

describe('who may change a gate', () => {
  const base = [gate('g')];
  const who = (uid: string, isAdmin = false, createdBy = 'c') => ({ uid, isAdmin, createdBy });
  it('admins, the creator and a current decider may; a plain member may not', () => {
    expect(canChangeGate(base, 'g', who('x', true))).toBe(true);
    expect(canChangeGate(base, 'g', who('c'))).toBe(true);
    expect(canChangeGate(base, 'g', who('u'))).toBe(true);
    expect(canChangeGate(base, 'g', who('x'))).toBe(false);
    expect(canChangeGate(base, 'new', who('x'))).toBe(false);
  });
  it('a plain member starts new gates with nobody deciding', () => {
    expect(newStep('human', null).gate?.deciderUids).toEqual([]);
    expect(withKind(agent('a'), 'human', null).gate?.deciderUids).toEqual([]);
  });
});

describe('process draft logic', () => {
  it('new steps are valid; a decision starts with its creator', () => {
    expect(newStep('human', 'me').gate?.deciderUids).toEqual(['me']);
    expect(newStep('agent', 'me').gate).toBeUndefined();
    expect(checkDraft([], [newStep('human', 'me'), newStep('agent', 'me')], []).issues).toEqual([]);
  });
  it('switching kind adds or drops the gate', () => {
    const s = withKind(agent('a'), 'human', 'me');
    expect(s.gate?.deciderUids).toEqual(['me']);
    expect(withKind(s, 'agent', 'me').gate).toBeUndefined();
  });
  it('inserts after an index, or at the end', () => {
    expect(insertAfter([1, 2, 3], 0, 9)).toEqual([1, 9, 2, 3]);
    expect(insertAfter([1, 2], null, 9)).toEqual([1, 2, 9]);
  });
  it('a removed step with items needs a valid target before it can be saved', () => {
    const before = [agent('a'), agent('b'), gate('g')];
    const after = [agent('a'), gate('g')];
    const removed: Removed = { step: before[1]!, index: 1, itemIds: ['i1', 'i2'], target: null };
    expect(planMoves(before, after, [removed]).issues[0]?.message).toBe(
      'Choose where the 2 items on b go.',
    );
    const ok = planMoves(before, after, [{ ...removed, target: 'a' }]);
    expect(ok.issues).toEqual([]);
    expect(ok.moves).toEqual([
      { itemId: 'i1', toStepId: 'a' },
      { itemId: 'i2', toStepId: 'a' },
    ]);
  });
  it('a gate without deciders cannot be saved', () => {
    const bad = { ...gate('g'), gate: defaultGate([]) };
    expect(checkDraft([], [agent('a'), bad], []).issues).toHaveLength(1);
  });
});

describe('stepsDiffer', () => {
  const step = (over: Partial<Step> = {}): Step => ({
    id: 's',
    name: 'S',
    kind: 'agent',
    description: '',
    ...over,
  });
  it('treats an emptied instructions text as never set', () => {
    expect(stepsDiffer([step({ instructions: '' })], [step()])).toBe(false);
    expect(stepsDiffer([step()], [step({ instructions: '' })])).toBe(false);
  });
  it('still sees a real change', () => {
    expect(stepsDiffer([step({ instructions: 'x' })], [step()])).toBe(true);
    expect(stepsDiffer([step({ name: 'T' })], [step()])).toBe(true);
  });
});
