import { describe, expect, it } from 'vitest';
import type { Item, Project } from '@hive/shared';
import {
  stoppedKind,
  stoppedReason,
  attachmentCountLabel,
  attachmentSummary,
  canEditItem,
  cardData,
  dragAnnouncements,
  filterAndSort,
  groupByStep,
  isItemLive,
  listRows,
  orderAt,
  NO_FILTER,
  isFiltered,
  parseExpanded,
  parseLayout,
  defaultLayout,
  requiredApprovals,
  scrubber,
  activeStepId,
  stepStats,
  statusView,
  askStatusState,
} from './logic';

const ts = (ms: number) => ({ toMillis: () => ms }) as never;
const NOW = 1_000_000_000;
const project = {
  steps: [
    { id: 'a', name: 'Draft', kind: 'agent', description: '' },
    {
      id: 'g',
      name: 'Review',
      kind: 'human',
      description: '',
      gate: {
        deciderUids: ['me', 'you'],
        groupIds: [],
        rule: 'all',
        mustInclude: [],
        rejectPolicy: 'one',
        remindAfterHours: 24,
      },
    },
  ],
} as unknown as Project;

function item(over: Partial<Item> = {}): Item {
  return {
    title: 'T',
    summary: '',
    type: 'idea',
    stepId: 'a',
    status: 'queued',
    claim: null,
    gate: null,
    progress: null,
    sendBackCount: 0,
    costEur: 0,
    order: 0,
    updatedAt: ts(NOW),
    createdBy: { type: 'human', id: 'me' },
    parentItemId: null,
    ...over,
  } as Item;
}
const row = (id: string, data: Partial<Item>) => ({ id, data: item(data) });

