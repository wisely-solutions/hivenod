import { describe, expect, it } from 'vitest';
import { evaluateGate, gateSatisfied, joinNames, rejectionsSuffice } from './gates';
import type { Gate, Step } from './schema';

const gate = (over: Partial<Gate> = {}): Gate => ({
  deciderUids: ['a', 'b', 'c'],
  groupIds: [],
  rule: 'any',
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one',
  remindAfterHours: 24,
  ...over,
});
const human = (over: Partial<Gate> = {}): Pick<Step, 'kind' | 'gate'> => ({
  kind: 'human',
  gate: gate(over),
});
const at = { at: { seconds: 0, nanoseconds: 0, toMillis: () => 0 }, rationale: '' };

describe('evaluateGate: rules', () => {
  it('any: one decider is enough', () => {
    expect(evaluateGate(human(), [], []).canAdvance).toBe(false);
    expect(evaluateGate(human(), ['b'], []).canAdvance).toBe(true);
    expect(evaluateGate(human(), { b: at }, {}).canAdvance).toBe(true);
  });
  it('non-deciders never count', () => {
    const r = evaluateGate(human(), ['x', 'y'], ['x']);
    expect(r.canAdvance).toBe(false);
    expect(r.canSendBack).toBe(false);
    expect(r.remaining).toBe(1);
  });
  it('atLeast: needs n', () => {
    expect(evaluateGate(human({ rule: 'atLeast', n: 2 }), ['a'], []).canAdvance).toBe(false);
    expect(evaluateGate(human({ rule: 'atLeast', n: 2 }), ['a'], []).remaining).toBe(1);
    expect(evaluateGate(human({ rule: 'atLeast', n: 2 }), ['a', 'c'], []).canAdvance).toBe(true);
  });
  it('all: needs everyone', () => {
    const r = evaluateGate(human({ rule: 'all' }), ['a', 'b'], [], { c: 'Cara' });
    expect(r.canAdvance).toBe(false);
    expect(r.missing).toEqual(['c']);
    expect(r.plainWords).toBe('Needs 1 more approval from Cara.');
    expect(evaluateGate(human({ rule: 'all' }), ['a', 'b', 'c'], []).canAdvance).toBe(true);
  });
  it('specific: needs every listed decider', () => {
    const g = { rule: 'specific' as const, deciderUids: ['a', 'b'] };
    expect(evaluateGate(human(g), ['a'], []).canAdvance).toBe(false);
    expect(evaluateGate(human(g), [], []).plainWords).toBe('Needs 2 more approvals from a and b.');
    expect(evaluateGate(human(g), ['a', 'b'], []).canAdvance).toBe(true);
  });
  it('mustInclude is always required', () => {
    const g = { rule: 'any' as const, mustInclude: ['c'] };
    const r = evaluateGate(human(g), ['a'], [], { c: 'Cara' });
    expect(r.canAdvance).toBe(false);
    expect(r.missing).toEqual(['c']);
    expect(r.plainWords).toBe('Needs 1 more approval, including Cara.');
    expect(evaluateGate(human(g), ['c'], []).canAdvance).toBe(true);
    const al = { rule: 'atLeast' as const, n: 2, mustInclude: ['c'] };
    expect(evaluateGate(human(al), ['a', 'b'], []).canAdvance).toBe(false);
    expect(evaluateGate(human(al), ['a', 'c'], []).canAdvance).toBe(true);
  });
});

describe('evaluateGate: reject policy', () => {
  it('one: a single rejection sends back', () => {
    const r = evaluateGate(human(), [], ['a']);
    expect(r.canSendBack).toBe(true);
    expect(r.plainWords).toBe('Rejected. It can be sent back.');
  });
  it('majority: needs more than half', () => {
    const g = { rejectPolicy: 'majority' as const };
    const one = evaluateGate(human(g), [], ['a']);
    expect(one.canSendBack).toBe(false);
    expect(one.plainWords).toBe(
      'Needs 1 more approval. 1 of 3 rejected; more than half must reject to send it back.',
    );
    const two = evaluateGate(human(g), [], { a: at, b: at });
    expect(two.canSendBack).toBe(true);
    expect(two.plainWords).toBe('Most deciders rejected. It can be sent back.');
  });
  it('majority with an even number needs strictly more than half', () => {
    const g = { rejectPolicy: 'majority' as const, deciderUids: ['a', 'b', 'c', 'd'] };
    expect(rejectionsSuffice(gate(g), ['a', 'b'])).toBe(false);
    expect(rejectionsSuffice(gate(g), ['a', 'b', 'c'])).toBe(true);
  });
  it('approval wins the sentence when both are possible', () => {
    const r = evaluateGate(human(), ['a'], ['b']);
    expect(r.canAdvance && r.canSendBack).toBe(true);
    expect(r.plainWords).toBe('Approved. Ready to move on.');
  });
});

describe('evaluateGate: impossible and non-gates', () => {
  it('agent steps and missing gates have no decision', () => {
    expect(evaluateGate({ kind: 'agent' }, ['a'], []).plainWords).toBe(
      'This step has no decision.',
    );
    expect(evaluateGate({ kind: 'human' }, ['a'], []).canAdvance).toBe(false);
  });
  it('no deciders can never pass', () => {
    const r = evaluateGate(human({ rule: 'all', deciderUids: [] }), [], []);
    expect(r.impossible).toBe(true);
    expect(r.canAdvance).toBe(false);
    expect(r.plainWords).toBe('Nobody can approve this yet. Check who decides.');
  });
  it('mustInclude outside deciders is impossible', () => {
    expect(evaluateGate(human({ mustInclude: ['z'] }), ['a', 'z'], []).impossible).toBe(true);
  });
  it('atLeast above the number of deciders is impossible', () => {
    expect(evaluateGate(human({ rule: 'atLeast', n: 4 }), ['a', 'b', 'c'], []).impossible).toBe(
      true,
    );
  });
});

describe('helpers', () => {
  it('joinNames', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
  it('gateSatisfied matches evaluateGate', () => {
    expect(gateSatisfied(gate({ rule: 'all' }), ['a', 'b', 'c'])).toBe(true);
    expect(gateSatisfied(gate({ rule: 'all', deciderUids: [] }), [])).toBe(false);
  });
});
