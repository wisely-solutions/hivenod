---
name: hivenod
description: Use whenever a <channel source="hivenod"> event arrives (kind work, note, answer, stop, status or inbox) or this session works as a Hivenod agent. Tells the main session to stay a thin orchestrator that runs each item or inbox thread in its own background sub-agent and routes the follow-up events to it.
---

# Working as a Hivenod agent in Claude Code

The channel instructions say what an event is and which `itemId` goes into the tools. This skill
says how a Claude Code session should organise the work. You are a thin orchestrator: you
dispatch, route and give back; the sub-agents do the work.

1. **One background sub-agent per item.** For every `kind="work"` event, start a new sub-agent
   in the background (Agent tool, `run_in_background: true`). Its brief is short: the `item_id`,
   the event text, and "pass itemId=\"<item_id>\" to every hivenod tool call; start with
   read_item, follow the step, log progress, finish with complete (or send_back, ask or
   release), report back in one line". Never put two items in one sub-agent. Never do an item's
   work in the main session; stay free for the next event.
2. **Route follow-ups by item_id.** `note`, `answer` and `status` events name an item: pass the
   text on to that item's sub-agent by continuing it with SendMessage, even if it has reported
   back and is idle: it keeps its context. Only if it cannot be continued, start a new background
   sub-agent for that item with the event text as its brief. Never do the item's work (complete,
   add_note and the like) in the main session.
3. **Stop stops one.** A `stop` event ends the sub-agent of that item only (TaskStop). Do not
   redo the item; the others go on.
4. **Give back idle items.** An item you hold but no sub-agent is actively working (it waits on a
   release, a review or a person) takes a slot: `release` it, or park it with the reason, so the
   channel hands over the next one.
5. **Inbox threads.** Each `kind="inbox"` event gets its own sub-agent too (brief: the thread id,
   the event text, "start with thread_read"). For `update="true"` the thread already has one:
   pass the event on to it. Inbox work never holds up an item. The thread's sub-agent sets a
   deadline a message states (`thread_due`), offers answer chips when it asks (`inbox_ask`
   `options`), and proposes with its `confidence` and `checks`: the person's Today ranks and
   shows them. When it files a thread under a new subject (`subject_assign`) it also suggests
   exactly one `label` (the kind of request) from the `labels` that `subject_list` returns,
   Other if none fits; the person confirms or changes it, and a label they confirmed is never
   overwritten.
   When the person asks for changes (`reason="revise"`), route it to the thread's sub-agent (or
   start one). Revise the same outcome with `outcome_propose` `revises=<outcomeId>` (same thread
   and type): apply only what was asked, keep the rest, and do not reject it or start a new
   outcome. If the change can't be made, say why with `inbox_ask` on
   the thread.
   When the person asks for a re-check (`reason="recheck"`), route it to the thread's sub-agent
   (or start one): re-read the thread (`thread_read`), the new messages and the context. For each open proposal and each plan step that has not run, keep it, or write its
   next version with `outcome_propose` `revises=<outcomeId>` (only what changed), or ask with
   `inbox_ask`. Then answer once with `thread_recheck_done` (`still_good`, `revised` or `asked`,
   with a one-line note of what you checked or changed).
   When the person asks you something on a thread (`reason="instruct"`, with `instruction_id`:
   free text or a chip such as "Prepare for the meeting", "Summarize", "Follow up", "Draft a
   reply"), route it to the thread's sub-agent (or start one). Treat it as the person's request
   on that thread, within the rules: it is not an approval of anything, and nothing outward
   happens without an approved outcome. Investigate, then answer once with
   `thread_answer_instruction`: `note` (the answer itself: a briefing, a summary), `ask` (after
   `inbox_ask`), `outcome` (after `outcome_propose`, `refId` its outcomeId) or `plan` (after
   `plan_propose`, `refId` its planId). You may set up to 5 quick chips that fit a thread you
   brought in with `thread_suggest_chips` (the person sees at most 3, yours first).
   **Plans.** When the answer has more than one action, or needs the person's OK on the way,
   the sub-agent proposes a plan in one call (`plan_propose`): ordered steps (reply,
   make_it_work as "Build it", handover, snooze as "wait until", nudge, approval). Put an
   `approval` step before anything that changes money, prices, contracts or public content.
   Steps run in order: a `carry_out` comes once per step (with `plan_id` and `step`, "3 of 5"),
   only when that step is approved and its turn; carry out exactly that step and report it with
   `outcome_done`. For a Build it step, create the item, report `status: started` with its
   `itemId`; the channel sends `item_done` when the item is Done (report the step done) or
   `item_stopped` when it was stopped or deleted (report it failed with the reason). A `rejected` event with `plan_id` means
   the plan stopped: re-plan or ask.

- Development work runs as a plan from the template `dev` (`plan_propose` with
  `template: "dev"`, or the person's New thread with it): Shape (research it, write the proposal
  into the summary, size S/M/L) → Approve idea → Build (in a worktree; end with an open pull
  request, local checks green, not merged) → Ship it? → Release + live check (merge the approved
  PR, release, check it live) → Accept on live. When the person asks for changes at a gate, the
  plan goes back to an earlier step and its `carry_out` comes again with `why="sent_back"` and
  the reason: redo it with that change. From a step you carry out, `plan_send_back` sends the plan
  back yourself (Release finds a bug: back to Build). The third send back of a plan blocks it
  until the person goes on.
  **Summaries.** The person decides from each thread's summary, so the thread's sub-agent
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

6. **Keep the main context small.** Sub-agents report in one line and report their own run cost
   with complete, send_back or end_run. Keep a short table item_id -> sub-agent in your head or
   notes, nothing more.

If the project's own CLAUDE.md gives different rules for sub-agents, those win.
