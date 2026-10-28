/**
 * The agent operations as MCP tools (SPEC section 10). Input schemas are Zod; the MCP SDK turns
 * them into the JSON Schemas Claude Code shows. Descriptions are written for the model using them.
 */
import { z } from 'zod';
import { OUTCOME_TYPES, outcomeGuide } from '@hive/shared';
import { deleteEvents, freeTime, upsertEvents, type CalendarEventArg } from './calendar';
import type { HiveClient } from './client';

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: S;
  run: (client: HiveClient, args: z.infer<z.ZodObject<S>>, ctx?: ToolContext) => Promise<unknown>;
}

/** Per call: `signal` is aborted when the caller goes away (its bridge connection closed). */
export interface ToolContext {
  signal: AbortSignal;
}

const tool = <S extends z.ZodRawShape>(def: ToolDef<S>) => def as unknown as ToolDef;

const itemId = z.string().min(1).describe('Item id, as returned by list_work');
const runId = z.string().min(1).describe('Run id, as returned by claim');
const projectId = z
  .string()
  .optional()
  .describe('Project id; only needed if the item id is ambiguous');

export const TOOLS: ToolDef[] = [
  tool({
    name: 'list_work',
    description:
      'List items waiting for an agent: items at agent steps that are unclaimed, claimed by you, or whose claim has gone stale (no heartbeat for 10 minutes). Items waiting for people (at a gate, or for the answer to a question asked when a run was given back) and steps limited to other agents are not listed. Fails if this agent is paused. Start here.',
    input: {
      project: z.string().optional().describe('Only this project id'),
      step: z.string().optional().describe('Only this step id'),
    },
    run: (c, a) =>
      c.listWork({
        projectId: a.project as string | undefined,
        stepId: a.step as string | undefined,
      }),
  }),
  tool({
    name: 'wait_for_work',
    description:
      'Block until an item is waiting for this agent (for example right after a person approves a gate), then return it like list_work. Returns immediately if work is already waiting. Listens live, so it reacts within seconds. If nothing arrives within timeoutSeconds (default 300, max 540) it returns timedOut true with no work; call it again to keep waiting. Use this instead of polling list_work.',
    input: {
      project: z.string().optional().describe('Only this project id'),
      step: z.string().optional().describe('Only this step id'),
      timeoutSeconds: z.number().int().min(1).max(540).optional().describe('Default 300'),
    },
    run: (c, a) =>
      c.waitForWork({
        projectId: a.project as string | undefined,
        stepId: a.step as string | undefined,
        timeoutMs: ((a.timeoutSeconds as number | undefined) ?? 300) * 1000,
      }),
  }),
  tool({
    name: 'claim',
    description:
      'Claim an item and start a run. Returns the runId that every other call needs. Heartbeats are sent automatically every 60 seconds while this server runs. Fails if another agent holds the item or if it is at a human gate. Read the brief with read_item next.',
    input: { itemId, project: projectId },
    run: (c, a) => c.claim(a.itemId as string, a.project as string | undefined),
  }),
  tool({
    name: 'read_item',
    description:
      'Read everything needed to do the work on an item: the step instructions and expected outputs, the brief (the Markdown description of the item, which people can edit), attachments (text in full), messages and answers, previous decisions and the reasons people sent it back. Always read the send-back reasons before redoing work.',
    input: { itemId, project: projectId },
    run: (c, a) => c.readItem(a.itemId as string, a.project as string | undefined),
  }),
  tool({
    name: 'log',
    description:
      'Append a short log line to a run so people can follow what you are doing. At most 500 lines per run.',
    input: {
      runId,
      text: z.string().min(1).max(4000).describe('What you did or are doing'),
      level: z.enum(['info', 'warn', 'error']).optional().describe('Defaults to info'),
    },
    run: (c, a) =>
      c.log(a.runId as string, a.text as string, a.level as 'info' | 'warn' | 'error' | undefined),
  }),
  tool({
    name: 'attach',
    description:
      'Attach a deliverable to an item. source is a file path (html, md, txt, png, jpg, pdf; up to 900 KB, inlined) or an http(s) URL (stored as a link; use it for anything bigger). Prefer one self-contained HTML file for reports. Content is shown sandboxed to people.',
    input: {
      itemId,
      source: z.string().min(1).describe('File path or URL'),
      name: z.string().max(200).optional().describe('Display name; defaults to the file name'),
      project: projectId,
    },
    run: (c, a) =>
      c.attach(a.itemId as string, a.source as string, {
        name: a.name as string | undefined,
        projectId: a.project as string | undefined,
      }),
  }),
  tool({
    name: 'ask',
    description:
      'Ask people a question about an item when you are blocked or unsure. It appears under "Needs you" in Hivenod and the answer shows up in read_item. Keep working on anything that does not depend on the answer.',
    input: { itemId, question: z.string().min(1).max(8000), project: projectId },
    run: (c, a) => c.ask(a.itemId as string, a.question as string, a.project as string | undefined),
  }),
  tool({
    name: 'progress',
    description: 'Report progress on the item you hold, as done out of total steps or units.',
    input: {
      itemId,
      done: z.number().int().min(0),
      total: z.number().int().min(0),
      project: projectId,
    },
    run: (c, a) =>
      c.progress(
        a.itemId as string,
        a.done as number,
        a.total as number,
        a.project as string | undefined,
      ),
  }),
  tool({
    name: 'raise_finding',
    description:
      "Suggest something you noticed that is outside the scope of your task (a finding). It goes to the suggestions lane of the project's first step for people to add or dismiss; it is not work, never appears in list_work / wait_for_work and cannot be claimed. You do not need to hold the item. Do not do the extra work yourself.",
    input: {
      itemId: itemId.describe(
        'The item where you noticed it (any item of a project this agent may use; holding it is not needed)',
      ),
      title: z.string().min(1).max(300),
      details: z.string().max(20000).describe('What you saw, where, and why it matters'),
      project: projectId,
    },
    run: (c, a) =>
      c.raiseFinding(
        a.itemId as string,
        a.title as string,
        a.details as string,
        a.project as string | undefined,
      ),
  }),
  tool({
    name: 'create_item',
    description:
      'Create a new item (ordinary work) in a project, when a person asked you for real work or a scheduled job found some. It starts at the project\'s first step like a person\'s quick-add, records you as its creator, and can be claimed at once. Only in projects that allow it ("Agents may create items") and that this agent may use; at most 30 an hour per agent. For something you merely noticed, use raise_finding instead.',
    input: {
      project: z.string().min(1).describe('Project id or exact name'),
      title: z.string().min(1).max(300),
      description: z
        .string()
        .max(20000)
        .optional()
        .describe('The brief, in Markdown: what is asked, by whom, and what done looks like'),
      attachments: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe('Files (html, md, txt, png, jpg, pdf up to 900 KB) or http(s) URLs to attach'),
    },
    run: (c, a) =>
      c.createItem(
        a.project as string,
        a.title as string,
        (a.description as string | undefined) ?? '',
        (a.attachments as string[] | undefined) ?? [],
      ),
  }),
  // ---------- Inbox (item 4PEHrOW5IfXBQWgOK9wo) ----------
  tool({
    name: 'inbox_add',
    description:
      "Bring a message someone sent to a person of your organization into their Hivenod Inbox (a Teams or Slack message, a mail, a Jira, GitLab or GitHub mention, …), with its full text. It joins its thread (same source thread, or the thread you name: the same ask on another channel), or starts a new one. A message from them reopens a waiting or closed thread. The same message is never added twice. Set fromMember when it is the person's own reply that you spotted (they answered outside Hivenod). Next: file a new thread with subject_assign (after subject_list), then investigate it (thread_read, inbox_note, inbox_ask) and propose what should come of it (outcome_propose). Nothing is carried out before the person approves.",
    input: {
      source: z
        .string()
        .min(1)
        .max(40)
        .describe(
          'Where it came from, one lowercase word: teams, mail, gitlab, jira, github, telegram, slack, …',
        ),
      sender: z
        .object({
          name: z.string().min(1).max(200).describe("The sender's name"),
          handle: z.string().max(320).optional().describe('Their address or handle in that source'),
        })
        .describe('Who sent it'),
      text: z.string().min(1).max(50000).describe('The full text of the message'),
      threadRef: z
        .string()
        .min(1)
        .max(1000)
        .describe('The thread or conversation it belongs to, in the source (what you reply to)'),
      receivedAt: z.string().min(1).describe('When it was sent, ISO 8601 (2026-10-28T09:00:00Z)'),
      messageId: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("The message's own id in the source; defaults to receivedAt"),
      permalink: z.string().max(2048).optional().describe('An http(s) link to the message'),
      replyRef: z
        .string()
        .max(2000)
        .optional()
        .describe('Whatever you need later to reply in the same place (ids, channel, …)'),
      member: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          'User id of the person it is for; defaults to the person who connected this agent',
        ),
      attachments: z
        .array(z.object({ name: z.string().min(1).max(200), url: z.string().min(1).max(2048) }))
        .max(20)
        .optional()
        .describe('Links to its files'),
      thread: z
        .string()
        .min(1)
        .optional()
        .describe('An existing thread it belongs to (the same ask on another channel)'),
      fromMember: z
        .boolean()
        .optional()
        .describe("The person's own reply (it does not reopen the thread)"),
      title: z
        .string()
        .max(200)
        .optional()
        .describe("A new thread's title; defaults to its first line"),
    },
    run: (c, a) => c.inbox().add(a as never),
  }),
  tool({
    name: 'inbox_list',
    description:
      'What agents have to do in the Inbox of your organization: toWork (threads to investigate), toCarryOut (outcomes their person approved that you carry out: do exactly what the approved fields say, then outcome_done) and toWake (snoozed threads whose date has come: thread_wake).',
    input: {},
    run: (c) => c.inbox().listWork(),
  }),
  tool({
    name: 'thread_read',
    description:
      'Read one Inbox thread in full: its state, the messages (from every channel), the subject, the outcomes proposed and what the person decided, the notes, questions and answers, and what to do next.',
    input: { threadId: z.string().min(1).describe('Thread id') },
    run: (c, a) => c.inbox().readThread(a.threadId as string),
  }),
  tool({
    name: 'subject_list',
    description:
      'A person\'s Inbox subjects: lasting, well-named topics that collect every thread about them, from any source and sender (e.g. "Klarna refunds (M&S Payments)"), with how many threads wait for the person and how many are open. Read them before subject_assign and reuse the one a thread belongs to; make a new one only for a new topic.',
    input: {
      member: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('User id of the person; defaults to the person who connected this agent'),
    },
    run: (c, a) => c.inbox().subjects(a.member as string | undefined),
  }),
  tool({
    name: 'subject_assign',
    description:
      'File a thread under a subject of its person: an existing one (subjectId, from subject_list) or a new one (name: the topic, then the client or area, and who when it helps, e.g. "Grafana access (Pairpoint)"). A name that matches an existing subject reuses it. Give exactly one of the two. Also moves a thread to a better subject.',
    input: {
      threadId: z.string().min(1).describe('Thread id'),
      subjectId: z.string().min(1).optional().describe('An existing subject'),
      name: z.string().min(1).max(120).optional().describe('Or the name of a new subject'),
    },
    run: (c, a) =>
      c
        .inbox()
        .assign(
          a.threadId as string,
          a.subjectId as string | undefined,
          a.name as string | undefined,
        ),
  }),
  tool({
    name: 'subject_search',
    description:
      "Find a person's Inbox subjects by name, people (sender names and handles), channel (teams, mail, …) and words in their threads; every word must match. Best matches first, with what matched, the people, channels and related subjects. Filters: waitingForMe (threads wait for the person), activeDays (a message in the last N days), hasOpen (open threads). Search before subject_assign so a thread joins the subject it belongs to instead of a new twin.",
    input: {
      query: z.string().max(500).optional().describe('Words to find; empty lists every subject'),
      member: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('User id of the person; defaults to the person who connected this agent'),
      waitingForMe: z
        .boolean()
        .optional()
        .describe('Only subjects with threads waiting for the person'),
      activeDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe('Only subjects with a message in the last N days'),
      hasOpen: z.boolean().optional().describe('Only subjects with open threads'),
      limit: z.number().int().min(1).max(100).optional().describe('At most this many (default 20)'),
    },
    run: (c, a) =>
      c.inbox().search((a.query as string | undefined) ?? '', {
        member: a.member as string | undefined,
        waitingForMe: a.waitingForMe as boolean | undefined,
        activeDays: a.activeDays as number | undefined,
        hasOpen: a.hasOpen as boolean | undefined,
        limit: a.limit as number | undefined,
      }),
  }),
  tool({
    name: 'thread_flag',
    description:
      "Mark a thread urgent when it can't wait (production down, a deadline today, the person's own rules say so): the person is pinged at once, whatever their quiet hours. urgent: false takes it back. Use it sparingly.",
    input: {
      threadId: z.string().min(1).describe('Thread id'),
      urgent: z.boolean().optional().describe('true (the default) or false'),
      reason: z.string().max(1000).optional().describe('Why it is urgent, in one line'),
    },
    run: (c, a) =>
      c
        .inbox()
        .flag(
          a.threadId as string,
          (a.urgent as boolean | undefined) ?? true,
          a.reason as string | undefined,
        ),
  }),
  tool({
    name: 'subject_relate',
    description:
      "Propose that two subjects of the same person are related (the same client, project or problem seen from two sides), with an optional note saying how. It is a proposal: the person OKs or turns it down, and a link turned down is not proposed again. Related subjects show on each other's page and in subject_search.",
    input: {
      a: z.string().min(1).describe('A subject id'),
      b: z.string().min(1).describe('The other subject id'),
      note: z.string().max(500).optional().describe('How they relate, in one line'),
    },
    run: (c, a) => c.inbox().relate(a.a as string, a.b as string, a.note as string | undefined),
  }),
  tool({
    name: 'inbox_note',
    description:
      "Add an investigation note to a thread's timeline (what you checked and found: tickets, repos, the calendar, earlier answers). The person sees it with the thread.",
    input: {
      threadId: z.string().min(1).describe('Thread id'),
      text: z.string().min(1).max(8000),
    },
    run: (c, a) => c.inbox().note(a.threadId as string, a.text as string),
  }),
  tool({
    name: 'inbox_ask',
    description:
      'Ask the person a question about a thread when only they can answer it. The thread waits in their Needs you; the answer shows in thread_read and the thread comes back for you to go on.',
    input: {
      threadId: z.string().min(1).describe('Thread id'),
      question: z.string().min(1).max(4000),
    },
    run: (c, a) => c.inbox().ask(a.threadId as string, a.question as string),
  }),
  tool({
    name: 'outcome_propose',
    description: `Propose what should come of a thread. The person approves (maybe after editing the fields), or rejects it; nothing is carried out before their approval. Propose one or more. Replies and nudges are written in the person's own voice, ready to send as they stand. Types and their fields:\n${outcomeGuide()}`,
    input: {
      threadId: z.string().min(1).describe('Thread id'),
      type: z.enum(OUTCOME_TYPES as [string, ...string[]]).describe('The outcome type'),
      fields: z
        .record(z.string(), z.union([z.string(), z.boolean()]))
        .describe("The type's fields"),
      note: z.string().max(2000).optional().describe('Why you propose it, for the person'),
    },
    run: (c, a) =>
      c
        .inbox()
        .propose(
          a.threadId as string,
          a.type as string,
          a.fields as Record<string, unknown>,
          a.note as string | undefined,
        ),
  }),
  tool({
    name: 'outcome_done',
    description:
      'Report an approved outcome you carried out (inbox_list toCarryOut, or thread_read): done, with what you did (result.permalink of the reply you posted, result.itemId of the item you created, result.text), or failed, with result.error. Only for an outcome the person approved and that you carry out.',
    input: {
      outcomeId: z.string().min(1).describe('Outcome id'),
      status: z.enum(['done', 'failed']),
      result: z
        .object({
          text: z.string().max(20000).optional(),
          permalink: z.string().max(2048).optional(),
          itemId: z.string().max(128).optional(),
          error: z.string().max(1000).optional(),
        })
        .optional(),
    },
    run: (c, a) =>
      c
        .inbox()
        .done(
          a.outcomeId as string,
          a.status as 'done' | 'failed',
          (a.result as Record<string, string> | undefined) ?? {},
        ),
  }),
  tool({
    name: 'thread_wake',
    description:
      'Wake a snoozed thread whose date has come (inbox_list toWake): it goes back to investigating.',
    input: { threadId: z.string().min(1).describe('Thread id') },
    run: (c, a) => c.inbox().wake(a.threadId as string),
  }),
  tool({
    name: 'release',
    description:
      'Give an item you hold back to the queue without finishing it (for example after a run that ended without complete). Any agent can then claim it. Ending a run as failed already does this.',
    input: { itemId, project: projectId },
    run: (c, a) => c.release(a.itemId as string, a.project as string | undefined),
  }),
  tool({
    name: 'end_run',
    description:
      'End a run without moving the item (use status failed when you could not finish: the item then goes back to the queue). To finish the work normally call complete instead, which also ends the run. Report what the run cost.',
    input: {
      runId,
      status: z.enum(['done', 'failed']),
      costEur: z.number().min(0).optional().describe('Cost of this run in euro'),
      tokensIn: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('All input tokens, cache reads included'),
      tokensOut: z.number().int().min(0).optional(),
      tokensCached: z.number().int().min(0).optional().describe('Input tokens read from cache'),
      model: z.string().max(80).optional(),
      summary: z.string().max(4000).optional().describe('One or two sentences on what happened'),
    },
    run: (c, a) =>
      c.endRun(a.runId as string, a.status as 'done' | 'failed', {
        costEur: a.costEur as number | undefined,
        tokensIn: a.tokensIn as number | undefined,
        tokensOut: a.tokensOut as number | undefined,
        tokensCached: a.tokensCached as number | undefined,
        model: a.model as string | undefined,
        summary: a.summary as string | undefined,
      }),
  }),
  tool({
    name: 'complete',
    description:
      'Finish your step: the item moves to the next step on its path (skipped steps are passed over) and stops at the next human gate, where only people can approve it. Ends the run as done (with the cost you give) unless end_run already did. Agents can never approve, skip a gate or move an item at a human step.',
    input: {
      itemId,
      runId,
      costEur: z.number().min(0).optional(),
      tokensIn: z.number().int().min(0).optional(),
      tokensOut: z.number().int().min(0).optional(),
      tokensCached: z.number().int().min(0).optional(),
      model: z.string().max(80).optional(),
      summary: z.string().max(4000).optional(),
      project: projectId,
    },
    run: (c, a) =>
      c.complete(
        a.itemId as string,
        a.runId as string,
        {
          costEur: a.costEur as number | undefined,
          tokensIn: a.tokensIn as number | undefined,
          tokensOut: a.tokensOut as number | undefined,
          tokensCached: a.tokensCached as number | undefined,
          model: a.model as string | undefined,
          summary: a.summary as string | undefined,
        },
        a.project as string | undefined,
      ),
  }),
  // ----- agent handover (card KLCTVnX8) -----
  tool({
    name: 'send_back',
    description:
      'Send the item you hold back to an earlier agent step on its path (read_item lists the targets under agentSendBacks.targets), with the reason the agent there needs to redo the work (for example what a test found). Ends your run. Agents never send back to or across a people step. After 3 agent send-backs in a row without a person acting, the item is held for people instead (a question in Needs you with the reasons); their answer hands it back.',
    input: {
      itemId,
      runId,
      toStep: z.string().min(1).describe('The id of the earlier agent step'),
      reason: z.string().min(1).max(2000).describe('What is wrong and what to redo'),
      costEur: z.number().min(0).optional(),
      tokensIn: z.number().int().min(0).optional(),
      tokensOut: z.number().int().min(0).optional(),
      tokensCached: z.number().int().min(0).optional(),
      model: z.string().max(80).optional(),
      summary: z.string().max(4000).optional(),
      project: projectId,
    },
    run: (c, a) =>
      c.sendBack(
        a.itemId as string,
        a.runId as string,
        a.toStep as string,
        a.reason as string,
        {
          costEur: a.costEur as number | undefined,
          tokensIn: a.tokensIn as number | undefined,
          tokensOut: a.tokensOut as number | undefined,
          tokensCached: a.tokensCached as number | undefined,
          model: a.model as string | undefined,
          summary: a.summary as string | undefined,
        },
        a.project as string | undefined,
      ),
  }),
  tool({
    name: 'add_note',
    description:
      'Add a note to the item you are working on, for people and for the agents after you (shown in its History). Use ask instead when you need an answer.',
    input: { itemId, text: z.string().min(1).max(8000), project: projectId },
    run: (c, a) => c.addNote(a.itemId as string, a.text as string, a.project as string | undefined),
  }),
  // ----- per-item paths (card st5INNZj) -----
  tool({
    name: 'shape_item',
    description:
      "Shape a new item you claimed for shaping (list_work job 'shape'): the library steps it should skip, each with a one-line reason, and a one-line note. Skipped agent steps apply at once; a people step you list is asked of its deciders and stays on the path until one approves. Ends the shaping run. Do not do the item's work.",
    input: {
      itemId,
      runId,
      skips: z
        .array(z.object({ stepId: z.string().min(1), reason: z.string().min(1).max(300) }))
        .max(30),
      note: z.string().min(1).max(300),
      project: projectId,
    },
    run: (c, a) =>
      c.shape(
        a.itemId as string,
        a.runId as string,
        {
          skips: Object.fromEntries(
            (a.skips as { stepId: string; reason: string }[]).map((x) => [x.stepId, x.reason]),
          ),
          note: a.note as string,
        },
        {},
        a.project as string | undefined,
      ),
  }),
  tool({
    name: 'skip_step',
    description:
      'On the item you hold: skip an agent step ahead of your current step (skip true, with a reason) or put a skipped one back (skip false). Applies at once, logged, people can undo it. People steps: use ask_path_change.',
    input: {
      itemId,
      stepId: z.string().min(1),
      skip: z.boolean(),
      reason: z.string().max(300).optional(),
      project: projectId,
    },
    run: (c, a) =>
      c.skipStep(
        a.itemId as string,
        a.stepId as string,
        a.skip as boolean,
        (a.reason as string | undefined) ?? '',
        a.project as string | undefined,
      ),
  }),
  tool({
    name: 'ask_path_change',
    description:
      'On the item you hold: ask the deciders of a people step ahead to skip it (or to put a skipped one back), with a reason of 10+ characters. Shows under "Needs you"; any one decider settles it. You cannot ask again after a decider refused.',
    input: {
      itemId,
      stepId: z.string().min(1),
      reason: z.string().min(10).max(1000),
      project: projectId,
    },
    run: (c, a) =>
      c.askPathChange(
        a.itemId as string,
        a.stepId as string,
        a.reason as string,
        a.project as string | undefined,
      ),
  }),
  tool({
    name: 'propose_step',
    description:
      "On the item you hold: propose a new step for the project's library when no step fits work the item needs. An approver (admins and the project's creator) adds it or rejects it with a reason.",
    input: {
      itemId,
      name: z.string().min(1).max(60),
      kind: z.enum(['agent', 'human']),
      description: z.string().max(2000),
      instructions: z.string().max(20000).optional(),
      outputs: z.array(z.string().max(200)).max(20).optional(),
      afterStepId: z.string().describe("The library step it goes after ('' = first)"),
      reason: z.string().min(10).max(1000),
      project: projectId,
    },
    run: (c, a) => {
      const { itemId: id, project, ...proposal } = a as Record<string, unknown>;
      return c.proposeStep(id as string, proposal as never, project as string | undefined);
    },
  }),
  // ----- calendar (Inbox item w9SAf) -----
  tool({
    name: 'calendar_upsert',
    description:
      "Add or update events in a member's calendar in this organization, from a calendar you sync (for example their Google or Outlook calendar here). The same source + sourceEventId updates the same event, so send the whole window again on every sync. Members of this organization see the details; the member's other organizations only see the time as busy. busyOnly: you only know the time (no title or attendees are kept). At most 100 events per call.",
    input: {
      member: z
        .string()
        .optional()
        .describe(
          "Whose calendar: the member's uid, email or name (may be left out when the organization has one member)",
        ),
      events: z
        .array(
          z.object({
            source: z.string().min(1).max(40).describe('Where it comes from: google, outlook, …'),
            sourceEventId: z.string().min(1).max(600).describe("The event's id in that calendar"),
            title: z.string().max(300).optional(),
            start: z.string().describe('RFC 3339 time with a zone, e.g. 2026-11-02T09:00:00Z'),
            end: z.string().describe('RFC 3339 time with a zone, after start'),
            allDay: z.boolean().optional(),
            attendees: z.array(z.string().max(320)).max(50).optional(),
            busyOnly: z.boolean().optional().describe('Only the time is known or may be shared'),
          }),
        )
        .min(1)
        .max(100),
    },
    run: (c, a) =>
      upsertEvents(
        c.calendarDeps(),
        a.member as string | undefined,
        a.events as CalendarEventArg[],
      ),
  }),
  tool({
    name: 'calendar_delete',
    description:
      "Remove events from a member's calendar in this organization (cancelled or deleted at the source), by the ids calendar_upsert returned, or by source and the source's event ids. Their busy time is freed everywhere.",
    input: {
      ids: z
        .array(z.string().min(1))
        .max(100)
        .optional()
        .describe('Event ids from calendar_upsert'),
      member: z
        .string()
        .optional()
        .describe('With sourceEventIds: whose calendar (uid, email or name)'),
      source: z.string().max(40).optional().describe('With sourceEventIds: google, outlook, …'),
      sourceEventIds: z.array(z.string().min(1).max(600)).max(100).optional(),
    },
    run: (c, a) =>
      deleteEvents(c.calendarDeps(), {
        ids: a.ids as string[] | undefined,
        member: a.member as string | undefined,
        source: a.source as string | undefined,
        sourceEventIds: a.sourceEventIds as string[] | undefined,
      }),
  }),
  tool({
    name: 'calendar_free',
    description:
      "A member's free time between from and to, across every organization they are in (busy time only, never details), as free slots of at least minMinutes. Use it to propose meeting times in a draft. Range: at most 62 days.",
    input: {
      member: z
        .string()
        .optional()
        .describe(
          "The member's uid, email or name (may be left out when the organization has one member)",
        ),
      from: z.string().describe('RFC 3339 time with a zone'),
      to: z.string().describe('RFC 3339 time with a zone, after from'),
      minMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe('Shortest slot; default 30'),
    },
    run: (c, a) =>
      freeTime(c.calendarDeps(), {
        member: a.member as string | undefined,
        from: a.from as string,
        to: a.to as string,
        minMinutes: a.minMinutes as number | undefined,
      }),
  }),
  tool({
    name: 'report_usage',
    description:
      "Report the run's token usage so far (running totals for the whole run; they only grow) and the model. Usage is tracked and shown in Hivenod; it never stops a run.",
    input: {
      runId,
      tokensIn: z.number().int().min(0).describe('All input tokens so far, cache reads included'),
      tokensOut: z.number().int().min(0),
      tokensCached: z.number().int().min(0).optional().describe('Input tokens read from cache'),
      model: z.string().max(80).optional(),
    },
    run: (c, a) =>
      c.reportUsage(a.runId as string, {
        tokensIn: a.tokensIn as number,
        tokensOut: a.tokensOut as number,
        tokensCached: a.tokensCached as number | undefined,
        model: a.model as string | undefined,
      }),
  }),
];