describe('board logic', () => {
  it('knows a live item by its claim heartbeat', () => {
    const claim = { runId: 'r', agentUid: 'x', heartbeatAt: ts(NOW - 60_000) };
    expect(isItemLive(item({ status: 'working', claim }), NOW)).toBe(true);
    const old = { ...claim, heartbeatAt: ts(NOW - 11 * 60_000) };
    expect(isItemLive(item({ status: 'working', claim: old }), NOW)).toBe(false);
    expect(isItemLive(item({ status: 'queued', claim }), NOW)).toBe(false);
  });

  it('groups by step in order and ignores unknown steps', () => {
    const g = groupByStep(project.steps, [
      row('2', { order: 2 }),
      row('1', { order: 1 }),
      row('x', { stepId: 'nope' }),
    ]);
    expect(g.a!.map((r) => r.id)).toEqual(['1', '2']);
    expect(g.g).toEqual([]);
  });

  it('sums progress, send-backs and waiting items for a step', () => {
    const list = [
      row('1', { sendBackCount: 2, progress: { done: 1, total: 4 } }),
      row('2', { progress: { done: 2, total: 2 } }),
    ];
    const s = stepStats(project, list, 'me', NOW);
    expect(s).toMatchObject({ count: 2, sendBacks: 2, progress: { done: 3, total: 6 }, mine: 0 });
    const gate = [
      row('3', {
        stepId: 'g',
        status: 'waiting',
        gate: { stepId: 'g', approvals: {}, rejections: {} },
      }),
    ];
    expect(stepStats(project, gate, 'me', NOW).mine).toBe(1);
    expect(stepStats(project, gate, 'stranger', NOW).mine).toBe(0);
  });

  it('counts items needing attention (open question, work held)', () => {
    const hold = { questionId: 'q', agentUid: 'ag', at: ts(1) } as never;
    const stop = { mode: 'back' } as never;
    const list = [
      row('1', { awaitingAnswer: hold }),
      row('2', { workStopped: stop }),
      row('3', { workStopped: { mode: 'cancel' } as never }),
      row('4', {}),
    ];
    expect(stepStats(project, list, 'me', NOW).attention).toBe(2);
  });

  it('counts the approvals a gate needs', () => {
    expect(requiredApprovals(project.steps[1]!)).toBe(2);
    expect(requiredApprovals(project.steps[0]!)).toBe(0);
  });

  it('builds the scrubber with counts for me', () => {
    const grouped = groupByStep(project.steps, [
      row('3', {
        stepId: 'g',
        status: 'waiting',
        gate: { stepId: 'g', approvals: {}, rejections: {} },
      }),
    ]);
    expect(scrubber(project, grouped, 'me').map((e) => [e.id, e.count, e.mine])).toEqual([
      ['a', 0, 0],
      ['g', 1, 1],
    ]);
  });

  it('picks the column on the left edge of the scroller as the current step', () => {
    const cols = [
      { id: 'a', left: -300 },
      { id: 'g', left: 10 },
      { id: 'p', left: 330 },
    ];
    expect(activeStepId(cols, 0)).toBe('g');
    expect(
      activeStepId(
        cols.map((c) => ({ ...c, left: c.left + 300 })),
        0,
      ),
    ).toBe('a');
    expect(activeStepId([], 0)).toBeNull();
  });

  it('filters and sorts the list', () => {
    const rows = listRows(
      project,
      [
        row('1', { title: 'Beta', costEur: 2 }),
        row('2', { title: 'alpha', costEur: 1, stepId: 'g', status: 'waiting' }),
      ],
      [],
    );
    const by = (key: 'title' | 'cost' | 'step', dir: 1 | -1 = 1) =>
      filterAndSort(rows, NO_FILTER, { key, dir }).map((r) => r.row.id);
    expect(by('title')).toEqual(['2', '1']);
    expect(by('cost', -1)).toEqual(['1', '2']);
    expect(by('step')).toEqual(['1', '2']);
    expect(
      filterAndSort(rows, { ...NO_FILTER, status: 'waiting' }, { key: 'title', dir: 1 }).length,
    ).toBe(1);
    expect(
      filterAndSort(rows, { ...NO_FILTER, text: 'BET' }, { key: 'title', dir: 1 })[0]!.row.id,
    ).toBe('1');
  });

  it('filters by description, type, agent and waiting on me', () => {
    const rows = listRows(
      project,
      [
        row('1', { title: 'A', summary: 'Mentions invoices', type: 'bug' }),
        row('2', {
          title: 'B',
          type: 'idea',
          claim: { runId: 'r', agentUid: 'ag1', heartbeatAt: ts(NOW) },
        }),
      ],
      [],
      'p1',
      'me',
    );
    const ids = (f: Partial<typeof NO_FILTER>) =>
      filterAndSort(rows, { ...NO_FILTER, ...f }, { key: 'title', dir: 1 }).map((r) => r.row.id);
    expect(ids({ text: 'invoice' })).toEqual(['1']);
    expect(ids({ type: 'bug' })).toEqual(['1']);
    expect(ids({ agent: 'ag1' })).toEqual(['2']);
    expect(ids({ mine: true })).toEqual([]);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, mine: true })).toBe(true);
  });

  it('reads saved fold state defensively', () => {
    expect(parseExpanded('["a","b"]')).toEqual(['a', 'b']);
    expect(parseExpanded('nope')).toEqual([]);
    expect(parseExpanded(null)).toEqual([]);
    expect(parseExpanded('{"a":1}')).toEqual([]);
  });

  it('defaults to columns up to 5 steps and rows from 6', () => {
    expect(defaultLayout(1)).toBe('columns');
    expect(defaultLayout(5)).toBe('columns');
    expect(defaultLayout(6)).toBe('rows');
    expect(defaultLayout(12)).toBe('rows');
  });

  it('reads a saved layout defensively', () => {
    expect(parseLayout('rows')).toBe('rows');
    expect(parseLayout('columns')).toBe('columns');
    expect(parseLayout('grid')).toBeNull();
    expect(parseLayout(null)).toBeNull();
  });

  it('summarises attachments', () => {
    expect(attachmentSummary([])).toBe('');
    expect(attachmentSummary([{ name: 'Spec.html' }])).toBe('Spec.html');
    expect(attachmentSummary([{ name: 'Spec.html' }, { name: 'b' }])).toBe('Spec.html · 1 more');
  });

  it('picks an order value between neighbours', () => {
    expect(orderAt([10, 20], 1)).toBe(15);
    expect(orderAt([10, 20], 0)).toBe(-990);
    expect(orderAt([10, 20], 2)).toBe(1020);
    expect(orderAt([], 0)).toBeGreaterThan(0);
  });
});

