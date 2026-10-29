import { describe, expect, it } from 'vitest';
import { briefOf, type BriefInput } from './brief';

const base: BriefInput = {
  messages: 11,
  sources: 5,
  proposals: 5,
  questions: 1,
  projectEntries: 0,
  tidyUps: 0,
  working: 2,
  top: { title: 'Sign off the Q4 price list', due: 'Fri', urgent: false },
  segments: ['red', 'amber', 'grey', 'grey', 'grey', 'grey'],
};

describe('the Today brief (design 3.1)', () => {
  it('says what came in, what the agents did, what needs you and what is most pressing', () => {
    const b = briefOf(base);
    expect(b.sentences).toEqual([
      'In the last 24 hours 11 messages came in from 5 places.',
      'Your agents drafted 5 proposals and asked 1 question: 6 need you.',
      'Most pressing: Sign off the Q4 price list (due Fri).',
    ]);
    expect(b.empty).toBe(false);
    // 5 decisions × 30 s + 1 question × 60 s = 210 s → 4 min.
    expect(b.minutes).toBe(4);
    expect(b.segments).toHaveLength(6);
  });

  it('counts tidy-ups as one 15 s batch and names urgency', () => {
    const b = briefOf({
      ...base,
      messages: 1,
      sources: 1,
      proposals: 1,
      questions: 0,
      tidyUps: 3,
      top: { title: 'Prod is down', due: null, urgent: true },
      segments: ['red'],
    });
    expect(b.sentences).toEqual([
      'In the last 24 hours 1 message came in from 1 place.',
      'Your agents drafted 1 proposal: 1 needs you, plus 3 tidy-ups.',
      'Most pressing: Prod is down (urgent).',
    ]);
    expect(b.minutes).toBe(1);
  });

  it('a decision made turns its segment green and leaves the count', () => {
    const b = briefOf({ ...base, segments: ['green', 'amber', 'grey', 'grey', 'grey', 'grey'] });
    expect(b.sentences[1]).toBe(
      'Your agents drafted 5 proposals and asked 1 question: 5 need you.',
    );
  });

  it('with nothing waiting: all caught up, and what the agents are on', () => {
    const b = briefOf({
      ...base,
      messages: 0,
      proposals: 0,
      questions: 0,
      top: null,
      segments: [],
    });
    expect(b.sentences).toEqual(['You are all caught up. Your agents are on 2 threads.']);
    expect(b.empty).toBe(true);
    expect(b.minutes).toBe(0);
  });

  it('project entries alone', () => {
    const b = briefOf({
      ...base,
      messages: 0,
      proposals: 0,
      questions: 0,
      projectEntries: 2,
      top: { title: 'Approve the release', due: null, urgent: false },
      segments: ['grey', 'grey'],
    });
    expect(b.sentences).toEqual([
      'No new messages in the last 24 hours.',
      '2 need you.',
      'Most pressing: Approve the release.',
    ]);
  });
});
