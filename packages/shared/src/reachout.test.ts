import { describe, expect, it } from 'vitest';
import {
  REACH_ANSWER_MS,
  REACH_QUIET_MS,
  REACH_REMIND_MS,
  reachNext,
  silentNotice,
  silentText,
  stepSilentText,
} from './reachout';

const M = 60_000;
const T = Date.UTC(2026, 9, 30, 12, 0, 0);

describe('reachNext', () => {
  it('quiet → ask after 30 min', () => {
    expect(reachNext({ activityMs: T, askMs: null, flag: null })).toEqual({
      do: 'ask',
      at: T + REACH_QUIET_MS,
    });
  });
  it('an unanswered request → silent 10 min later; an answered one starts a new quiet period', () => {
    expect(reachNext({ activityMs: T, askMs: T + 30 * M, flag: null })).toEqual({
      do: 'silent',
      at: T + 40 * M,
      askMs: T + 30 * M,
    });
    expect(
      reachNext({ activityMs: T + 31 * M, askMs: T + 30 * M, flag: null }),
    ).toEqual({
      do: 'ask',
      at: T + 61 * M,
    });
    expect(REACH_ANSWER_MS).toBe(10 * M);
  });
  it('flagged: a reminder 2 h after the last message; activity clears it', () => {
    const flag = { since: T, at: T + 40 * M, told: T + 40 * M };
    expect(reachNext({ activityMs: T, askMs: T + 30 * M, flag })).toEqual({
      do: 'remind',
      at: T + 40 * M + REACH_REMIND_MS,
    });
    expect(reachNext({ activityMs: T + 50 * M, askMs: T + 30 * M, flag })).toEqual({
      do: 'clear',
      at: T + 50 * M,
    });
  });
});

describe('texts', () => {
  it('silent for N min, hours past two hours', () => {
    expect(silentText('Hive', T - 41 * M, T)).toBe('Hive silent for 41 min');
    expect(silentText(undefined, T - 150 * M, T)).toBe('Agent silent for 2 h');
  });
  it('the message: what, where, the unanswered check and the last status', () => {
    expect(
      silentNotice({
        agentName: 'Hive',
        title: 'Dark mode for the board',
        where: 'Build',
        sinceMs: T - 41 * M,
        askMs: T - 10 * M,
        last: { text: 'tests green, opening the PR', atMs: T - 41 * M },
        nowMs: T,
        url: '/inbox?t=t',
      }),
    ).toEqual({
      title: 'Hive is silent on "Dark mode for the board"',
      body: 'No update for 41 min at Build; no answer to a status check 10 min ago. Last: "tests green, opening the PR" (41 min ago).',
      url: '/inbox?t=t',
    });
  });
});

describe('stepSilentText', () => {
  const at = (ms: number) => ({ toMillis: () => ms });
  it('shows the flag on a step in agent hands until a newer progress line', () => {
    const silence = { since: T - 41 * M, agent: 'Hive' };
    expect(stepSilentText({ state: 'approved', silence }, T)).toBe('Hive silent for 41 min');
    expect(stepSilentText({ state: 'done', silence }, T)).toBeNull();
    expect(stepSilentText({ state: 'running', silence, progress: { at: at(T - M) } }, T)).toBeNull();
    expect(stepSilentText({ state: 'running', silence: null }, T)).toBeNull();
  });
});