describe('dragAnnouncements', () => {
  const a = dragAnnouncements((id) => (id === 'x1' ? 'Write post' : 'Fix footer'));
  it('uses titles, not ids', () => {
    expect(a.onDragStart({ active: { id: 'x1' } })).toBe('Picked up item Write post.');
    expect(a.onDragOver({ active: { id: 'x1' }, over: { id: 'y2' } })).toBe(
      'Item Write post is over item Fix footer.',
    );
    expect(a.onDragEnd({ active: { id: 'x1' }, over: null })).toBe(
      'Dropped item Write post. It did not move.',
    );
    expect(a.onDragOver({ active: { id: 'x1' }, over: { id: 'x1' } })).toBeUndefined();
    expect(a.onDragEnd({ active: { id: 'x1' }, over: { id: 'x1' } })).toContain('did not move');
    expect(a.onDragCancel({ active: { id: 'x1' } })).toMatch(/^Cancelled\. Item /);
    expect(a.onDragCancel({ active: { id: 'x1' } })).not.toContain('x1');
  });
  it('announces the position when known', () => {
    const o = dragAnnouncements(
      (id) => String(id),
      () => false,
      (id) => (id === 'y2' ? { index: 2, total: 4 } : null),
    );
    expect(o.onDragOver({ active: { id: 'x1' }, over: { id: 'y2' } })).toBe(
      'Item x1 is over item y2. Position 2 of 4.',
    );
    expect(o.onDragEnd({ active: { id: 'x1' }, over: { id: 'y2' } })).toBe(
      'Dropped item x1 on item y2. Position 2 of 4.',
    );
  });
  it('treats a drop outside the step as no move', () => {
    const o = dragAnnouncements(
      () => 'Write post',
      () => true,
    );
    expect(o.onDragOver({ active: { id: 'x1' }, over: { id: 'y2' } })).toBeUndefined();
    expect(o.onDragEnd({ active: { id: 'x1' }, over: { id: 'y2' } })).toBe(
      'Dropped item Write post. It did not move. Items change step only through agent work or a decision.',
    );
  });
});

describe('attachment count on the board card (card 05PEkpwG)', () => {
  it('labels the count', () => {
    expect(attachmentCountLabel(undefined)).toBe('');
    expect(attachmentCountLabel(0)).toBe('');
    expect(attachmentCountLabel(1)).toBe('1 attachment');
    expect(attachmentCountLabel(3)).toBe('3 attachments');
  });
  it('shows it on the card, and nothing for an item without a counter', () => {
    const ctx = { project, agents: [], items: [], uid: 'me', now: NOW };
    expect(cardData(row('1', { attachmentCount: 2 }), ctx).attachments).toBe('2 attachments');
    expect(cardData(row('2', {}), ctx).attachments).toBeUndefined();
  });
});

import { isNewAttachment, progressLabel } from './logic';

describe('watching a run', () => {
  it('marks attachments of the last 10 minutes as new', () => {
    expect(isNewAttachment(NOW - 60_000, NOW)).toBe(true);
    expect(isNewAttachment(NOW - 11 * 60_000, NOW)).toBe(false);
  });
  it('labels progress', () => {
    expect(progressLabel({ done: 3, total: 6 })).toEqual({
      short: '3/6',
      long: '3 of 6 steps done',
    });
  });
});

describe('who may edit an item (card mpWuccjl)', () => {
  const human = { createdBy: { type: 'human', id: 'u1' } };
  it('allows its creator and admins', () => {
    expect(canEditItem(human, 'u1', false)).toBe(true);
    expect(canEditItem(human, 'u2', true)).toBe(true);
  });
  it('denies other members, and everyone but admins for an agent-made item', () => {
    expect(canEditItem(human, 'u2', false)).toBe(false);
    expect(canEditItem({ createdBy: { type: 'agent', id: 'u1' } }, 'u1', false)).toBe(false);
  });
});

describe('stoppedKind / stoppedReason (card rLntxm7C)', () => {
  const rej = [
    { itemId: 'a', rationale: 'old', at: 1 },
    { itemId: 'a', rationale: ' newest ', at: 2 },
    { itemId: 'b', rationale: 'other', at: 3 },
  ];
  const stop = { mode: 'cancel', reason: ' Wrong audience ' } as never;
  it('tells cancelled, archived and rejected apart', () => {
    expect(stoppedKind({ workStopped: stop, archivedAt: null })).toBe('Cancelled');
    expect(stoppedKind({ archivedAt: {} as never })).toBe('Archived');
    expect(stoppedKind({})).toBe('Rejected');
  });
  it('gives the reason of each', () => {
    expect(stoppedReason({ workStopped: stop }, rej, 'a')).toBe('Wrong audience');
    expect(stoppedReason({}, rej, 'a')).toBe('newest');
    expect(stoppedReason({ archivedAt: {} as never }, rej, 'a')).toBe('');
    expect(stoppedReason({}, rej, 'zzz')).toBe('');
  });
});

