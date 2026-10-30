import { describe, expect, it } from 'vitest';
import { fixThreadStates, needsRepair } from './fix-thread-states-lib.mjs';

const YC = { state: 'yourCall', question: null };
const plan = (states, cursor, state = 'active', types) => ({
  plan: { steps: states.map((_, i) => `s${i}`), cursor, state },
  outcomes: Object.fromEntries(
    states.map((s, i) => [`s${i}`, { type: types?.[i] ?? 'reply', state: s, planId: 'p' }]),
  ),
});

describe('needsRepair', () => {
  it('an approved agent step at the cursor: repair', () => {
    const p = plan(['done', 'approved', 'proposed'], 1, 'active', ['reply', 'reply', 'approval']);
    expect(needsRepair(YC, [p.plan], p.outcomes)).toBe(true);
    // an agent step still to approve ahead: Your call stays
    const ahead = plan(['done', 'approved', 'proposed'], 1);
    expect(needsRepair(YC, [ahead.plan], ahead.outcomes)).toBe(false);
  });
  it('a person step, an unapproved step, a wait-until step, a blocked plan: leave', () => {
    const gate = plan(['done', 'proposed'], 1, 'active', ['reply', 'approval']);
    expect(needsRepair(YC, [gate.plan], gate.outcomes)).toBe(false);
    const asked = plan(['done', 'proposed'], 1);
    expect(needsRepair(YC, [asked.plan], asked.outcomes)).toBe(false);
    const snooze = plan(['done', 'approved'], 1, 'active', ['reply', 'snooze']);
    expect(needsRepair(YC, [snooze.plan], snooze.outcomes)).toBe(false);
    const blocked = plan(['failed'], 0, 'blocked');
    expect(needsRepair(YC, [blocked.plan], blocked.outcomes)).toBe(false);
  });
  it('a single approved outcome with nothing open: repair; with a proposal open: leave', () => {
    expect(needsRepair(YC, [], { a: { type: 'reply', state: 'approved' } })).toBe(true);
    expect(
      needsRepair(YC, [], {
        a: { type: 'reply', state: 'approved' },
        b: { type: 'book', state: 'proposed' },
      }),
    ).toBe(false);
    expect(needsRepair(YC, [], { a: { type: 'reply', state: 'done' } })).toBe(false);
  });
  it('not at Your call, or an open question: leave', () => {
    const o = { a: { type: 'reply', state: 'approved' } };
    expect(needsRepair({ state: 'waiting' }, [], o)).toBe(false);
    expect(needsRepair({ state: 'yourCall', question: { answer: null } }, [], o)).toBe(false);
  });
});

describe('fixThreadStates', () => {
  const P = 'projects/p/databases/(default)/documents';
  const s = (v) => ({ stringValue: v });
  const docs = {
    inboxThreads: [
      {
        name: `${P}/workspaces/w1/inboxThreads/t1`,
        updateTime: 'u1',
        fields: { state: s('yourCall') },
      },
      {
        name: `${P}/workspaces/w1/inboxThreads/t2`,
        updateTime: 'u2',
        fields: { state: s('yourCall') },
      },
    ],
    inboxPlans: [],
    inboxOutcomes: [
      {
        name: `${P}/workspaces/w1/inboxOutcomes/o1`,
        fields: { threadId: s('t1'), type: s('reply'), state: s('approved') },
      },
      {
        name: `${P}/workspaces/w1/inboxOutcomes/o2`,
        fields: { threadId: s('t2'), type: s('reply'), state: s('proposed') },
      },
    ],
  };
  function fake() {
    const patched = [];
    const fn = async (url, init = {}) => {
      if (url.includes('/workspaces?'))
        return { ok: true, json: async () => ({ documents: [{ name: `${P}/workspaces/w1` }] }) };
      if (url.endsWith(':runQuery')) {
        const q = JSON.parse(init.body).structuredQuery;
        const f = q.where.fieldFilter;
        const rows = docs[q.from[0].collectionId].filter(
          (d) => d.fields[f.field.fieldPath]?.stringValue === f.value.stringValue,
        );
        return { ok: true, json: async () => rows.map((document) => ({ document })) };
      }
      if (init.method === 'PATCH') {
        patched.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected ${url}`);
    };
    return { fn, patched };
  }
  it('dry run: lists, writes nothing', async () => {
    const f = fake();
    const r = await fixThreadStates({ project: 'p', token: 't', fetchFn: f.fn, base: 'http://x' });
    expect(r).toEqual({ scanned: 2, repair: ['workspaces/w1/inboxThreads/t1'], repaired: 0 });
    expect(f.patched).toHaveLength(0);
  });
  it('apply: only state and waiting, with the read time as precondition', async () => {
    const f = fake();
    const r = await fixThreadStates({
      project: 'p',
      token: 't',
      fetchFn: f.fn,
      base: 'http://x',
      apply: true,
    });
    expect(r.repaired).toBe(1);
    expect(f.patched[0].url).toContain(
      'inboxThreads/t1?updateMask.fieldPaths=state&updateMask.fieldPaths=waiting',
    );
    expect(f.patched[0].url).toContain('currentDocument.updateTime=u1');
    expect(f.patched[0].body.fields.waiting.mapValue.fields.on).toEqual({ stringValue: 'agent' });
  });
});
