import { describe, expect, it } from 'vitest';
import type { ActionContext } from './actions';
import {
  assignSubject,
  cleanLabelList,
  DEFAULT_INBOX_LABELS,
  matchLabel,
  setInboxLabels,
  setSubjectLabel,
} from './inbox';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Agent' },
  newId: () => 'e1',
};
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => 'e2',
};
const thread = {
  memberUid: 'joao',
  subjectId: null,
  state: 'investigating',
  fetchedBy: 'agentA',
  refs: [],
};

describe('subject labels (item YaOErIjeIFG8Y3EvZuIp)', () => {
  it('defaults', () => {
    expect(DEFAULT_INBOX_LABELS).toEqual([
      'Sales',
      'Support',
      'Billing',
      'Partnership',
      'Internal',
      'Other',
    ]);
  });
  it('cleans the list: 1-12, unique ignoring case, 30 characters', () => {
    expect(cleanLabelList([' Sales ', 'Big   deals'])).toEqual(['Sales', 'Big deals']);
    expect(() => cleanLabelList([])).toThrow();
    expect(() => cleanLabelList(Array.from({ length: 13 }, (_, i) => `L${i}`))).toThrow();
    expect(() => cleanLabelList(['a', 'A'])).toThrow(/once/);
    expect(() => cleanLabelList(['x'.repeat(31)])).toThrow(/30/);
    expect(matchLabel('sales ', DEFAULT_INBOX_LABELS)).toBe('Sales');
    expect(matchLabel('Foo', DEFAULT_INBOX_LABELS)).toBeNull();
  });
  it('an agent files a new subject with a suggested label', () => {
    const p = assignSubject(agent, {
      threadId: 't1',
      thread: thread as never,
      newName: 'Acme',
      label: 'sales',
    });
    expect(p.labelApplied).toBe(true);
    expect(p.ops[0]).toMatchObject({
      kind: 'set',
      data: { label: 'Sales', labelSuggested: true, labelBy: 'agent' },
    });
  });
  it('refuses a label that is not listed, naming the allowed ones', () => {
    expect(() =>
      assignSubject(agent, { threadId: 't1', thread: thread as never, newName: 'A', label: 'Foo' }),
    ).toThrow(/Sales, Support/);
    expect(() =>
      assignSubject(agent, {
        threadId: 't1',
        thread: thread as never,
        newName: 'A',
        label: 'Sales',
        labels: ['Ops'],
      }),
    ).toThrow(/Ops/);
  });
  it('never relabels an existing subject that has a label', () => {
    const p = assignSubject(agent, {
      threadId: 't1',
      thread: thread as never,
      subjectId: 's1',
      label: 'Support',
      existing: { label: 'Sales', labelBy: 'member' },
    });
    expect(p.labelApplied).toBe(false);
    expect(JSON.stringify(p.ops)).not.toContain('Support');
    const q = assignSubject(agent, {
      threadId: 't1',
      thread: thread as never,
      subjectId: 's1',
      label: 'Support',
      existing: { label: null },
    });
    expect(q.labelApplied).toBe(true);
    expect(q.ops[0]).toMatchObject({
      kind: 'update',
      data: { label: 'Support', labelBy: 'agent' },
    });
  });
  it('the member confirms or changes; only a human; only the owner', () => {
    const subject = { memberUid: 'joao', name: 'Acme', label: 'Sales' };
    const p = setSubjectLabel(joao, { subjectId: 's1', subject, label: 'Sales' });
    expect(p.ops[0]).toMatchObject({
      data: { label: 'Sales', labelSuggested: false, labelBy: 'member' },
    });
    expect(p.ops[1]).toMatchObject({ data: { type: 'subject.label' } });
    expect(setSubjectLabel(joao, { subjectId: 's1', subject, label: '' }).ops[0]).toMatchObject({
      data: { label: null },
    });
    expect(() => setSubjectLabel(joao, { subjectId: 's1', subject, label: 'Foo' })).toThrow();
    expect(() => setSubjectLabel(agent, { subjectId: 's1', subject, label: 'Sales' })).toThrow();
    expect(() =>
      setSubjectLabel(
        { ...joao, actor: { ...joao.actor, id: 'x' } },
        { subjectId: 's1', subject, label: 'Sales' },
      ),
    ).toThrow();
  });
  it('an unlisted label already on the subject can be confirmed', () => {
    const subject = { memberUid: 'joao', name: 'Acme', label: 'Old' };
    expect(() => setSubjectLabel(joao, { subjectId: 's1', subject, label: 'Old' })).not.toThrow();
  });
  it('the list is written by a person as one document', () => {
    const p = setInboxLabels(joao, { labels: ['A', 'B'] });
    expect(p.ops[0]).toMatchObject({
      path: 'workspaces/w1/inboxConfig/labels',
      data: { labels: ['A', 'B'], updatedBy: 'joao' },
    });
    expect(() => setInboxLabels(agent, { labels: ['A'] })).toThrow();
  });
});
