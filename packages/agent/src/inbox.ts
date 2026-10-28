/**
 * Inbox tools for agents (item 4PEHrOW5IfXBQWgOK9wo; actions in packages/shared/src/inbox.ts,
 * outcomes in packages/shared/src/outcomes.ts): inbox_add, inbox_list, thread_read,
 * subject_list, subject_assign, inbox_note, inbox_ask, outcome_propose, outcome_done,
 * thread_wake. The Go CLI mirrors this file (cli/internal/hive/inbox.go);
 * packages/agent/test/go.integration.test.ts compares both against the emulators.
 *
 * Nothing here carries anything out by itself: an agent sends, books or hands over only for an
 * outcome its person approved (state approved, with the approved fields), then reports
 * outcome_done.
 */
import { createHash } from 'node:crypto';
import {
  ActionError,
  addInboxMessage,
  addThreadNote,
  askMember,
  assignSubject,
  digest24,
  finishOutcome,
  inboxMessageKey,
  inboxPaths,
  inboxThreadKey,
  paths,
  proposeOutcome,
  THREAD_OPEN,
  wakeThread,
  type ActionContext,
  type ActionPlan,
  type InboxMessage,
  type InboxOutcome,
  type InboxSubject,
  type InboxThread,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '@hive/shared';
import { applyPlan } from '@hive/shared/firestore';
import { collection, doc, getDoc, getDocs, query, where, type Firestore } from 'firebase/firestore';
import { errorCode, HiveError } from './errors';

export interface InboxDeps {
  db: Firestore;
  workspaceId: string;
  uid: string;
  ctx: ActionContext;
  /** This agent's doc, read again (revoked agents fail here). */
  agentCreatedBy: () => Promise<string>;
}

export const INBOX_DENIED =
  'Hivenod refused this inbox change (permission denied): the thread may have changed since it was read (read it again with thread_read), or this agent was revoked.';
const READ_DENIED =
  'Hivenod refused to read the inbox (permission denied): this agent may have been revoked.';

/** The first 24 hex digits of SHA-256(key). */
export function digestOf(key: string): string {
  return digest24(createHash('sha256').update(key, 'utf8').digest('hex'));
}

type Ts = { toMillis(): number };
type Stored<T> = Omit<T, 'receivedAt' | 'lastMessageAt' | 'createdAt' | 'updatedAt' | 'at'> & {
  receivedAt: Ts;
  lastMessageAt: Ts;
  createdAt: Ts;
};

const iso = (t: Ts | null | undefined) => (t ? new Date(t.toMillis()).toISOString() : null);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const NEXT: Record<string, string> = {
  investigating:
    "Investigate: read the messages and the subject's other threads, note what you find (inbox_note), ask the person if you must (inbox_ask), then propose what should come of it (outcome_propose).",
  needsYou: "Waiting for the person's answer to your question.",
  yourCall: 'Waiting for the person to approve, edit or reject the proposed outcomes.',
  waiting: 'Waiting. A new message from them reopens it.',
  done: 'Done.',
  ignored: 'The person ignored it: do nothing.',
};
export const CARRY_OUT =
  'Carry out the approved outcome exactly as approved (its fields, as the person left them), then report it with outcome_done.';

const COLLECTIONS = [
  'inboxThreads',
  'inboxSubjects',
  'inboxMessages',
  'inboxOutcomes',
  'inboxEvents',
] as const;
type Coll = (typeof COLLECTIONS)[number];

export class InboxOps {
  constructor(private readonly d: InboxDeps) {}

  private async write(plan: Pick<ActionPlan, 'ops'>): Promise<void> {
    try {
      await applyPlan(this.d.db, plan);
    } catch (e) {
      if (errorCode(e) === 'permission-denied') throw new HiveError(INBOX_DENIED);
      throw e;
    }
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ActionError) throw new HiveError(e.message);
      throw e;
    }
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (errorCode(e) === 'permission-denied') throw new HiveError(READ_DENIED);
      throw e;
    }
  }

  private async get<T>(path: string): Promise<T | null> {
    const snap = await this.read(() => getDoc(doc(this.d.db, path)));
    return snap.exists() ? (snap.data() as T) : null;
  }

  private async list<T>(
    name: Coll,
    field: string,
    op: '==' | 'in' | 'array-contains',
    value: unknown,
  ) {
    const w = this.d.workspaceId;
    // Literal collection paths, so scripts/check-firestore-indexes.mjs can check them.
    const q = {
      inboxThreads: () =>
        query(collection(this.d.db, `workspaces/${w}/inboxThreads`), where(field, op, value)),
      inboxSubjects: () =>
        query(collection(this.d.db, `workspaces/${w}/inboxSubjects`), where(field, op, value)),
      inboxMessages: () =>
        query(collection(this.d.db, `workspaces/${w}/inboxMessages`), where(field, op, value)),
      inboxOutcomes: () =>
        query(collection(this.d.db, `workspaces/${w}/inboxOutcomes`), where(field, op, value)),
      inboxEvents: () =>
        query(collection(this.d.db, `workspaces/${w}/inboxEvents`), where(field, op, value)),
    }[name]();
    const snap = await this.read(() => getDocs(q));
    return snap.docs.map((s) => ({ id: s.id, data: s.data() as T }));
  }

  private async members(): Promise<string[]> {
    const ws = await this.get<{ memberRoles?: Record<string, string> }>(
      paths.workspace(this.d.workspaceId),
    );
    return Object.keys(ws?.memberRoles ?? {});
  }

  /** The member it is for: the given uid, else the person who connected this agent. */
  private async member(given?: string): Promise<string> {
    const members = await this.members();
    if (given) {
      if (!members.includes(given))
        throw new HiveError(`${given} is not a member of this organization.`);
      return given;
    }
    const creator = await this.d.agentCreatedBy();
    if (!members.includes(creator))
      throw new HiveError(
        'Name the member (member: their user id): the person who connected this agent is no longer in the organization.',
      );
    return creator;
  }

  private async thread(threadId: string): Promise<Stored<InboxThread>> {
    const t = await this.get<Stored<InboxThread>>(inboxPaths.thread(this.d.workspaceId, threadId));
    if (!t) throw new HiveError(`Thread ${threadId} not found.`);
    return t;
  }

  private async outcome(outcomeId: string): Promise<Stored<InboxOutcome>> {
    const o = await this.get<Stored<InboxOutcome>>(
      inboxPaths.outcome(this.d.workspaceId, outcomeId),
    );
    if (!o) throw new HiveError(`Outcome ${outcomeId} not found.`);
    return o;
  }

  private state(t: Stored<InboxThread>): ThreadStateOf {
    return {
      memberUid: t.memberUid,
      subjectId: t.subjectId,
      state: t.state,
      fetchedBy: t.fetchedBy,
      refs: t.refs ?? [],
      waiting: t.waiting ?? null,
      question: t.question ?? null,
    };
  }

  async add(input: {
    source: string;
    sender: { name: string; handle?: string };
    text: string;
    threadRef: string;
    receivedAt: string;
    messageId?: string;
    permalink?: string;
    replyRef?: string;
    member?: string;
    attachments?: { name: string; url: string }[];
    thread?: string;
    fromMember?: boolean;
    title?: string;
  }) {
    const ms = Date.parse(input.receivedAt);
    if (Number.isNaN(ms))
      throw new HiveError('receivedAt is not a valid ISO 8601 time (e.g. 2026-10-28T09:00:00Z).');
    const memberUid = await this.member(input.member);
    const messageId = input.messageId ?? String(ms);
    const mid = `im${digestOf(inboxMessageKey(memberUid, input.source, input.threadRef, messageId))}`;
    const ref = digestOf(inboxThreadKey(memberUid, input.source, input.threadRef));
    const dup = async () => {
      const m = await this.get<InboxMessage>(inboxPaths.message(this.d.workspaceId, mid));
      if (!m) return null;
      const t = await this.get<InboxThread>(inboxPaths.thread(this.d.workspaceId, m.threadId));
      return {
        messageId: mid,
        threadId: m.threadId,
        newThread: false,
        duplicate: true,
        state: t?.state ?? null,
        member: m.memberUid,
        note: 'Already in Inbox (same source, thread and message): nothing was added.',
      };
    };
    const before = await dup();
    if (before) return before;
    const attempt = async () => {
      let joined: { threadId: string; state: ThreadStateOf } | null = null;
      if (input.thread) {
        const t = await this.get<Stored<InboxThread>>(
          inboxPaths.thread(this.d.workspaceId, input.thread),
        );
        if (!t || t.memberUid !== memberUid)
          throw new HiveError(`Thread ${input.thread} not found among this person's threads.`);
        joined = { threadId: input.thread, state: this.state(t) };
      } else {
        const own = await this.get<Stored<InboxThread>>(
          inboxPaths.thread(this.d.workspaceId, `it${ref}`),
        );
        if (own) joined = { threadId: `it${ref}`, state: this.state(own) };
        else {
          const hit = (
            await this.list<Stored<InboxThread>>('inboxThreads', 'refs', 'array-contains', ref)
          )
            .filter((t) => t.data.memberUid === memberUid)
            .sort((a, b) => cmp(a.id, b.id))[0];
          if (hit) joined = { threadId: hit.id, state: this.state(hit.data) };
        }
      }
      const plan = this.wrap(() =>
        addInboxMessage(this.d.ctx, {
          messageDocId: mid,
          ref,
          memberUid,
          direction: input.fromMember ? 'out' : 'in',
          source: input.source,
          sender: { name: input.sender.name, handle: input.sender.handle ?? null },
          text: input.text,
          threadRef: input.threadRef,
          messageId,
          permalink: input.permalink ?? null,
          replyRef: input.replyRef ?? null,
          receivedAt: new Date(ms),
          attachments: input.attachments ?? [],
          thread: joined,
          ...(input.title !== undefined ? { title: input.title } : {}),
        }),
      );
      await this.write(plan);
      return plan;
    };
    let plan;
    try {
      plan = await attempt();
    } catch (e) {
      if (!(e instanceof HiveError) || e.message !== INBOX_DENIED) throw e;
      // Another agent brought the same message (or the same new thread) in a moment ago.
      const now = await dup();
      if (now) return now;
      plan = await attempt();
    }
    return {
      messageId: mid,
      threadId: plan.threadId,
      newThread: plan.newThread,
      duplicate: false,
      state: plan.state,
      member: memberUid,
      note: plan.newThread
        ? 'Brought into Inbox as a new thread. File it under a subject (subject_list, then subject_assign) and investigate.'
        : 'Added to its thread.',
    };
  }

  private threadRow(id: string, t: Stored<InboxThread>) {
    return {
      threadId: id,
      member: t.memberUid,
      state: t.state,
      title: t.title,
      subjectId: t.subjectId,
      lastMessageAt: iso(t.lastMessageAt),
    };
  }

  /** What agents have to do: threads to work, approved outcomes to carry out, snoozes due. */
  async listWork() {
    const threads = (
      await this.list<Stored<InboxThread>>('inboxThreads', 'state', 'in', [
        'investigating',
        'waiting',
      ])
    ).sort(
      (a, b) =>
        a.data.lastMessageAt.toMillis() - b.data.lastMessageAt.toMillis() || cmp(a.id, b.id),
    );
    const now = Date.now();
    const outcomes = (
      await this.list<Stored<InboxOutcome>>('inboxOutcomes', 'state', '==', 'approved')
    )
      .filter((o) => o.data.executor === this.d.uid)
      .sort((a, b) => a.data.createdAt.toMillis() - b.data.createdAt.toMillis() || cmp(a.id, b.id));
    return {
      toWork: threads
        .filter((t) => t.data.state === 'investigating')
        .map((t) => this.threadRow(t.id, t.data)),
      toCarryOut: outcomes.map((o) => ({
        outcomeId: o.id,
        threadId: o.data.threadId,
        member: o.data.memberUid,
        type: o.data.type,
        fields: o.data.fields,
      })),
      toWake: threads
        .filter((t) => {
          const u =
            t.data.state === 'waiting' ? (t.data.waiting?.until as Ts | null | undefined) : null;
          return !!u && u.toMillis() <= now;
        })
        .map((t) => this.threadRow(t.id, t.data)),
    };
  }

  async readThread(threadId: string) {
    const t = await this.thread(threadId);
    const subject = t.subjectId
      ? await this.get<InboxSubject>(inboxPaths.subject(this.d.workspaceId, t.subjectId))
      : null;
    const messages = (
      await this.list<Stored<InboxMessage>>('inboxMessages', 'threadId', '==', threadId)
    )
      .sort(
        (a, b) => a.data.receivedAt.toMillis() - b.data.receivedAt.toMillis() || cmp(a.id, b.id),
      )
      .map(({ id, data: m }) => ({
        messageId: id,
        direction: m.direction,
        source: m.source,
        sender: { name: m.sender.name, handle: m.sender.handle },
        text: m.text,
        threadRef: m.threadRef,
        permalink: m.permalink,
        replyRef: m.replyRef,
        receivedAt: iso(m.receivedAt),
        attachments: m.attachments.map((a) => ({ name: a.name, url: a.url })),
      }));
    const outcomes = (
      await this.list<Stored<InboxOutcome>>('inboxOutcomes', 'threadId', '==', threadId)
    )
      .sort((a, b) => a.data.createdAt.toMillis() - b.data.createdAt.toMillis() || cmp(a.id, b.id))
      .map(({ id, data: o }) => ({
        outcomeId: id,
        type: o.type,
        state: o.state,
        fields: o.fields,
        note: o.note,
        executor: o.executor,
        executorIsMe: o.executor === this.d.uid,
        decision: o.decision ? { edited: o.decision.edited, reason: o.decision.reason } : null,
        result: o.result
          ? {
              text: o.result.text,
              permalink: o.result.permalink,
              itemId: o.result.itemId,
              error: o.result.error,
            }
          : null,
      }));
    const shown = ['thread.note', 'thread.asked', 'thread.answered', 'outcome.rejected'];
    const timeline = (
      await this.list<{
        type: string;
        at: Ts;
        actor: { type: string };
        data: Record<string, unknown>;
      }>('inboxEvents', 'threadId', '==', threadId)
    )
      .filter((e) => shown.includes(e.data.type))
      .sort((a, b) => a.data.at.toMillis() - b.data.at.toMillis() || cmp(a.id, b.id))
      .map(({ data: e }) => ({
        type: e.type,
        by: e.actor.type,
        at: iso(e.at),
        text: (e.data.text ?? e.data.answer ?? e.data.reason ?? null) as string | null,
      }));
    const carry = outcomes.some((o) => o.state === 'approved' && o.executorIsMe);
    const until = t.waiting?.until as Ts | null | undefined;
    return {
      threadId,
      member: t.memberUid,
      state: t.state,
      waiting: t.waiting ? { on: t.waiting.on, until: iso(until ?? null) } : null,
      question: t.question ? { text: t.question.text, answer: t.question.answer } : null,
      title: t.title,
      subject: t.subjectId ? { subjectId: t.subjectId, name: subject?.name ?? null } : null,
      fetchedBy: t.fetchedBy,
      fetchedByMe: t.fetchedBy === this.d.uid,
      messages,
      outcomes,
      timeline,
      next: carry ? CARRY_OUT : NEXT[t.state]!,
    };
  }

  async subjects(given?: string) {
    const member = await this.member(given);
    const subs = await this.list<InboxSubject>('inboxSubjects', 'memberUid', '==', member);
    const open = (
      await this.list<Stored<InboxThread>>('inboxThreads', 'state', 'in', [...THREAD_OPEN])
    ).filter((t) => t.data.memberUid === member);
    const count = (sid: string, states: readonly string[]) =>
      open.filter((t) => t.data.subjectId === sid && states.includes(t.data.state)).length;
    const subjects = subs
      .map((s) => ({
        subjectId: s.id,
        name: s.data.name,
        forYou: count(s.id, ['needsYou', 'yourCall']),
        open: count(s.id, THREAD_OPEN),
      }))
      .sort(
        (a, b) =>
          b.forYou - a.forYou ||
          b.open - a.open ||
          cmp(a.name, b.name) ||
          cmp(a.subjectId, b.subjectId),
      );
    return { member, subjects, unfiled: open.filter((t) => t.data.subjectId === null).length };
  }

  async assign(threadId: string, subjectId?: string, name?: string) {
    if ((subjectId === undefined) === (name === undefined))
      throw new HiveError('Give either subjectId (an existing subject) or name (a new one).');
    const t = await this.thread(threadId);
    let target = subjectId;
    if (target !== undefined) {
      const s = await this.get<InboxSubject>(inboxPaths.subject(this.d.workspaceId, target));
      if (!s || s.memberUid !== t.memberUid)
        throw new HiveError(
          `Subject ${target} not found among this person's subjects (see subject_list).`,
        );
    } else {
      // Reuse a subject of the same name rather than making a twin.
      const want = name!.trim().replace(/\s+/g, ' ').toLowerCase();
      const same = (await this.list<InboxSubject>('inboxSubjects', 'memberUid', '==', t.memberUid))
        .filter((s) => s.data.name.toLowerCase() === want)
        .sort((a, b) => cmp(a.id, b.id))[0];
      if (same) target = same.id;
    }
    const plan = this.wrap(() =>
      assignSubject(this.d.ctx, {
        threadId,
        thread: this.state(t),
        ...(target !== undefined ? { subjectId: target } : { newName: name! }),
      }),
    );
    await this.write(plan);
    const s = plan.created
      ? null
      : await this.get<InboxSubject>(inboxPaths.subject(this.d.workspaceId, plan.subjectId));
    const subjectName = plan.created ? name!.trim().replace(/\s+/g, ' ') : (s?.name ?? '');
    return {
      threadId,
      subjectId: plan.subjectId,
      name: subjectName,
      created: plan.created,
      note: plan.created
        ? `Filed under a new subject "${subjectName}".`
        : `Filed under "${subjectName}".`,
    };
  }

  async note(threadId: string, text: string) {
    const t = await this.thread(threadId);
    await this.write(
      this.wrap(() => addThreadNote(this.d.ctx, { threadId, thread: this.state(t), text })),
    );
    return { threadId, note: 'Noted on the timeline.' };
  }

  async ask(threadId: string, question: string) {
    const t = await this.thread(threadId);
    await this.write(
      this.wrap(() => askMember(this.d.ctx, { threadId, thread: this.state(t), question })),
    );
    return {
      threadId,
      state: 'needsYou',
      note: 'Asked. The thread waits in Needs you; the answer shows in thread_read.',
    };
  }

  async propose(threadId: string, type: string, fields: Record<string, unknown>, note?: string) {
    const t = await this.thread(threadId);
    const plan = this.wrap(() =>
      proposeOutcome(this.d.ctx, { threadId, thread: this.state(t), type, fields, note }),
    );
    await this.write(plan);
    return {
      outcomeId: plan.outcomeId,
      threadId,
      type,
      state: 'proposed',
      note: 'Proposed. It waits for the person to approve, edit or reject it; nothing is carried out before.',
    };
  }

  async done(
    outcomeId: string,
    status: 'done' | 'failed',
    result: { text?: string; permalink?: string; itemId?: string; error?: string } = {},
  ) {
    const o = await this.outcome(outcomeId);
    const t = await this.thread(o.threadId);
    const st: OutcomeStateOf = {
      memberUid: o.memberUid,
      threadId: o.threadId,
      type: o.type,
      fields: o.fields,
      state: o.state,
      executor: o.executor,
    };
    await this.write(
      this.wrap(() =>
        finishOutcome(this.d.ctx, {
          outcomeId,
          outcome: st,
          thread: this.state(t),
          status,
          result,
        }),
      ),
    );
    const after = await this.thread(o.threadId);
    return {
      outcomeId,
      state: status,
      threadId: o.threadId,
      threadState: after.state,
      note:
        status === 'done'
          ? 'Reported as done.'
          : 'Reported as failed: the thread is back to investigating.',
    };
  }

  async wake(threadId: string) {
    const t = await this.thread(threadId);
    await this.write(
      this.wrap(() =>
        wakeThread(this.d.ctx, { threadId, thread: this.state(t), nowMs: Date.now() }),
      ),
    );
    return { threadId, state: 'investigating', note: 'Awake: investigate it again.' };
  }
}