describe('parked items (item QjTTL)', () => {
  const claim = (runId: string) => ({ runId, agentUid: 'bot', heartbeatAt: ts(NOW - 60_000) });
  const agents = [{ id: 'bot', data: { name: 'Hive', color: 'blue' } }] as never;
  const at = new Date(NOW - 3_600_000);
  const parkedRow = row('p', {
    status: 'working',
    claim: claim('r1'),
    parked: { runId: 'r1', reason: 'release batch', at: ts(at.getTime()) },
  });
  const workingRow = row('w', { status: 'working', claim: claim('r2') });
  it('a parked item is not live; a park from an older claim is void', () => {
    expect(isItemLive(parkedRow.data, NOW)).toBe(false);
    const void_ = item({
      status: 'working',
      claim: claim('r9'),
      parked: { runId: 'r1', reason: 'x', at: ts(NOW) },
    });
    expect(isItemLive(void_, NOW)).toBe(true);
  });
  it('the card shows the waiting badge and the agent presence', () => {
    const ctx = { project, agents, items: [parkedRow, workingRow], uid: 'me', now: NOW };
    const c = cardData(parkedRow, ctx);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(c.parked).toEqual({ reason: 'release batch', since: hhmm });
    expect(c.agent).toMatchObject({ name: 'Hive', live: false, presence: 'working 1 · waiting 1' });
    expect(cardData(workingRow, ctx).agent).toMatchObject({ live: true });
    // Without parked items the card keeps the working dots, no presence text.
    const plain = { ...ctx, items: [workingRow] };
    expect(cardData(workingRow, plain).agent?.presence).toBeUndefined();
  });
});

describe('status checks on the card (item AzveC)', () => {
  const claim = { runId: 'r1', agentUid: 'ag', heartbeatAt: ts(NOW - 60_000) };
  const base = { status: 'working', claim } as unknown as Item;
  const su = (over = {}) => ({
    runId: 'r1',
    text: 'Running checks',
    pct: 70,
    at: ts(NOW - 5 * 60_000),
    by: 'ag',
    ...over,
  });
  it('shows the status line of the current run only', () => {
    expect(statusView({ ...base, statusUpdate: su() } as Item, NOW)).toEqual({
      status: 'Running checks · 70%',
    });
    expect(statusView({ ...base, statusUpdate: su({ pct: null }) } as Item, NOW).status).toBe(
      'Running checks',
    );
    expect(statusView({ ...base, statusUpdate: su({ runId: 'old' }) } as Item, NOW)).toEqual({});
    expect(statusView({ ...base, status: 'queued', statusUpdate: su() } as Item, NOW)).toEqual({});
  });
  it('shows the silence flag until a newer status arrives; not while parked', () => {
    const silence = { runId: 'r1', since: NOW - 42 * 60_000, at: NOW - 60_000 };
    expect(statusView({ ...base, silence } as Item, NOW)).toEqual({
      silence: 'No update for 42 min',
    });
    expect(
      statusView({ ...base, silence, statusUpdate: su({ at: ts(NOW - 30_000) }) } as Item, NOW),
    ).toEqual({ status: 'Running checks · 70%' });
    const parked = { runId: 'r1', reason: 'release', at: ts(NOW) };
    expect(statusView({ ...base, silence, parked } as Item, NOW)).toEqual({});
    expect(statusView({ ...base, silence: { ...silence, runId: 'old' } } as Item, NOW)).toEqual({});
  });
  it('Ask for status: on live worked items, then "Asked · waiting…" for 2 minutes', () => {
    expect(askStatusState(base, NOW)).toEqual({
      show: true,
      disabled: false,
      label: 'Ask for status',
    });
    const stale = { ...base, claim: { ...claim, heartbeatAt: ts(NOW - 20 * 60_000) } } as Item;
    expect(askStatusState(stale, NOW).show).toBe(false);
    const waiting = {
      ...base,
      awaitingAnswer: { questionId: 'q', agentUid: 'ag', at: ts(NOW) },
    } as Item;
    expect(askStatusState(waiting, NOW).show).toBe(false);
    const asked = {
      ...base,
      statusAsk: { runId: 'r1', byUid: 'me', at: ts(NOW - 60_000) },
    } as Item;
    expect(askStatusState(asked, NOW)).toEqual({
      show: true,
      disabled: true,
      label: 'Asked · waiting…',
    });
    expect(askStatusState(asked, NOW + 61_000)).toEqual({
      show: true,
      disabled: false,
      label: 'Ask again',
    });
    const answered = { ...asked, statusUpdate: su({ at: ts(NOW - 30_000) }) } as Item;
    expect(askStatusState(answered, NOW)).toEqual({
      show: true,
      disabled: true,
      label: 'Ask for status',
    });
    expect(askStatusState(answered, NOW + 61_000).disabled).toBe(false);
  });
});
