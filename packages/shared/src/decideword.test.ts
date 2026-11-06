import { describe, expect, it } from 'vitest';
import type { ActionContext } from './actions';
import { cleanWords, onWordLine, onWordOf, setAgentTrust, trusts } from './decideword';

const alice: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'alice', name: 'Alice' },
};
const hive: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'hive', name: 'Hive' },
};

describe('May act on my word', () => {
  it('the member turns it on and off for one agent; his own doc, one event', () => {
    const on = setAgentTrust(alice, { agentUid: 'hive', on: true, current: { agents: ['bee'] } });
    expect(on.agents).toEqual(['bee', 'hive']);
    expect(on.ops[0]).toMatchObject({
      kind: 'set',
      path: 'workspaces/w1/agentTrust/alice',
      data: { agents: ['bee', 'hive'], lastEventId: on.eventId },
    });
    expect(on.ops[1]!.data).toMatchObject({
      type: 'agents.trusted',
      memberUid: 'alice',
      data: { agentUid: 'hive', on: true },
    });
    expect(setAgentTrust(alice, { agentUid: 'hive', on: false, current: on }).agents).toEqual([
      'bee',
    ]);
    expect(setAgentTrust(alice, { agentUid: 'hive', on: true, current: on }).agents).toEqual([
      'bee',
      'hive',
    ]);
    expect(() => setAgentTrust(hive, { agentUid: 'hive', on: true })).toThrow(/Only people/);
    expect(() => setAgentTrust(alice, { agentUid: ' ', on: true })).toThrow(/Pick an agent/);
    const many = { agents: Array.from({ length: 20 }, (_, i) => `a${i}`) };
    expect(() => setAgentTrust(alice, { agentUid: 'hive', on: true, current: many })).toThrow(
      /At most 20/,
    );
    expect(trusts(on, 'hive')).toBe(true);
    expect(trusts(null, 'hive')).toBe(false);
  });

  it('quotes the words, 1-500 characters', () => {
    expect(cleanWords('  approved ')).toBe('approved');
    expect(() => cleanWords('  ')).toThrow(/Quote the person/);
    expect(() => cleanWords('x'.repeat(501))).toThrow(/at most 500/);
  });

  it('says how it was decided: by the member, via the agent’s terminal, with his words', () => {
    const data = { onBehalfOf: 'alice', memberName: 'João', via: 'terminal', words: 'approved' };
    const line = (type: string, d: Record<string, unknown> = data) =>
      onWordLine({ type, data: d, actor: { name: 'Hive' } });
    expect(line('outcome.approved')).toBe('Approved by João via Hive’s terminal: “approved”');
    expect(line('outcome.rejected')).toMatch(/^Turned down by João/);
    expect(line('plan.rejected')).toMatch(/^Plan rejected by João/);
    expect(line('plan.sent_back')).toMatch(/^Changes asked by João/);
    expect(line('thread.closed')).toMatch(/^Closed by João/);
    expect(line('outcome.approved', { ...data, memberName: '' })).toMatch(/by the person via/);
    expect(line('outcome.approved', { type: 'reply' })).toBeNull();
    expect(onWordOf({ ...data, via: 'telegram' })).toBeNull();
  });
});
