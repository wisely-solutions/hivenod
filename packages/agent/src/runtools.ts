/**
 * The MCP tools a coding CLI gets during one `hivenod run` item (card MkUwvyWs): bound to that item
 * and run, with no way to claim, complete, end runs or decide anything. `hivenod run` (the wrapper)
 * owns the claim, heartbeats, usage tracking and the outcome; the model reports its outcome with
 * `finish`. The tools run inside the wrapper (with its client and token); the CLI's MCP server
 * only forwards calls to them over the run bridge (see bridge.ts).
 */
import { resolve } from 'node:path';
import { z } from 'zod';
import { isUrl } from './attach';
import type { HiveClient } from './client';
import { HiveError } from './errors';
import { assertNotProtected } from './safepath';
import type { ToolDef } from './tools';

export interface RunScope {
  runId: string;
  itemId: string;
  projectId: string;
  /** The CLI's working folder: relative attachment paths are read from there. */
  cwd: string;
  /** Hivenod's own folders for this run (the bridge folder): never attachable, like ~/.hivenod. */
  deny?: string[];
  /** Called once with the outcome when the model calls `finish` (or `shape_item`). */
  onFinish: (f: Finish) => void;
  /** 'shape': a shaping run (card st5INNZj): the model picks the item's path, nothing else. */
  job?: 'shape' | null;
}

/**
 * A file to attach, resolved against the CLI's folder. Hivenod's credentials folder (and `deny`) are
 * off limits, also through symlinks; prepareAttachment checks the opened file again.
 */
export function attachSource(source: string, cwd: string, deny: readonly string[] = []): string {
  if (isUrl(source)) return source;
  const abs = resolve(cwd, source);
  assertNotProtected(abs, deny);
  return abs;
}

export const FINISH_OUTCOMES = ['done', 'failed', 'needs_answer'] as const;
export type FinishOutcome = (typeof FINISH_OUTCOMES)[number];

export interface Finish {
  outcome: FinishOutcome;
  summary: string;
  /** The question asked in this run, for needs_answer. */
  questionId: string | null;
  question: string | null;
  /** A shaping run's choice: the steps to skip (with why) and a one-line note. */
  shape?: { skips: Record<string, string>; note: string };
}

const stepId = z.string().min(1).describe("A step id from read_item's path");
const proposalInput = {
  name: z.string().min(1).max(60),
  kind: z.enum(['agent', 'human']).describe('agent: work an agent does; human: a people decision'),
  description: z.string().max(2000),
  instructions: z.string().max(20000).optional(),
  outputs: z.array(z.string().max(200)).max(20).optional(),
  afterStepId: z
    .string()
    .describe("The library step it goes after ('' = first), from read_item's path"),
  reason: z.string().min(10).max(1000).describe('Why the library needs it'),
};

/** The path tools both kinds of run share. */
function pathTools(scope: RunScope, open: () => void): ToolDef[] {
  return [
    tool({
      name: 'propose_step',
      description:
        "Propose a new step for the project's step library when no existing step fits work this item really needs (for example a legal check). An approver adds it or rejects it with a reason; carry on without it meanwhile.",
      input: proposalInput,
      run: (c, a) => {
        open();
        return c.proposeStep(scope.itemId, a as never, scope.projectId);
      },
    }),
  ];
}

const tool = <S extends z.ZodRawShape>(def: ToolDef<S>) => def as unknown as ToolDef;

