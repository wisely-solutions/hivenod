import { describe, expect, it } from 'vitest';
import { decisionText, insightLine, mostCommonTarget, quickTags } from './sendback';

const at = (iso: string) => ({ toMillis: () => new Date(iso).getTime() });
const d = (over: Partial<Parameters<typeof insightLine>[0][number]> = {}) => ({
  stepId: 'review',
  outcome: 'sentBack' as const,
  toStepId: 'draft',
  tags: [] as string[],
  at: at('2026-10-10T10:00:00Z'),
  ...over,
});
const order = ['intake', 'draft', 'spec', 'review'];
const now = new Date('2026-10-25T12:00:00Z');

describe('mostCommonTarget', () => {
  it('picks the most chosen target for the step, ties to the later step', () => {
    expect(mostCommonTarget([], 'review', order)).toBeNull();
    expect(
      mostCommonTarget(
        [d({ toStepId: 'draft' }), d({ toStepId: 'spec' }), d({ toStepId: 'draft' })],
        'review',
        order,
      ),
    ).toBe('draft');
    expect(
      mostCommonTarget([d({ toStepId: 'draft' }), d({ toStepId: 'spec' })], 'review', order),
    ).toBe('spec');
  });
  it('ignores other steps, approvals and stops', () => {
    expect(
      mostCommonTarget(
        [d({ stepId: 'x' }), d({ outcome: 'approved' }), d({ outcome: 'stopped', toStepId: null })],
        'review',
        order,
      ),
    ).toBeNull();
  });
});

describe('quickTags', () => {
  it('adds tags already used', () => {
    const t = quickTags([d({ tags: ['Wrong audience', 'Too slow'] })]);
    expect(t).toContain('Too slow');
    expect(t.filter((x) => x === 'Wrong audience')).toHaveLength(1);
  });
});

describe('insightLine', () => {
  it('counts this one among the tag in this month at this step', () => {
    const past = [
      d({ tags: ['Wrong audience'] }),
      d({ tags: ['Wrong audience'] }),
      d({ tags: ['Wrong audience'], at: at('2026-09-30T10:00:00Z') }),
      d({ tags: ['Wrong audience'], stepId: 'other' }),
    ];
    expect(insightLine(past, 'review', 'Draft', ['Wrong audience'], now)).toBe(
      "This is the 3rd 'wrong audience' rejection at Draft this month.",
    );
  });
  it('handles 11th-13th and no tags', () => {
    const many = Array.from({ length: 10 }, () => d());
    expect(insightLine(many, 'review', 'R', [], now)).toBe(
      'This is the 11th send-back at R this month.',
    );
    expect(insightLine([], 'review', 'R', [], now)).toBeNull();
    expect(insightLine([], 'review', 'R', ['Too long'], now)).toBe(
      "This is the 1st 'too long' rejection at R this month.",
    );
  });
});

describe('decisionText', () => {
  const name = (id: string) => ({ a: 'Draft', b: 'Review' })[id] ?? id;
  it('reads in plain words', () => {
    expect(decisionText({ outcome: 'sentBack', stepId: 'b', toStepId: 'a' }, name)).toBe(
      'Sent back from Review to Draft',
    );
    expect(decisionText({ outcome: 'stopped', stepId: 'b', toStepId: null }, name)).toBe(
      'Stopped at Review',
    );
    expect(decisionText({ outcome: 'approved', stepId: 'a', toStepId: 'b' }, name)).toBe(
      'Approved at Draft',
    );
  });
});
