import { describe, expect, it } from 'vitest';
import { agentIsOff, summarizeOff, willStart, type OrgOff } from './logic';

const on = (wid: string): OrgOff => ({ wid, off: { all: false, agents: [], sinceMs: null } });
const name = (_w: string, uid: string) => (uid === 'a1' ? 'Hive' : null);

describe('the Off pill', () => {
  it('says Agents on when nothing is Off', () => {
    expect(summarizeOff([on('w1'), on('w2')], name)).toMatchObject({
      off: false,
      label: 'Agents on',
    });
  });
  it('says Agents off when all are Off, and since the earliest', () => {
    const s = summarizeOff(
      [
        { wid: 'w1', off: { all: true, agents: [], sinceMs: 2000 } },
        { wid: 'w2', off: { all: true, agents: [], sinceMs: 1000 } },
      ],
      name,
    );
    expect(s).toMatchObject({ off: true, all: true, sinceMs: 1000, label: 'Agents off' });
  });
  it('names one agent, counts several', () => {
    expect(
      summarizeOff([{ wid: 'w1', off: { all: false, agents: ['a1'], sinceMs: 5 } }, on('w2')], name)
        .label,
    ).toBe('Off: Hive');
    expect(
      summarizeOff([{ wid: 'w1', off: { all: false, agents: ['a1', 'a2'], sinceMs: 5 } }], name)
        .label,
    ).toBe('Off: 2 agents');
    // All agents in one organization only: still "Agents off", but not all everywhere.
    expect(
      summarizeOff([{ wid: 'w1', off: { all: true, agents: [], sinceMs: 5 } }, on('w2')], name),
    ).toMatchObject({ label: 'Agents off', all: false });
  });
  it('knows which agent is Off for the member', () => {
    const orgs = [{ wid: 'w1', off: { all: false, agents: ['a1'], sinceMs: 5 } }];
    expect(agentIsOff(orgs, 'w1', 'a1')).toBe(true);
    expect(agentIsOff(orgs, 'w1', 'a2')).toBe(false);
    expect(agentIsOff(orgs, 'w2', 'a1')).toBe(false);
  });
});

describe('turning on lists what will start', () => {
  it('steps approved before Off, single or at their cursor', () => {
    const rows = willStart(
      [
        { id: 'o1', threadId: 't1', type: 'reply', decidedMs: 10, planId: null },
        { id: 'o2', threadId: 't2', type: 'build', decidedMs: 10, planId: 'p1' },
        { id: 'o3', threadId: 't2', type: 'release', decidedMs: 10, planId: 'p1' },
        { id: 'o4', threadId: 't3', type: 'reply', decidedMs: 30, planId: null },
      ],
      20,
      (_p, oid) => oid === 'o2',
    );
    expect(rows.map((r) => r.id)).toEqual(['o1', 'o2']);
  });
});
