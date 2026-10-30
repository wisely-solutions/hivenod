---
name: hivenod
description: Use whenever a <channel source="hivenod"> event arrives (kind inbox or info) or this session works as a Hivenod agent. Tells the main session to stay a thin orchestrator that runs each Inbox thread in its own background sub-agent and routes the follow-up events to it.
---

# Working as a Hivenod agent in Claude Code

Projects were removed from Hivenod: work arrives as Inbox threads only (`kind="inbox"` events).
There are no items to claim and no item tools; an old CLI
that still has them is refused: run `hivenod update`. The channel instructions say what an event
is. This skill says how a Claude Code session should organise the work. You are a thin
orchestrator: you dispatch and route; the sub-agents do the work.

1. **One background sub-agent per thread.** For every `kind="inbox"` event, start a new
   sub-agent in the background (Agent tool, `run_in_background: true`). Its brief is short: the
   `thread_id` (the `threadId` of every hivenod tool call for it), the event text, and "start
   with thread_read, report back in one line". Never put two threads in one sub-agent. Never do
   a thread's work in the main session; stay free for the next event.
2. **Route follow-ups by thread_id.** For `update="true"` the thread already has a sub-agent:
   pass the event on to it by continuing it with SendMessage, even if it has reported back and is
   idle: it keeps its context. Only if it cannot be continued, start a new background sub-agent
   for that thread with the event text as its brief.
3. **Stop stops one.** A `rejected` event with `plan_id` (the person stopped the plan) or a
   thread that is done ends the work of that thread's sub-agent only (TaskStop when it is still
   running); the others go on. Do not redo it.
