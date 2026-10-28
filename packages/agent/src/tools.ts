/**
 * The agent operations as MCP tools (SPEC section 10). Input schemas are Zod; the MCP SDK turns
 * them into the JSON Schemas Claude Code shows. Descriptions are written for the model using them.
 */
import { z } from 'zod';
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
