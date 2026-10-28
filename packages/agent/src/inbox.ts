/**
 * Inbox tools for agents (item 4PEHrOW5IfXBQWgOK9wo; actions in packages/shared/src/inbox.ts):
 * inbox_add, inbox_list, inbox_read, subject_list, subject_assign, inbox_draft, inbox_sent.
 * The Go CLI mirrors this file (cli/internal/hive/inbox.go); packages/agent/test/go.integration
 * compares both against the emulators.
 *
 * Nothing here sends anything: an agent posts a reply in the source channel only for a request
 * its person pressed Send on (status `sending`, `approved.reply`), and then calls inbox_sent.
 */
import { createHash } from 'node:crypto';
import {
  ActionError,
  addInboxRequest,
  assignSubject,
  draftReply,
  inboxPaths,
  inboxRequestIdFromDigest,
  inboxRequestKey,
  markSent,
  paths,
  type ActionContext,
  type ActionPlan,
  type InboxRequest,
  type InboxSubject,
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
  'Hivenod refused this inbox change (permission denied): the request may have changed since it was read (read it again with inbox_read), or this agent was revoked.';

/** The request id of an input (the dedup key's SHA-256). */
export function inboxRequestId(source: string, threadRef: string, messageId: string): string {
  const hex = createHash('sha256')
    .update(inboxRequestKey(source, threadRef, messageId), 'utf8')
    .digest('hex');
  return inboxRequestIdFromDigest(hex);
}

const ACTIVE = ['new', 'drafting', 'yourCall', 'sending'];
const EXCERPT = 200;

type Stored = Omit<InboxRequest, 'receivedAt'> & { receivedAt: { toMillis(): number } };

const iso = (t: { toMillis(): number } | null | undefined) =>
  t ? new Date(t.toMillis()).toISOString() : null;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const NEXT: Record<string, (byMe: boolean) => string> = {
  new: () => 'File it under a subject: subject_list, then subject_assign.',
  drafting: () =>
    "Draft the reply in the person's voice with inbox_draft (it waits for their Send; nothing is sent before).",
  yourCall: () =>
    'Waiting for the person to Send, Edit or Ignore it in Hivenod. You may revise the draft with inbox_draft.',
  sending: (byMe) =>
    byMe
      ? 'The person pressed Send: post approved.reply exactly as written in the source thread, as them, then call inbox_sent.'
      : 'The person pressed Send; the agent that brought it in posts it.',
  done: () => 'Done: the reply was sent.',
  ignored: () => 'The person ignored it: do nothing.',
};

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
      if (errorCode(e) === 'permission-denied')
        throw new HiveError(
          'Hivenod refused to read the inbox (permission denied): this agent may have been revoked.',
        );
      throw e;
    }
  }

  private async members(): Promise<string[]> {
    const ws = await this.read(() => getDoc(doc(this.d.db, paths.workspace(this.d.workspaceId))));
    return Object.keys((ws.data()?.memberRoles as Record<string, string> | undefined) ?? {});
  }

  /** The member a request is for: the given uid, else the person who connected this agent. */
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

  private async request(requestId: string): Promise<Stored> {
    const snap = await this.read(() =>
      getDoc(doc(this.d.db, inboxPaths.request(this.d.workspaceId, requestId))),
    );
    if (!snap.exists()) throw new HiveError(`Inbox request ${requestId} not found.`);
    return snap.data() as Stored;
  }

  private async subject(subjectId: string): Promise<InboxSubject | null> {
    const snap = await this.read(() =>
      getDoc(doc(this.d.db, inboxPaths.subject(this.d.workspaceId, subjectId))),
    );
    return snap.exists() ? (snap.data() as InboxSubject) : null;
  }

  private async subjectsOf(member: string) {
    const snap = await this.read(() =>
      getDocs(
        query(
          collection(this.d.db, `workspaces/${this.d.workspaceId}/inboxSubjects`),
          where('memberUid', '==', member),
        ),
      ),
    );
    return snap.docs.map((s) => ({ id: s.id, data: s.data() as InboxSubject }));
  }

  private async active() {
    const snap = await this.read(() =>
      getDocs(
        query(
          collection(this.d.db, `workspaces/${this.d.workspaceId}/inboxRequests`),
          where('status', 'in', ACTIVE),
        ),
      ),
    );
    return snap.docs.map((s) => ({ id: s.id, data: s.data() as Stored }));
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
  }) {
    const ms = Date.parse(input.receivedAt);
    if (Number.isNaN(ms))
      throw new HiveError('receivedAt is not a valid ISO 8601 time (e.g. 2026-10-28T09:00:00Z).');
    const memberUid = await this.member(input.member);
    const messageId = input.messageId ?? String(ms);
    const requestId = inboxRequestId(input.source, input.threadRef, messageId);
    const dup = async () => {
      const snap = await this.read(() =>
        getDoc(doc(this.d.db, inboxPaths.request(this.d.workspaceId, requestId))),
      );
      if (!snap.exists()) return null;
      const r = snap.data() as Stored;
      return {
        requestId,
        duplicate: true,
        status: r.status,
        member: r.memberUid,
        note: 'Already in Inbox (same source, thread and message): nothing was added.',
      };
    };
    const before = await dup();
    if (before) return before;
    const plan = this.wrap(() =>
      addInboxRequest(this.d.ctx, {
        requestId,
        memberUid,
        source: input.source,
        sender: { name: input.sender.name, handle: input.sender.handle ?? null },
        text: input.text,
        threadRef: input.threadRef,
        messageId,
        permalink: input.permalink ?? null,
        replyRef: input.replyRef ?? null,
        receivedAt: new Date(ms),
        attachments: input.attachments ?? [],
      }),
    );
    try {
      await this.write(plan);
    } catch (e) {
      // Another agent (or call) brought the same input in a moment ago.
      const now = await dup().catch(() => null);
      if (now) return now;
      throw e;
    }
    return {
      requestId,
      duplicate: false,
      status: 'new',
      member: memberUid,
      note: 'Brought into Inbox. File it under a subject next: subject_list, then subject_assign.',
    };
  }

  private row(id: string, r: Stored) {
    return {
      requestId: id,
      member: r.memberUid,
      status: r.status,
      source: r.source,
      sender: r.sender.name,
      receivedAt: iso(r.receivedAt),
      subjectId: r.subjectId,
      excerpt: r.text.slice(0, EXCERPT),
    };
  }

  /** Requests waiting for agents: to file, to draft, and (brought in by this agent) to send. */
  async list() {
    const all = (await this.active()).sort(
      (a, b) => a.data.receivedAt.toMillis() - b.data.receivedAt.toMillis() || cmp(a.id, b.id),
    );
    return {
      toFile: all.filter((r) => r.data.status === 'new').map((r) => this.row(r.id, r.data)),
      toDraft: all.filter((r) => r.data.status === 'drafting').map((r) => this.row(r.id, r.data)),
      toSend: all
        .filter((r) => r.data.status === 'sending' && r.data.fetchedBy === this.d.uid)
        .map((r) => this.row(r.id, r.data)),
    };
  }

  async readRequest(requestId: string) {
    const r = await this.request(requestId);
    const subject = r.subjectId ? await this.subject(r.subjectId) : null;
    let related: unknown[] = [];
    if (r.subjectId) {
      const snap = await this.read(() =>
        getDocs(
          query(
            collection(this.d.db, `workspaces/${this.d.workspaceId}/inboxRequests`),
            where('subjectId', '==', r.subjectId),
          ),
        ),
      );
      related = snap.docs
        .filter((s) => s.id !== requestId)
        .map((s) => ({ id: s.id, data: s.data() as Stored }))
        .sort(
          (a, b) => b.data.receivedAt.toMillis() - a.data.receivedAt.toMillis() || cmp(a.id, b.id),
        )
        .slice(0, 10)
        .map(({ id, data }) => ({
          requestId: id,
          status: data.status,
          source: data.source,
          sender: data.sender.name,
          receivedAt: iso(data.receivedAt),
          excerpt: data.text.slice(0, 500),
          sentReply: data.status === 'done' && data.approved ? data.approved.reply : null,
        }));
    }
    const byMe = r.fetchedBy === this.d.uid;
    return {
      requestId,
      member: r.memberUid,
      status: r.status,
      source: r.source,
      sender: { name: r.sender.name, handle: r.sender.handle },
      text: r.text,
      threadRef: r.threadRef,
      messageId: r.messageId,
      permalink: r.permalink,
      replyRef: r.replyRef,
      receivedAt: iso(r.receivedAt),
      attachments: r.attachments.map((a) => ({ name: a.name, url: a.url })),
      fetchedBy: r.fetchedBy,
      fetchedByMe: byMe,
      subject: r.subjectId ? { subjectId: r.subjectId, name: subject?.name ?? null } : null,
      draft: r.draft
        ? { reply: r.draft.reply, actions: r.draft.actions, by: r.draft.by.type }
        : null,
      approved: r.approved ? { reply: r.approved.reply, actions: r.approved.actions } : null,
      sent: r.sent ? { permalink: r.sent.permalink } : null,
      related,
      next: NEXT[r.status]!(byMe),
    };
  }

  async subjects(given?: string) {
    const member = await this.member(given);
    const subs = await this.subjectsOf(member);
    const reqs = (await this.active()).filter((r) => r.data.memberUid === member);
    const count = (sid: string, statuses: string[]) =>
      reqs.filter((r) => r.data.subjectId === sid && statuses.includes(r.data.status)).length;
    const subjects = subs
      .map((s) => ({
        subjectId: s.id,
        name: s.data.name,
        waiting: count(s.id, ['yourCall']),
        open: count(s.id, ACTIVE),
      }))
      .sort(
        (a, b) =>
          b.waiting - a.waiting ||
          b.open - a.open ||
          cmp(a.name, b.name) ||
          cmp(a.subjectId, b.subjectId),
      );
    return {
      member,
      subjects,
      unfiled: reqs.filter((r) => r.data.subjectId === null && r.data.status === 'new').length,
    };
  }

  async assign(requestId: string, subjectId?: string, name?: string) {
    if ((subjectId === undefined) === (name === undefined))
      throw new HiveError('Give either subjectId (an existing subject) or name (a new one).');
    const r = await this.request(requestId);
    let target = subjectId;
    if (target !== undefined) {
      const s = await this.subject(target);
      if (!s || s.memberUid !== r.memberUid)
        throw new HiveError(
          `Subject ${target} not found among this person's subjects (see subject_list).`,
        );
    } else {
      // Reuse a subject of the same name rather than making a twin.
      const want = name!.trim().replace(/\s+/g, ' ').toLowerCase();
      const same = (await this.subjectsOf(r.memberUid))
        .filter((s) => s.data.name.toLowerCase() === want)
        .sort((a, b) => cmp(a.id, b.id))[0];
      if (same) target = same.id;
    }
    const plan = this.wrap(() =>
      assignSubject(this.d.ctx, {
        requestId,
        request: r,
        ...(target !== undefined ? { subjectId: target } : { newName: name! }),
      }),
    );
    await this.write(plan);
    const s = plan.created ? null : await this.subject(plan.subjectId);
    const subjectName = plan.created ? name!.trim().replace(/\s+/g, ' ') : (s?.name ?? '');
    return {
      requestId,
      subjectId: plan.subjectId,
      name: subjectName,
      created: plan.created,
      status: r.status === 'new' ? 'drafting' : r.status,
      note: plan.created
        ? `Filed under a new subject "${subjectName}". Draft the reply next: inbox_draft.`
        : `Filed under "${subjectName}". Draft the reply next: inbox_draft.`,
    };
  }

  async draft(requestId: string, reply: string, actions: string[] = []) {
    const r = await this.request(requestId);
    await this.write(
      this.wrap(() => draftReply(this.d.ctx, { requestId, request: r, reply, actions })),
    );
    return {
      requestId,
      status: 'yourCall',
      note: 'Drafted. It waits for the person to Send, Edit or Ignore it in Hivenod; nothing is sent before.',
    };
  }

  async sent(requestId: string, permalink?: string) {
    const r = await this.request(requestId);
    await this.write(this.wrap(() => markSent(this.d.ctx, { requestId, request: r, permalink })));
    return { requestId, status: 'done', note: 'Marked as sent. It shows as Done in the timeline.' };
  }
}