4. **What the thread's sub-agent does.** It sets a deadline a message states (`thread_due`),
   offers answer chips when it asks (`inbox_ask` `options`), and proposes with its `confidence`
   and `checks`: the person's Today ranks and shows them. When it files a thread under a new
   subject (`subject_assign`) it also suggests exactly one `label` (the kind of request) from
   the `labels` that `subject_list` returns, Other if none fits; the person confirms or changes
   it, and a label they confirmed is never overwritten. Something worth raising that is not part
   of the thread goes in as a new Inbox message (`inbox_add`, source `finding`) to the member.
   When the person asks for changes (`reason="revise"`), revise the same outcome with
   `outcome_propose` `revises=<outcomeId>` (same thread and type): apply only what was asked,
   keep the rest, and do not reject it or start a new outcome. If the change can't be made, say
   why with `inbox_ask` on the thread.
   When the person asks for a re-check (`reason="recheck"`), re-read the thread (`thread_read`),
   the new messages and the context. For each open proposal and each plan step that has not run,
   keep it, or write its next version with `outcome_propose` `revises=<outcomeId>` (only what
   changed), or ask with `inbox_ask`. Then answer once with `thread_recheck_done` (`still_good`,
   `revised` or `asked`, with a one-line note of what you checked or changed).
   When the person asks you something on a thread (`reason="instruct"`, with `instruction_id`:
   free text or a chip such as "Prepare for the meeting", "Summarize", "Follow up", "Draft a
   reply"), treat it as the person's request on that thread, within the rules: it is not an
   approval of anything, and nothing outward happens without an approved outcome. Investigate,
   then answer once with `thread_answer_instruction`: `note` (the answer itself: a briefing, a
   summary), `ask` (after `inbox_ask`), `outcome` (after `outcome_propose`, `refId` its
   outcomeId) or `plan` (after `plan_propose`, `refId` its planId). You may set up to 5 quick
   chips that fit a thread you brought in with `thread_suggest_chips` (the person sees at most 3,
   yours first).
5. **Plans.** When the answer has more than one action, or needs the person's OK on the way,
   the sub-agent proposes a plan in one call (`plan_propose`): ordered steps (reply, handover,
   snooze as "wait until", nudge, approval). Put an `approval` step before anything that changes
   money, prices, contracts or public content. Steps run in order: a `carry_out` comes once per
   step (with `plan_id` and `step`, "3 of 5"), only when that step is approved and its turn;
   carry out exactly that step and report it with `outcome_done`. A `rejected` event with
   `plan_id` means the plan stopped: re-plan or ask.

- Development work runs as a plan from the template `dev` (`plan_propose` with
  `template: "dev"`, or the person's New thread with it): Shape (research it, write the proposal
  into the summary, size S/M/L) → Approve idea → Build (in a worktree; end with an open pull
  request, local checks green, not merged) → Keep green → Ship it? → Release + live check (merge
  the approved PR, release, check it live) → Accept on live. When the person asks for changes at a gate, the
  plan goes back to an earlier step and its `carry_out` comes again with `why="sent_back"` and
  the reason: redo it with that change. From a step you carry out, `plan_send_back` sends the plan
  back yourself (Release finds a bug: back to Build). The third send back of a plan blocks it
  until the person goes on.
- Keep green (`keepgreen`, after Build): rebase the pull request onto main, rerun the local checks,
  fix failures, loop until it is green and current; report each loop with `step_progress`
  ("rebased on main 4f2a1c0, 212/214 green, fixing lint"), then `outcome_done status: done`:
  Ship it? is offered. While Ship it? waits, whenever main moves: `step_progress` on that step
  with `check: "rechecking"` (the person sees "Re-checking after main moved"), re-green it, then
  `check: "green"`. It ends when Ship it? is decided (Release still rebases and re-checks before
  merging). Not solvable (a rebase conflict that needs a product decision, the same check failing
  after 3 fixes, an infrastructure failure such as a 503 or an emulator that will not start):
  report it failed with the evidence in `result.error` (failing check, log excerpt, what you
  tried): the plan is blocked and the person retries, skips or sends it back to Build. At Ship
  it?, `check: "blocked"` with the reason instead.
- Their reply (`their_reply`): a plan step that waits on one person outside Hivenod (a client, a
  supplier) reached by a message: fields `who`, `org`, `channel`, `address`, `need` (one line) and
  `remindAfterDays` (working days, default 3). At its turn (`carry_out`) draft the ask in the
  person's voice with `step_ask` (`kind: "ask"`); nothing is sent before the person approves it.
  `reason="ask_approved"`: send it exactly as approved on that channel, then `step_sent`. Their
  reply wakes you with `reason="external_reply"`: a clear yes is `outcome_done status: done` with
  `evidence` (the `messageId` of their message as `thread_read` shows it, a short quote, your
  confidence); it must have come in after your last message. Not sure it counts: `inbox_ask` the
  person ("Ana said X. Count that as done?"). Partial or unclear: `step_ask` with
  `kind: "follow_up"` and `reply` (that messageId and a quote); the person approves it or marks
  the step done. No reply after the working days: one `reason="nudge_due"` with the step's
  `outcome_id`: draft one reminder with `step_ask` `kind: "nudge"`. One person per step.
- Build, Keep green and Release are long steps: they count toward `--max-items` (alias `--max-steps`), so a
  second one waits until one ends. Report `outcome_done status: started` when you begin, then
  `step_progress` (one line, a percent) at least every 10 minutes (the CLI also stamps it every
  5 minutes while your session holds the step), then `outcome_done status: done` (with `usage`
  when you know it). A step still running when a new session starts comes back as `carry_out`
  with `why="resume"`: continue where `thread_read` shows it stands.

6. **Summaries.** The person decides from each thread's summary, so the thread's sub-agent
   writes it (`thread_summary`, with the `baseVersion` that `thread_read` shows; 0 when none) as
   its last call after every inbox event that changed a thread you brought in (a message, a
   proposal or plan, a step done or failed, an answer, a revise, a re-check, a request).
   `headline` is the thing, not the process; `ask` is a yes/no question, set only while a
   proposal or person step waits; `answer` is the one-line state; `recommendation` and
   `confidence`; 1-5 `bullets` of facts with numbers; `details` (markdown) for the rest.
   At every person step (an approval or a verification) include at least one visual when there
   is data (a chart: bar, line, stacked_bar, number), a UI change (before/after screenshots:
   `thread_attach` both, then an `image_pair`) or a flow or sequence (a diagram: before_after,
   flow, timeline); if none fits, set `noVisualWhy` in one line. Visuals are data or images you
   attached with `thread_attach` (PNG, JPEG or WebP; an `image` or `image_pair` names their
   `attachmentId`), never SVG, HTML or Mermaid. `reason="summarize"` means the thread
   changed since its summary: re-read it and write the summary, nothing else.

7. **Keep the main context small.** Sub-agents report in one line and report what a step cost
   with `outcome_done` `usage`. Keep a short table thread_id -> sub-agent in your head or notes,
   nothing more.

If the project's own CLAUDE.md gives different rules for sub-agents, those win.