export function runTools(scope: RunScope): ToolDef[] {
  let lastQuestionId: string | null = null;
  let lastQuestion: string | null = null;
  let finished = false;
  const open = () => {
    if (finished)
      throw new HiveError('You already called finish. Stop now; Hivenod takes it from here.');
  };
  if (scope.job === 'shape') return shapingTools(scope, open, () => (finished = true));
  return [
    tool({
      name: 'read_item',
      description:
        'Read the item you are working on: step instructions and expected outputs, summary, attachments (text in full), messages and answers, and the reasons people sent it back. Already in your prompt; call it again to see new answers.',
      input: {},
      run: (c) => c.readItem(scope.itemId, scope.projectId),
    }),
    tool({
      name: 'log',
      description:
        'Append a short line to this run’s log so people can follow what you are doing (what you did, what you found). At most 500 lines per run.',
      input: {
        text: z.string().min(1).max(4000),
        level: z.enum(['info', 'warn', 'error']).optional(),
      },
      run: (c, a) => {
        open();
        return c.log(
          scope.runId,
          a.text as string,
          a.level as 'info' | 'warn' | 'error' | undefined,
        );
      },
    }),
    tool({
      name: 'progress',
      description: 'Report progress on this item as done out of total parts.',
      input: { done: z.number().int().min(0), total: z.number().int().min(0) },
      run: (c, a) => {
        open();
        return c.progress(scope.itemId, a.done as number, a.total as number, scope.projectId);
      },
    }),
    tool({
      name: 'attach',
      description:
        'Attach a deliverable to this item: a file path (html, md, txt, png, jpg, pdf; up to 900 KB) or an http(s) URL. Prefer one self-contained HTML file for reports.',
      input: {
        source: z.string().min(1).describe('File path or URL'),
        name: z.string().max(200).optional(),
      },
      run: (c, a) => {
        open();
        return c.attach(scope.itemId, attachSource(a.source as string, scope.cwd, scope.deny), {
          name: a.name as string | undefined,
          projectId: scope.projectId,
          ...(scope.deny?.length ? { deny: scope.deny } : {}),
        });
      },
    }),
    tool({
      name: 'ask',
      description:
        'Ask people a question about this item when you cannot go on without their answer. It shows under "Needs you" in Hivenod. Then call finish with outcome needs_answer: the item is given back and picked up again (with the answer) once people reply.',
      input: { question: z.string().min(1).max(8000) },
      run: async (c, a) => {
        open();
        const r = await c.ask(scope.itemId, a.question as string, scope.projectId);
        lastQuestionId = r.messageId;
        lastQuestion = a.question as string;
        return {
          ...r,
          next: 'Now call finish with outcome needs_answer and a one-line summary of what is done so far.',
        };
      },
    }),
    tool({
      name: 'raise_finding',
      description:
        'Suggest something you noticed that is outside this item (a finding). People add it as new work or dismiss it. Do not do that extra work yourself.',
      input: { title: z.string().min(1).max(300), details: z.string().max(20000) },
      run: (c, a) => {
        open();
        return c.raiseFinding(
          scope.itemId,
          a.title as string,
          a.details as string,
          scope.projectId,
        );
      },
    }),
    ...pathTools(scope, open),
    tool({
      name: 'skip_step',
      description:
        "Skip an agent step ahead of your current step on this item's path when it clearly adds nothing for this item (skip true, with a short reason), or put a skipped agent step back (skip false). It applies at once, is logged on the item and people can undo it. People steps cannot be skipped this way: use ask_path_change.",
      input: {
        stepId,
        skip: z.boolean(),
        reason: z.string().max(300).optional(),
      },
      run: (c, a) => {
        open();
        return c.skipStep(
          scope.itemId,
          a.stepId as string,
          a.skip as boolean,
          (a.reason as string | undefined) ?? '',
          scope.projectId,
        );
      },
    }),
    tool({
      name: 'ask_path_change',
      description:
        'Ask the deciders of a people step ahead to skip it for this item (or to put a skipped one back), with your reason (10+ characters). It shows under "Needs you"; any one decider settles it. Keep working meanwhile. If a decider already said no for that step on this item, you cannot ask again.',
      input: { stepId, reason: z.string().min(10).max(1000) },
      run: (c, a) => {
        open();
        return c.askPathChange(
          scope.itemId,
          a.stepId as string,
          a.reason as string,
          scope.projectId,
        );
      },
    }),
    tool({
      name: 'finish',
      description:
        'Say how this item ended; call it exactly once, as your last action. outcome done: the step is finished (Hivenod moves the item on; at a human gate people decide). failed: you could not do it (say why). needs_answer: you asked a question with ask and cannot go on without the answer.',
      input: {
        outcome: z.enum(FINISH_OUTCOMES),
        summary: z.string().min(1).max(4000).describe('One or two sentences on what you did'),
      },
      run: async (_c: HiveClient, a) => {
        open();
        const outcome = a.outcome as FinishOutcome;
        if (outcome === 'needs_answer' && !lastQuestionId)
          throw new HiveError(
            'Ask your question with the ask tool first, then call finish with needs_answer.',
          );
        const f: Finish = {
          outcome,
          summary: a.summary as string,
          questionId: lastQuestionId,
          question: lastQuestion,
        };
        finished = true;
        scope.onFinish(f);
        return { ok: true, note: 'Recorded. Stop now: Hivenod ends the run and moves the item.' };
      },
    }),
  ];
}

