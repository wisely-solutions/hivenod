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
   outcome. If the change can't be made (the asked time is taken), say why with `inbox_ask` on
   the thread.
   **Plans.** When the answer has more than one action, or needs the person's OK on the way,
   the sub-agent proposes a plan in one call (`plan_propose`): ordered steps (reply, book,
   make_it_work as "Build it", handover, snooze as "wait until", nudge, approval). Put an
   `approval` step before anything that changes money, prices, contracts or public content.
   Steps run in order: a `carry_out` comes once per step (with `plan_id` and `step`, "3 of 5"),
   only when that step is approved and its turn; carry out exactly that step and report it with
   `outcome_done`. For a Build it step, create the item, report `status: started` with its
   `itemId`; the channel sends `item_done` when the item is Done (report the step done) or
   `item_stopped` when it was stopped or deleted (report it failed with the reason). A `rejected` event with `plan_id` means
   the plan stopped: re-plan or ask.
6. **Keep the main context small.** Sub-agents report in one line and report their own run cost
   with complete, send_back or end_run. Keep a short table item_id -> sub-agent in your head or
   notes, nothing more.

If the project's own CLAUDE.md gives different rules for sub-agents, those win.
