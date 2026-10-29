/**
 * Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): the member asks the proposing agent for changes,
 * the agent writes the next version in the same slot, the member approves the version shown.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type ActionContext } from './actions';
import {
  approveOutcome,
  cancelRevision,
  requestRevision,
  reviseOutcome,
  versionCount,
  type OutcomeStateOf,
  type OutcomeVersion,
  type ThreadStateOf,
} from './inbox';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Agent' },
  newId: () => 'e1',
};
const other: ActionContext = { ...agent, actor: { type: 'agent', id: 'agentB', name: 'B' } };
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => 'e2',
};
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: 's1',
  state: 'yourCall',
  fetchedBy: 'agentA',
  refs: ['r1'],
};
const O: OutcomeStateOf = {
  memberUid: 'joao',
  threadId: 't1',
  type: 'reply',
  fields: { text: 'Hi Sam, Thursday works. Best, Cara' },
  state: 'proposed',
  executor: 'agentA',
  proposedBy: 'agentA',
  note: 'They asked to move it.',
  confidence: 'high',
};
const base = { outcomeId: 'o1', outcome: O, thread: TH };
const revising: OutcomeStateOf = {
  ...O,
  state: 'revising',
  revise: { instruction: 'Mention 14:00', chips: ['shorter'], byUid: 'joao', at: null as never },
};

describe('requestRevision', () => {
  it('moves the outcome to revising in place, with the chips in order and the instruction', () => {
    const p = requestRevision(joao, {
      ...base,
      chips: ['availability', 'shorter'],
      instruction: '  Mention 14:00 as a backup ',
    });
    expect(p.ops).toHaveLength(2);
    expect(p.ops[0]).toMatchObject({
      kind: 'update',
      path: 'workspaces/w1/inboxOutcomes/o1',
      data: {
        state: 'revising',
        revise: {
          instruction: 'Mention 14:00 as a backup',
          chips: ['shorter', 'availability'],
          byUid: 'joao',
          at: SERVER_TIME,
        },
      },
    });
    expect(p.ops[1]!.data).toMatchObject({
      type: 'outcome.revise_requested',
      data: { outcomeId: 'o1', instruction: 'Mention 14:00 as a backup' },
    });
    // No thread write: the card keeps its slot in Your call.
    expect(p.ops.some((o) => o.path.includes('inboxThreads'))).toBe(false);
  });
  it('needs a chip or some text; at most 500 characters; known chips only', () => {
    expect(() => requestRevision(joao, { ...base, instruction: '  ' })).toThrow(
      /what should change/,
    );
    expect(() => requestRevision(joao, { ...base, instruction: 'x'.repeat(501) })).toThrow(/500/);
    expect(() => requestRevision(joao, { ...base, instruction: 'x'.repeat(500) })).not.toThrow();
    expect(() => requestRevision(joao, { ...base, chips: ['louder'] })).toThrow(/chips/);
  });
  it('only the member, only on a proposed revisable outcome below 10 versions', () => {
    expect(() => requestRevision(agent, { ...base, chips: ['shorter'] })).toThrow();
    expect(() =>
      requestRevision({ ...joao, actor: { ...joao.actor, id: 'bob' } }, { ...base, chips: ['warmer'] }),
    ).toThrow(/Only the person/);
    expect(() =>
      requestRevision(joao, { ...base, outcome: revising, chips: ['warmer'] }),
    ).toThrow(/already revising/);
    expect(() =>
      requestRevision(joao, {
        ...base,
        outcome: { ...O, type: 'snooze', fields: { until: '2099-01-01T00:00:00Z' } },
        chips: ['warmer'],
      }),
    ).toThrow(/nothing to revise/);
    const ten = Array.from({ length: 10 }, (_, i) => version(i + 1, `v${i + 1}`));
    expect(() =>
      requestRevision(joao, { ...base, outcome: { ...O, versions: ten }, chips: ['warmer'] }),
    ).toThrow(/10 versions/);
  });
});

describe('cancelRevision', () => {
  it('back to proposed, with the same event type and no ask', () => {
    const p = cancelRevision(joao, { ...base, outcome: revising });
    expect(p.ops[0]!.data).toMatchObject({ state: 'proposed', revise: null });
    expect(p.ops[1]!.data).toMatchObject({
      type: 'outcome.revise_requested',
      data: { instruction: null, chips: [] },
    });
    expect(() => cancelRevision(joao, base)).toThrow(/not revising/);
  });
});

function version(n: number, text: string): OutcomeVersion {
  return {
    n,
    fields: { text },
    note: '',
    confidence: null,
    checks: [],
    by: 'agentA',
    eventId: n === 1 ? null : `ev${n}`,
    asked: n === 1 ? null : { instruction: 'x', chips: [] },
  };
}

describe('reviseOutcome', () => {
  it('the first revision keeps the proposal as v1 and appends v2; fields stay the latest', () => {
    const p = reviseOutcome(agent, {
      ...base,
      outcome: revising,
      fields: { text: 'Hi Sam, Thursday 10:00 works; 14:00 too. Cara' },
      note: 'Shorter, with a backup.',
      confidence: 'medium',
      checks: ['Thu 14:00 free'],
    });
    expect(p.version).toBe(2);
    expect(p.ops[0]!.data).toMatchObject({
      state: 'proposed',
      fields: { text: 'Hi Sam, Thursday 10:00 works; 14:00 too. Cara' },
      note: 'Shorter, with a backup.',
      confidence: 'medium',
      checks: ['Thu 14:00 free'],
      revise: null,
      versions: [
        {
          n: 1,
          fields: O.fields,
          note: O.note,
          confidence: 'high',
          checks: [],
          by: 'agentA',
          eventId: null,
          asked: null,
        },
        {
          n: 2,
          by: 'agentA',
          eventId: 'e1',
          asked: { instruction: 'Mention 14:00', chips: ['shorter'] },
        },
      ],
    });
    expect(p.ops[1]!.data).toMatchObject({
      type: 'outcome.revised',
      data: { outcomeId: 'o1', version: 2 },
    });
  });
  it('later revisions append to the list', () => {
    const p = reviseOutcome(agent, {
      ...base,
      outcome: { ...revising, versions: [version(1, 'a'), version(2, 'b')] },
      fields: { text: 'c' },
    });
    expect(p.version).toBe(3);
    const vs = (p.ops[0]!.data as { versions: OutcomeVersion[] }).versions;
    expect(vs.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(vs[0]!.fields).toEqual({ text: 'a' });
  });
  it('refused: nobody asked, already decided, another agent, another type or thread, bad fields', () => {
    const f = { text: 'x' };
    expect(() => reviseOutcome(agent, { ...base, fields: f })).toThrow(/Nobody asked/);
    expect(() =>
      reviseOutcome(agent, { ...base, outcome: { ...revising, state: 'approved' }, fields: f }),
    ).toThrow(/already decided/);
    expect(() => reviseOutcome(other, { ...base, outcome: revising, fields: f })).toThrow(
      /Only the agent that proposed/,
    );
    expect(() => reviseOutcome(joao, { ...base, outcome: revising, fields: f })).toThrow();
    expect(() =>
      reviseOutcome(agent, { ...base, outcome: revising, type: 'nudge', fields: f }),
    ).toThrow(/propose a new outcome/);
    expect(() =>
      reviseOutcome(agent, { ...base, outcome: revising, threadId: 't2', fields: f }),
    ).toThrow(/propose a new outcome/);
    expect(() => reviseOutcome(agent, { ...base, outcome: revising, fields: {} })).toThrow();
  });
});

describe('approveOutcome with versions', () => {
  const two: OutcomeStateOf = {
    ...O,
    fields: { text: 'v2 text' },
    versions: [version(1, 'v1 text'), version(2, 'v2 text')],
  };
  it('approves the version shown: its fields, decision.version, not edited', () => {
    const p = approveOutcome(joao, { ...base, outcome: two, version: 1 });
    expect(p.ops[0]!.data).toMatchObject({
      state: 'approved',
      fields: { text: 'v1 text' },
      decision: { edited: false, version: 1 },
    });
    expect(p.ops[1]!.data).toMatchObject({ data: { version: 1, edited: false } });
  });
  it('defaults to the latest; an edit of the shown version counts as edited', () => {
    expect(approveOutcome(joao, { ...base, outcome: two }).ops[0]!.data).toMatchObject({
      fields: { text: 'v2 text' },
      decision: { version: 2, edited: false },
    });
    expect(
      approveOutcome(joao, { ...base, outcome: two, version: 1, fields: { text: 'mine' } }).ops[0]!
        .data,
    ).toMatchObject({ fields: { text: 'mine' }, decision: { version: 1, edited: true } });
  });
  it('a never-revised outcome has no version (old shape)', () => {
    const d = approveOutcome(joao, base).ops[0]!.data as { decision: object };
    expect(d.decision).not.toHaveProperty('version');
    expect(() => approveOutcome(joao, { ...base, version: 1 })).toThrow(/no version 1/);
    expect(() => approveOutcome(joao, { ...base, outcome: two, version: 3 })).toThrow(/no version 3/);
  });
  it('approving while revising ends the request (the late revision is then refused)', () => {
    const p = approveOutcome(joao, { ...base, outcome: revising });
    expect(p.ops[0]!.data).toMatchObject({ state: 'approved', revise: null });
    expect(() =>
      reviseOutcome(agent, {
        ...base,
        outcome: { ...revising, state: 'approved' },
        fields: { text: 'late' },
      }),
    ).toThrow(/already decided/);
  });
  it('versionCount is 1 before any revision', () => {
    expect(versionCount(O)).toBe(1);
    expect(versionCount(two)).toBe(2);
  });
});