/**
 * The tools of a shaping run: read the item and the library, propose a missing step, and
 * `shape_item` once with the steps to skip. Nothing else (no work on the item itself).
 */
function shapingTools(scope: RunScope, open: () => void, done: () => void): ToolDef[] {
  return [
    tool({
      name: 'read_item',
      description:
        "Read the item and the project's step library (path: every step with its id, kind and description). Already in your prompt.",
      input: {},
      run: (c) => c.readItem(scope.itemId, scope.projectId),
    }),
    tool({
      name: 'log',
      description: 'Append a short line to this run’s log (what you decided and why).',
      input: { text: z.string().min(1).max(4000) },
      run: (c, a) => {
        open();
        return c.log(scope.runId, a.text as string);
      },
    }),
    ...pathTools(scope, open),
    tool({
      name: 'shape_item',
      description:
        "Set this item's path, as your last action: the library steps it should skip, each with a one-line reason, and a one-line note on the whole path. Skipped agent steps apply at once. A people step you list is not skipped: its deciders are asked (it stays on the path until one approves). Skip nothing if the item needs the full process.",
      input: {
        skips: z
          .array(z.object({ stepId, reason: z.string().min(1).max(300) }))
          .max(30)
          .describe('Steps this item does not need'),
        note: z
          .string()
          .min(1)
          .max(300)
          .describe('One line on the path, e.g. "copy change: no research, spec or release"'),
      },
      run: async (c, a) => {
        open();
        const list = a.skips as { stepId: string; reason: string }[];
        const brief = await c.readItem(scope.itemId, scope.projectId);
        const known = new Set(brief.path.map((p) => p.id));
        const unknown = list.filter((x) => !known.has(x.stepId)).map((x) => x.stepId);
        if (unknown.length)
          throw new HiveError(
            `Unknown step id(s): ${unknown.join(', ')}. Use the ids in read_item's path.`,
          );
        if (list.length >= known.size)
          throw new HiveError('The path needs at least one step: do not skip them all.');
        done();
        scope.onFinish({
          outcome: 'done',
          summary: a.note as string,
          questionId: null,
          question: null,
          shape: {
            skips: Object.fromEntries(list.map((x) => [x.stepId, x.reason])),
            note: a.note as string,
          },
        });
        return { ok: true, note: 'Recorded. Stop now: Hivenod sets the path and ends the run.' };
      },
    }),
    tool({
      name: 'finish',
      description:
        'Only if you cannot shape this item: call finish with outcome failed and say why (the item goes back for another agent or a person). To shape it, use shape_item instead.',
      input: { outcome: z.enum(['failed']), summary: z.string().min(1).max(4000) },
      run: async (_c: HiveClient, a) => {
        open();
        done();
        scope.onFinish({
          outcome: 'failed',
          summary: a.summary as string,
          questionId: null,
          question: null,
        });
        return { ok: true, note: 'Recorded. Stop now.' };
      },
    }),
  ];
}
