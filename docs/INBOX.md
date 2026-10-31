# Inbox

Item 4PEHrOW5IfXBQWgOK9wo, slice (a). Inbox holds what people send a member: Teams messages,
mail, Jira or GitLab mentions, Telegram and so on. The organization's agents bring these in,
investigate them and propose what should come of each one. **Nothing is carried out before the
member approves it.** Hivenod itself connects to no external inbox. Code lives in
`packages/shared/src/inbox.ts` and `packages/shared/src/outcomes.ts`.

## Three levels

- **Subject:** a lasting, well-named topic, reused over time. It belongs to the member, who can
  rename, merge or split it. A subject has no open or closed state.
- **Thread:** one conversation inside a subject, with its own state and outcomes. A subject
  holds many threads, and threads can move between subjects.
- **Message:** each input on a thread, from any channel, or the member's own reply when an agent
  spots it (`direction: out`). Messages are immutable.

## Records

All of these live under `workspaces/{wid}`. Projects, items and runs no longer exist (slice 11 of
item OE8FmrTaIxFVGcaeGG3N): the Inbox is where work arrives, including development work.

```
inboxSubjects/{sid}   memberUid, name, area? (string|null, at most 60), label? (string|null, at most
                      30), labelSuggested? (bool: still the agent's guess), labelBy? (agent|member),
                      createdBy{type,id}, createdAt, updatedAt, lastEventId
inboxConfig/labels    labels[] (1 to 12, each 1 to 30 characters, unique ignoring case), updatedBy,
                      updatedAt. Written by admins only; absent: the defaults
inboxThreads/{tid}    memberUid, subjectId|null, state, waiting{on, until|null}|null,
                      question{text, by, at, answer|null, answeredAt|null, options?[]}|null, title,
                      refs[], lastMessageAt, fetchedBy (the home agent), urgent? (bool, thread_flag),
                      due? (timestamp|null, thread_due), createdAt, updatedAt, lastEventId
inboxMessages/{mid}   memberUid, threadId, direction in|out, source, sender{name, handle}, text,
                      threadRef, messageId, permalink, replyRef, receivedAt, attachments[{name,url}],
                      fetchedBy, createdAt, lastEventId
inboxOutcomes/{oid}   memberUid, threadId, type, fields{}, state, note, confidence? (high|medium|low),
                      checks?[] (at most 6), proposedBy, executor|null,
                      decision{byUid, at, edited, reason}|null,
                      result{text, permalink, error, by, at}|null (older records may also hold itemId), planId? (absent: a single
                      outcome), createdAt, updatedAt, lastEventId
inboxPlans/{pid}      memberUid, threadId, proposedBy, steps[] (outcome ids in order, 1 to 8), cursor
                      (the step whose turn it is; steps.length once through), state
                      proposed|active|blocked|done|stopped, note, confidence?, createdAt, updatedAt,
                      lastEventId
inboxEvents/{eid}     actor{type,id,name}, memberUid, threadId|null, subjectId|null, type, data{}, at
                      (create-only; the timeline)
inboxRelations/{rid}  memberUid, a, b (a < b), note, state, proposedBy{type,id},
                      decision{byUid, at}|null, createdAt, updatedAt, lastEventId
```

### Thread states

| State           | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `investigating` | An agent is digging in. Its notes go on the timeline.                |
| `needsYou`      | The agent asked the member a question.                               |
| `yourCall`      | Outcomes are proposed and wait for the member.                       |
| `waiting`       | Waiting on them, on a third party, on running work, or until a date. |
| `done`          | Finished.                                                            |
| `ignored`       | The member chose to ignore it.                                       |

A new message from them reopens a `waiting`, `done` or `ignored` thread. The thread goes back to
`investigating`. A member's own reply doesn't reopen it.

### Dedup

Ids are a prefix plus the first 24 hex digits of a SHA-256 hash:

- **Message id:** `im` + SHA-256 of `member \0 source \0 threadRef \0 messageId`. The same
  message twice is refused, because the rules only allow a create.
- **Ref:** SHA-256 of `member \0 source \0 threadRef`. A thread lists the refs of the source
  threads it gathers.
- **Thread id:** the first thread made for a ref is `it<ref>`.

A message joins its thread in this order: the thread the agent names (the same ask on another
channel), else `it<ref>`, else a thread whose `refs` contains the ref. If none matches, the
message starts a new thread. `messageId` defaults to the `receivedAt` milliseconds.

### Outcomes

`OUTCOMES` in `packages/shared/src/outcomes.ts` is the one registry. The web app, the agent tools
and the rules all use it:

- The rules block between `BEGIN outcome registry` and `END` is generated from it.
- The Go CLI's `cli/internal/actions/outcomes.json` is generated from it.
- `scripts/inbox-outcomes.test.mjs` keeps both copies equal.
- `outcome_propose` lists the types and fields from it.

To add a type, add one entry, then run `UPDATE_GO_CONTRACT=1 pnpm test:scripts`.

A type with `batchable: true` (`no_reply`, `ignore`, `snooze`) is a **tidy-up** type: it takes
effect on approval and sends nothing. The web app gathers a proposal into the Today page's
tidy-ups card, which the member approves in one batch, only when all of these hold: its type is
batchable, its `confidence` is `high`, the thread isn't urgent and has no `due` within 7 days,
and it's the thread's only open proposal. The flag isn't in the rules: approving is always the
member's own write. Never mark a type that sends as batchable.

The initial types:

| Type       | Fields         | Carried out by           | Thread state when done   |
| ---------- | -------------- | ------------------------ | ------------------------ |
| `reply`    | text, holding? | the home agent           | waiting on them          |
| `no_reply` | reason?        | takes effect on approval | done                     |
| `handover` | to, note?      | the home agent           | waiting on a third party |
| `snooze`   | until          | takes effect on approval | waiting until the date   |
| `nudge`    | text           | the home agent           | waiting on them          |
| `ignore`   | reason?        | takes effect on approval | ignored                  |

`make_it_work` (Make it work) was retired with Projects (slice 11): it stays in the registry with
`retired: true` so old records still read, but nobody proposes or approves one any more. To have
something built, propose a Development plan (see "Plans").

`reply_book` and `book` (bookings) were **retired with Calendar** (item OE8FmrTaIxFVGcaeGG3N,
slice 5): they stay in the registry with `retired: true` so old records still read ("Booking
(retired)"), but nobody proposes, revises or approves one any more (the actions refuse, and the
rules have no field lists for them). An old proposed one can only be rejected; an old approved
one can still be reported done by its executor.

An outcome's life:

1. An agent proposes it (`proposed`). The thread goes to `yourCall`.
2. The member approves it (`approved`), possibly editing its fields, or rejects it (`rejected`).
   Rejecting the last open proposal sends the thread back to `investigating`.
3. A type that takes effect on approval goes straight to `done`, and the thread moves on in the
   same batch.
4. Otherwise the **executor** carries it out with exactly the approved fields. The executor is
   the thread's home agent, `fetchedBy`, because it has the channel access. It reports
   `outcome_done`: `done` moves the thread to the type's state, and `failed` sends it back to
   `investigating`.

### Ask for changes (item L7OzWKMYZ1O2dX33Xkrj)

Instead of rejecting a proposal and waiting for a new one, the member can ask the agent that
proposed it to change it. It works on the types with text: `reply`, `nudge` and
`handover`.

1. **The member asks** (`requestRevision`, event `outcome.revise_requested`, member): quick
   chips (`shorter`, `formal`, `warmer`, `availability`) and/or an instruction of 1-500
   characters. The outcome goes to **`revising`** in place, with
   `revise: {instruction, chips, byUid, at}`. The thread stays in `yourCall`, so the card keeps
   its slot, and no rejection is written. Cancel (`cancelRevision`, the same event with no
   chips and no instruction) puts it back to `proposed`.
2. **The proposing agent revises** (`outcome_propose` with `revises: <outcomeId>`, CLI
   `--revises`; `reviseOutcome`, event `outcome.revised`): same thread and type, fields cleaned
   as for a proposal. The outcome is `proposed` again. `versions` is an append-only list on the
   outcome, created by the first revision: v1 is the original proposal, then one entry per
   revision `{n, fields, note, confidence, checks, by, eventId, asked}` (`asked` is what the
   member asked for, `eventId` the `outcome.revised` event; both null for v1). At most 10
   versions. The top-level `fields`, `note`, `confidence` and `checks` always hold the latest
   version, so carrying out and the CLI are unchanged.
3. **The member approves the version shown** (`approveOutcome` with `version`): its fields, or
   the member's edit of them, and `decision.version` records which one. Edit changes the shown
   version at approval; it never makes a new version. Approving also works while the agent
   revises: that ends the request, and the agent's late revision is refused ("already decided").
   Reject needs `proposed` (Cancel first).

**An agent on an older CLI never sees `revise`** (item N9EEnCa1MzIw5UYfe70N). The channel only
pushes event kinds its CLI knows, so such an agent stays silent and the card would sit on
"Revising…". The CLI writes its version as `cliVersion` on the agent's presence stamp (an agent
writes only its own, `firestore.rules`), and `packages/shared/src/cliversion.ts` lists the minimum
version per event kind (`revise` needs 0.2.163). While a revise is pending, the Revising strip
shows "<agent> needs a Hivenod update to do this… run `hivenod update`" when the reported version
is below the minimum. An agent that reports no version (a CLI from before this existed) gets no
hint, because it may be new enough. The member can Cancel the request at any time.

An agent that can't make the change (the time asked for is taken, say) says why with
`inbox_ask` on the thread; the outcome stays `revising` until the member cancels or sends.

### Re-check and "May be out of date" (item bmNoIvvqKCdAorLSShE9)

A proposal decided or drafted earlier can go stale: days later there is new availability, a new
message, new facts. The member can ask the thread's home agent to run its checks again.

1. **The member asks** (`requestRecheck`, event `thread.recheck_requested`, member): only on a
   thread in `yourCall` or `waiting` (something open), and not while an earlier request (under 30
   minutes old) still waits. The thread gets
   `recheck: {state: 'pending', by, requestedAt, result: null, note: null, at: null}`. Nothing else
   changes: the proposals stay as they are and the member can still approve them.
2. **The home agent gets a `recheck` inbox event** (priority 1, like `revise`; a listener on
   `fetchedBy == me` and `recheck.state == 'pending'`, one event per request). It re-reads the
   thread, the new messages and the context, then for each open proposal
   (`proposed`) and each step of a live plan that has not run (`approved`, not at the cursor:
   `recheckable`) it either keeps it, or writes its next version with `outcome_propose
revises=<id>` (allowed unasked while the request is pending; the version's `asked` is null;
   an approved plan step goes back to `proposed`, its `decision` cleared, so the member approves
   it again), or asks with `inbox_ask`.
3. **The agent answers** with `thread_recheck_done(threadId, result, note?)` (`recheckDone`, event
   `thread.rechecked` with `{result, note, checked}`): `still_good` also stamps `checkedAt` on
   every recheckable outcome of the thread in the same batch; `revised` and `asked` only close the
   request. The thread's `recheck` becomes `{state: 'done', result, note, at}`. Once per request.

**"May be out of date"** is computed in the browser (`packages/shared/src/stale.ts`), nothing is
stored. An open proposal or unrun step is flagged when its slot (`fields.start`) has passed, when
the thread's `lastMessageAt` is after it was written or last checked, or when that was more than
24 hours ago ("written": the newest of `createdAt`, `checkedAt`, the last version while proposed,
the approval of an approved step). The chip says why on hover or tap and has **Re-check** next to
it. Nothing runs by itself.

**The UI.** Re-check is in the proposal's Other menu (the Today card, the thread page's agent
panel and its phone sheet) and on the plan panel. It counts down on the button with Undo (5 s)
before the request is written. While pending, a "Checking again…" strip sits on the proposal;
then a result line: "Checked again 16:40 · still good", or the new version with its word diff
(the versions switcher, "After a re-check"), or the agent's question. A re-check needs CLI
`0.2.177` (`recheck` in `cliversion.ts`); the strip says when the home agent is older.

### Ask the agent (item w6O2KOw4ys70TQv9I1xD)

On any thread, in any state, the member can ask its home agent something: "prepare me for the
meeting that was just accepted", "summarize this", "follow up". A human trigger on top of what
the agents do by themselves.

1. **The member asks** (`instructThread`, event `thread.instructed` with `{text, chip}`, member):
   free text (1-500 characters) or one chip (`prepare_meeting`, `follow_up`, `summarize`,
   `draft_reply`). The thread keeps it in `instructions.<id>` (the id is the event's):
   `{text, chip, by, at, state: 'pending', answer: null}`, and `instruct: {state: 'pending', id,
at}` points at the latest one. Append-only, at most 20 kept: at 20 the oldest answered one goes
   in the same write. One at a time: a new one waits until the agent answered, or 30 minutes
   passed. Nothing else changes.
2. **The home agent gets an `instruct` inbox event** (priority 1; a listener on `fetchedBy == me`
   and `instruct.state == 'pending'`, one event per request, with `instruction_id`). The text quotes
   the request (a chip as what it asks) and says it is not an approval of anything.
3. **The agent answers once** with `thread_answer_instruction(threadId, instructionId, kind,
refId?, note?)` (`answerInstruction`, event `thread.instruction_answered`): `note` (the answer
   itself, in the note), `ask` (after `inbox_ask`), `outcome` or `plan` (after `outcome_propose` /
   `plan_propose`, `refId` its id, on this thread). The instruction becomes `answered` with
   `answer: {kind, refId, note, at}`; `instruct.state` becomes `done` when it was the latest.
   Anything outward still waits for the member's approval of an outcome.

**Chips.** The **Re-check** chip asks for a Re-check (above); the others send an instruction.
The browser shows at most 3 (`packages/shared/src/chips.ts`, nothing stored): the home agent's
suggestions first (`suggestedChips`, 0-5, set with `thread_suggest_chips`, event
`thread.chips_suggested`), then those that fit now: **Prepare for the meeting** (an old `reply_book`
or `book` outcome approved or done, starting in the next 7 days), **Re-check** (an open proposal
or unrun plan step may be out of date, and a Re-check may be asked), **Follow up** (waiting on
them, no message for 3 days), **Summarize** (8 messages or more), **Draft a reply** (nothing
open and the last message is theirs).

**The UI.** The "Ask the agent…" box (500 characters, ⌘↵ or Ctrl+↵ sends) with the chips above
it sits in the thread page's agent panel (and its phone sheet) and in the Today card's Other
menu ("Ask the agent…"). Sending counts down on the Send button (or the chip) with Undo (5 s)
before it is written. While pending: "Asked · <agent> is on it". The answer shows under the
request (the note, or a link to the question, proposal or plan), and both are on the thread's
timeline. An instruction needs CLI `instruct` in `cliversion.ts`; the line says when the home
agent is older.

### Bookings (removed with Calendar)

Bookings went with Calendar (item OE8FmrTaIxFVGcaeGG3N, slice 5): approving never writes a
calendar event, and there is no `calendar_*` tool or `hivenod calendar` command any more (an old
CLI's calendar calls are refused by the rules). To offer a time, propose a `reply` that suggests
it. The old calendar data stays, unread by the app, until the export (slice 7) and the deletion
script (slice 11).

### Plans (item qwFAWxZM5xkcE7PPjAzi)

An agent may propose a **plan** instead of one outcome: an ordered list of 1-8 steps for a
thread. Each step is an `inboxOutcomes` doc with `planId`, so it keeps everything an outcome
has (fields, note, confidence, checks, versions, Ask for changes, Edit on approve). The plan doc
holds the order (`steps`) and whose turn it is (`cursor`). The pure model is
`packages/shared/src/plans.ts` (`planView`, `singlePlanView`, `planThreadState`); the actions are
in `inbox.ts`.

- **Step types.** A plan may hold reply, nudge, handover, snooze (as "wait
  until"), approval and the Development steps shape, build and release, never no_reply or
  ignore (nor the retired bookings and make_it_work). `approval` (kind
  `human`: what, detail?, link?) is a gate the member decides; it is plan-only:
  `outcome_propose` refuses it alone.
- **Proposing** (`proposePlan`, agent): the plan, its steps and one `plan.proposed` event in one
  batch, so the member never sees half a plan. The thread goes to Your call.
- **Approving.** `approvePlan` (`plan.approved`): every proposed agent step is approved at the
  version on show, unedited; gates and steps being revised are left as they are (a plan with an
  old booking step is refused). `approveOutcome` approves one agent step any time before it
  runs (with Edit and a chosen version). Approving early never runs a step early.
- **Order.** A step is carried out only at the cursor (the rules refuse any other), and
  reporting it done moves the cursor by exactly one. A gate is decided only at its
  turn and only by the member: Approve marks it done and moves the cursor; Not approved
  (`rejectOutcome`) stops the plan and the thread goes back to investigating.
- **Long steps.** Build and release are long steps: `finishOutcome` with status `started` puts the
  step in `running` (the thread waits on the work); `done` later moves the plan on.
- **Development plans.** The template `dev` (`packages/shared/src/planTemplates.ts`) is shape →
  Approve idea → build → Ship it? → release → Accept on live. Shape researches the idea and writes
  the proposal into the summary. Build ends with an open pull request, checks green, not merged.
  Release merges it, releases and checks it live. The three approvals are the member's gates; a
  member who asks for changes at a gate sends the plan back to an earlier step, and an agent can
  send its own plan back with `plan_send_back`. Start one with `plan_propose` `template: "dev"`
  or from the member's New thread.
- **Wait until.** An approved snooze at the cursor makes the thread wait until its date;
  `wakeThread` then marks it done and moves the plan on.
- **Failures.** A failed step blocks the plan (thread: Your call); the member retries
  (`retryPlanStep`: approved again), skips (`skipPlanStep`: set aside, cursor +1) or stops
  (`stopPlan`).
- **Edit plan** (`editPlan`, `plan.edited`): move or remove a step that has not started, or add
  an approval step from the first step not started on. The steps already through, and the one
  being carried out, never move. A removed step is rejected with the reason "removed".
- **Reject plan** (`rejectPlan`): every step not started is rejected, the plan stops, the thread
  goes back to investigating.
- **Thread state.** Every plan batch sets the thread from the plan (`planThreadState`): a step at
  the cursor that needs the member → Your call; a long step running → waiting on the work; a wait
  until → waiting until its date; an approved agent step → the last agent step's after-state
  (Your call for the first); all through → the last agent step's after-state; stopped →
  investigating.
- **Batch size.** Approve plan and Reject plan with 8 steps fit in one batch: the
  rules tests run the worst case on the emulator (within Firestore's 20 reads per batch).

### Summaries (item OE8FmrTaIxFVGcaeGG3N, slice 1)

Every thread carries a summary written by its home agent, so the member reads one line, sees
the recommendation and decides (`packages/shared/src/summary.ts`; the decision page that shows
it comes in slice 2).

```
workspaces/{wid}/inboxSummaries/{tid}                  the current summary (doc id = thread id)
workspaces/{wid}/inboxSummaryVersions/{tid}_{version}  each version, create-only; 20 kept
inboxThreads/{tid}.summary = { version, at, headline, ask, answer, recAction, confidence }
```

Fields: `headline` (1-120, what the thread is), `ask` (≤200, the question while a proposal or
person step waits, else null), `answer` (≤160), `recommendation` `{action ≤40, why ≤200}`,
`confidence`, `bullets` (1-5 `{text ≤160, refs ≤3}`), `details` (markdown ≤6000), `visuals`
(≤4), `noVisualWhy` (≤140), `refs` (≤30 `{kind message|attachment|step|event|link, id, label,
url https|null}`), `basis` `{lastEventId, planCursor}` (what the agent had read), plus
`memberUid`, `threadId`, `version`, `by`, `at`, `lastEventId`. Every key is stored (null when
not given).

Visuals are data, never pictures or markup, and are stored with every key of their kind:
`bar`/`line`/`stacked_bar` `{title, caption, unit, x (2-24 labels ≤16), series (1-4, 2-4
stacked; {name ≤30, values per x, number|null}), highlight (index|null), better up|down|null}`;
`number` `{title, caption, value, unit, delta, trend (2-24 numbers|null), better}`; `flow`
`{title, caption, nodes (2-8 {id ≤16, label ≤40, who agent|person|system|null, state
done|now|next|changed|removed|null}), edges (≤10 {from, to, label}; [] = a straight sequence)}`;
`before_after` `{title, caption, before/after {label ≤24|null, lines 1-6 ≤60}}`; `timeline`
`{title, caption, events (2-12 {at ISO date or datetime, label ≤60, state
done|now|next|risk|null})}`. Titles (≤80) and captions (≤200, the takeaway and alt text) and
all labels are plain text. Images (slice 4): `image` `{title, caption, attachment}` and
`image_pair` `{title, caption, before, after, labels [before, after]|null}` name image
attachments of the same thread (see "Thread attachments").

**Writing it.** `thread_summary {threadId, baseVersion, summary}` (CLI `hivenod thread summary
ID --file F|-`): the home agent only, as its last call after every inbox event that changed the
thread. `baseVersion` is the version `thread_read` showed (0 for none); a summary that moved on
is refused ("re-read"). One batch: the summary (version + 1), its version doc (the one 20 back
deleted), the thread's mirror (it stamps `updatedAt`), one `summary.written` event `{version}`.
`checkSummary` gives plain errors ("bullets: 6 bullets, at most 5", "visual 2: 25 points, at
most 24"). **The visual rule:** at every person step (`ask` set) a summary has a visual or a
`noVisualWhy`; the tool and the rules refuse one without either.

**Freshness.** Fresh when `summary.at >= thread.updatedAt` (`summaryFreshness`); the home
agent's channel sends the inbox reason `summarize` (lowest priority, once per change, never
while other work on the thread is in flight) for an open thread that changed 3 minutes ago or
more without a newer summary. `thread_read` returns `summary` (with `state` none, fresh or
stale) and, for the home agent while it is not fresh, `summaryNext`; `inbox_list` rows carry
`summary {version, headline, state}`. CLI minimum version: `summary` in `cliversion.ts`.

**Rules.** Members read summaries and versions like the thread and never write them. Each
document of the batch has its own budget of 1000 expressions, so the checks are spread: the
summary doc checks the home agent, version + 1, its fields and bullets, the event, the version
doc and the mirror; the mirror (thread update) equals the summary and checks its visuals
(kinds, counts, plain titles and captions: the generated block "summary checks"); the version
doc equals the summary's top fields and bounds its lists. Per-label texts, values per point
and edge ends are `checkSummary`'s; the app reads summaries and versions through the zod
schema. `packages/shared/rules/headroom-summary.test.ts` keeps each at 20 pad units or more
with the heaviest summary.

**The decision page (slice 2).** `apps/web/src/threads/ThreadPage.tsx` opens every thread on
its decision: the top card (`DecisionTop.tsx`: the state kicker, the summary's `ask` or
`headline`, `answer`, recommendation and confidence, the person-step buttons, "updated N ago ·
vN" with the version history and "May be out of date" plus why: agent offline or CLI below
`summary`), the short version (bullets, then the visuals drawn by `apps/web/src/ui/visuals/`),
then More detail and Everything folded (keys D and E; A approves, C asks for changes). A plan is
a sticky right rail from 1024 px and a fold on a phone. Without a summary the top card uses the
app's own line (the proposal, the gate, the question) and the short version says "No summary
yet" with the first message. The page reads the summary with `looseSummarySchema`
(`threads/decision.ts`): each visual is checked on its own, so an unknown kind shows as "not
shown"; every label renders as plain text and only https links are followed.

## Areas and quiet subjects

- **Area:** an optional tag on a subject (a client, a product, "admin"; at most 60 characters,
  spaces collapsed, empty means none). Agents set it with `subject_assign` (`area`, CLI
  `--area`): on a new subject, or to change an existing one while filing under it (event
  `thread.filed`, `data.area`). The member sets or clears it on the subject page
  (`setSubjectArea`, event `subject.area`). `subject_list` shows each subject's `area`, so
  agents reuse the existing areas. Rules: agents may change only `area` of a subject, in a
  filing batch; the member may also rename.
- **Label:** the kind of request (Sales, Support, ...), not the topic: area says which client,
  label says what sort of thing it is. Each organization has a short list (`inboxConfig/labels`,
  edited by admins in Settings, Inbox labels; until then `DEFAULT_INBOX_LABELS`: Sales,
  Support, Billing, Partnership, Internal, Other, mirrored by `DefaultInboxLabels` in Go).
  `subject_list` returns the list as `labels`, and each subject's `label` and `labelSuggested`.
  On every new subject the agent suggests exactly one label with `subject_assign` (`label`, CLI
  `--label`; matched ignoring case; an unknown one is refused with the allowed values). It is
  applied to a new subject, or to one with no label yet (event `thread.filed`, `data.label`),
  stored as `label` + `labelSuggested: true` + `labelBy: 'agent'`; the app shows it as a dashed
  "Sales?" chip. The member confirms (OK) or changes it (`setSubjectLabel`, event
  `subject.label`): `labelSuggested: false`, `labelBy: 'member'`, and from then on the agent
  never changes it. Labels are stored as text: renaming or removing one in the list leaves
  existing subjects alone (they show a plain chip). Rules: agents may set the three label
  fields only as a suggestion, only in a filing, never over a member's label; the member's value
  must be in the list (or be what the subject already has); only admins write the list.
- **Quiet:** derived, never stored. A subject is quiet when none of its threads had a message
  for N days (default 60; the list's "Quiet after" select offers 30, 60, 90, 180 or never, kept
  per browser) and no thread waits for the member. The list folds quiet subjects into a closed
  "Quiet (n)" section; nothing is deleted, and the next message makes the subject active again.
  Threads not filed yet are never quiet. `groupByArea` and `isQuiet` in
  `apps/web/src/threads/logic.ts`.

## Related subjects

Two subjects of one member can be linked as related: the same client, project or problem seen
from two sides. A link is symmetric, so a pair has one document, `rel-<a>-<b>` with `a < b`
(`relationId(a, b)` either way round). It has an optional one-line `note` (at most 500
characters) and a `state`:

| State      | How it gets there                                                                   |
| ---------- | ----------------------------------------------------------------------------------- |
| `proposed` | An agent proposed it (`subject_relate`, `proposeRelation`).                         |
| `related`  | The member accepted the proposal, or linked the pair themselves (`relateSubjects`). |
| `rejected` | The member turned it down (`rejectRelation`) or removed it (`unrelateSubjects`).    |

Agents can't propose a pair again once it's proposed, related or turned down; the member can
relate a turned-down pair again. Relations are never deleted. A link to a subject that a merge
removed is ignored (search and the subject page skip it). Events: `relation.proposed` (agent),
`relation.accepted`, `relation.created`, `relation.rejected`, `relation.removed` (member), with
`data: {relationId, a, b, note?}` and `subjectId: a`.

For the web app: list a member's links with `where('memberUid', '==', uid)` on
`inboxRelations`; show `related` ones on both subjects' pages and `proposed` ones as suggestions
with OK (`relateSubjects` with the proposal as `existing`) and No (`rejectRelation`).

## Finding subjects

`searchSubjects(input)` in `packages/shared/src/inbox.ts` is pure, so the agent tools (TS and
Go, checked by the contract cases) and the web app's Find give the same answer. Input: the
member's subjects, threads, messages and relations (one workspace's; the web app may pass
several workspaces' rows), the query, the filters and `nowMs`.

- Every word of the query, lowercased, must appear in the subject's name, its people (sender
  names and handles of its threads' messages), its channels (sources), its thread titles or its
  message texts. Up to 10 words count.
- Order: score (per word, its best field: name 5, people 3, channel 3, thread title 2, text 1),
  then threads waiting for the member, then the latest activity, then the name.
- Filters: `waitingForMe` (a thread in Needs you or Your call), `activeDays` (a message in the
  last N days), `hasOpen` (an open thread), `limit` (default 20, at most 100). The organization
  is the workspace the rows come from.
- Each hit: `subjectId, name, score, matched[] (name|people|channel|thread|text), forYou, open,
threads, lastActivityAt, people[] (who wrote in, at most 10), channels[], related[],
proposed[]` (links as `{subjectId, name, note}`), plus `total` before the limit.

## Rules (firestore.rules, "inbox")

- **Reading:** only the member in `memberUid` (while still in the organization) and the
  organization's non-revoked agents can read anything here. Admins and other members can't.
  Members list their own records with `where('memberUid', '==', uid)`.
- **Agents** can:
  - bring messages in for a member of their organization;
  - file threads under that member's subjects;
  - add notes, ask questions and propose outcomes. The executor is fixed by the rules;
  - revise an outcome they proposed while the member asks for changes (`revising`): same type,
    a proposal's fields, the versions append-only, at most 10;
  - (the home agent only) answer a pending re-check once (`thread.rechecked`, its result named
    by the event), stamp `checkedAt` on open proposals and unrun live-plan steps in that batch
    (still good only), and while it is pending revise its open proposals, or an unrun approved
    step (clearing its approval), unasked;
  - (the home agent only) answer each of the member's instructions once
    (`thread.instruction_answered`, its kind named by the event; the instruction otherwise
    unchanged, no other one touched), and set the thread's suggested chips (0-5 known ones, once
    each, `thread.chips_suggested`);
  - wake a thread whose date has passed;
  - report outcomes they carry out, but only after approval;
  - retitle threads.
- **The member** can:
  - answer questions;
  - ask the home agent something on a thread (`thread.instructed`): one new pending entry, a text
    (1-500) or a chip, its id the event's, the others unchanged (at 20 exactly one goes), not
    while the latest one (under 30 minutes old) waits;
  - approve, edit and reject outcomes, approve a chosen version (also while revising);
  - ask the proposing agent for changes (chips and/or 1-500 characters, below 10 versions) and
    cancel that;
  - ask the home agent to re-check a thread in Your call or waiting (not again while a request
    under 30 minutes old waits);
  - ignore, close and bring back threads;
  - move threads between subjects;
  - rename, merge and split subjects.
- **Plans:** agents propose plans (cursor 0, 1-8 steps created in the same batch, each on the
  plan's thread) and report only their own step at the cursor; the cursor moves by one. Only the
  member approves steps or the plan, decides gates (at their turn), edits, retries, skips, stops
  or rejects a plan. Single outcomes (no `planId`) keep the rules above.
- **Related subjects:** agents of the organization propose links between two subjects of the
  same member; only that member relates, accepts, turns down and removes them.
- **Approval:** agents never write `approved` or a decision, so nothing is carried out without
  the member's OK.
- **Tracking:** every inbox write is tracked in `inboxEvents`, never in the organization-wide
  `events`, which every member can read.
- **Tests:** `packages/shared/rules/inbox.test.ts`, `inboxrevise.test.ts`, `inboxrecheck.test.ts`, `inboxinstruct.test.ts`, `inboxrelations.test.ts` and `plans.test.ts`. The `inbox: …`, `recheck: …`, `instruct: …`, `chips: …` and `plans: …` mutations in
  `packages/shared/rules/mutate.mjs` are all caught.

### Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4)

The home agent attaches files to its thread with `thread_attach {threadId, source, name?}` (CLI
`hivenod thread attach ID FILE|URL [--name N]`; `packages/shared/src/threadattach.ts`): the same
kinds and 900 KB inline limit as before, kept inline in Firestore (no file storage):

```
workspaces/{wid}/inboxAttachments/{threadId}_{id}   immutable
  memberUid, threadId, kind html|markdown|text|image|pdf|link, name 1-200, content | null,
  url (https) | null, bytes, by (agent uid), at, lastEventId (a thread.attached event)
```

Images are PNG, JPEG or WebP data URLs only (`THREAD_IMAGE_RE`), never SVG or HTML; links are
https. The id starts with the thread's id, so the rules can refuse a summary visual that names
another thread's attachment or a URL (`summaryAtt` in the generated block); `writeSummary` also
checks that each image visual names an existing image of the thread (the Go client reads the
thread's attachment kinds). The decision page shows only images it was handed for this thread
(`threadImages`): an `image_pair` side by side on desktop, stacked on a phone, with Compare (a
slider overlay) when both have the same size; a click opens the image full size in the
attachment viewer; the caption is the alt text. Everything lists the files under "Files from
<agent>" (images inline, the rest in the viewer, HTML sandboxed). **The visual rule** in the
channel instructions, SKILL.md and both tool descriptions: at a person step, a UI change shows
before/after screenshots (`thread_attach` both, then an `image_pair`). Rules: the home agent
creates (with its event), the member and the org's agents read, nobody updates or deletes.

## Agent tools (MCP and Go CLI)

| Tool                        | CLI                                               | What it does                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inbox_add`                 | `hivenod inbox add`                               | Brings a message in. It's for `member`, by default the person who connected the agent. Repeats are reported as duplicates.                                                                                                                                                                                               |
| `inbox_list`                | `hivenod inbox list`                              | Lists what agents have to do: `toWork`, `toCarryOut` (approved outcomes this agent carries out) and `toWake`.                                                                                                                                                                                                            |
| `thread_read`               | `hivenod thread read ID`                          | Shows one thread: messages, subject, outcomes and decisions, notes and Q&A, and what to do next.                                                                                                                                                                                                                         |
| `subject_list`              | `hivenod subject list`                            | Lists a member's subjects, with how many threads wait for them and how many are open.                                                                                                                                                                                                                                    |
| `subject_assign`            | `hivenod subject assign ID`                       | Files or moves a thread under an existing subject or a new one. A matching name reuses the existing subject.                                                                                                                                                                                                             |
| `subject_search`            | `hivenod subject search …`                        | Finds a member's subjects by name, people, channel and thread text, with filters (see "Finding subjects").                                                                                                                                                                                                               |
| `subject_relate`            | `hivenod subject relate A B`                      | Proposes two subjects as related, with a note. The member OKs or turns it down.                                                                                                                                                                                                                                          |
| `inbox_note`                | `hivenod inbox note ID`                           | Adds an investigation note to the timeline.                                                                                                                                                                                                                                                                              |
| `inbox_ask`                 | `hivenod inbox ask ID`                            | Asks the member a question. The thread waits in Needs you.                                                                                                                                                                                                                                                               |
| `outcome_propose`           | `hivenod outcome propose ID`                      | Proposes an outcome of a type from the registry, with its fields. With `revises` (`--revises OID`): that outcome's next version.                                                                                                                                                                                         |
| `plan_propose`              | `hivenod plan propose ID`                         | Proposes a plan: 1-8 ordered steps in one call (`--steps-file F`, `-` for stdin). See "Plans: the agent side".                                                                                                                                                                                                           |
| `outcome_done`              | `hivenod outcome done OID`                        | The executor reports an approved outcome as done or failed; a long plan step (build, release) as `started` first.                                                                                                                                                                                                        |
| `thread_wake`               | `hivenod thread wake ID`                          | Wakes a snoozed thread whose date has come.                                                                                                                                                                                                                                                                              |
| `thread_flag`               | `hivenod thread flag ID`                          | Marks a thread urgent (or not, `urgent: false` / `--off`): the notifier pings the member at once, whatever the quiet hours.                                                                                                                                                                                              |
| `thread_due`                | `hivenod thread due ID ISO`                       | Sets the deadline a message states (ISO 8601 with its offset), or clears it (`due: null` / `--clear`). Today ranks by it.                                                                                                                                                                                                |
| `thread_recheck_done`       | `hivenod thread recheck-done ID RESULT`           | Answers the member's re-check: `still_good` (stamps the open proposals), `revised` (after `outcome_propose revises`) or `asked` (after `inbox_ask`), with an optional note.                                                                                                                                              |
| `thread_answer_instruction` | `hivenod thread answer-instruction ID INSTR KIND` | Answers the member's request on the thread once: `note` (with `--note`), `ask`, `outcome` or `plan` (with `--ref`, its id).                                                                                                                                                                                              |
| `thread_attach`             | `hivenod thread attach ID FILE\|URL`              | Attaches a file (png, jpg, webp, html, md, txt, pdf; up to 900 KB) or an https link to the thread (home agent only). Returns `attachmentId` for image visuals.                                                                                                                                                           |
| `thread_suggest_chips`      | `hivenod thread suggest-chips ID [CHIP]…`         | Sets the home agent's quick chips for the thread (0-5 of `prepare_meeting`, `recheck`, `follow_up`, `summarize`, `draft_reply`).                                                                                                                                                                                         |
| `schedule_propose`          | `hivenod schedule propose ID --file F`            | Proposes a schedule (rule, plan of each run) on the member's thread: a `schedule` outcome the member approves (Set up schedule). `revises`: its next version; `replaces`: a change of one it runs.                                                                                                                       |
| `schedule_end`              | (MCP only)                                        | Proposes ending a schedule the agent runs (`scheduleId`, `reason`): an `End schedule` outcome the member approves; the schedule becomes `ended` (future runs stop, past runs and their threads stay). `schedule_propose` with `replaces` as a list merges: the first id is changed, the others end in the same approval. |
| `schedule_list`             | `hivenod schedule list`                           | The member's schedules in this organization: rule in words, state, agent, next 3 runs (computed, one query, no run reads).                                                                                                                                                                                               |

### Decision data (item kt3E7u9EliL3q2veDDI0)

What the member's Today page needs to rank and explain a decision. All of it is optional, so
older records stay valid.

- **`note`**: the agent's why, 1-2 sentences. The member reads it first.
- **`confidence`** (`outcome_propose`, CLI `--confidence`): `high`, `medium` or `low`, shown as
  "Sure", "Likely" or "Unsure" with a 3-bar meter. Use `high` only when every fact the outcome
  relies on is verified, and `low` when guessing what they want. Written only on create.
- **`checks`** (`outcome_propose`, CLI `--check`, repeatable): what the agent verified, at most 6
  lines of 1-200 characters, e.g. "Ticket 412: fixed in release 38".
- **`due`** (`thread_due`): a deadline stated in the thread. Its agents or its member set or clear
  it with a `thread.due` event (data `{due, reason}`). Today's rank: band 1 is urgent or due
  within 24 hours (or past), band 2 is due within 7 days, then `needsYou`, then `yourCall`.
- **`question.options`** (`inbox_ask`, CLI `--option`, repeatable): up to 4 answer chips of 1-80
  characters. A chip answers with its text, through the usual answer. The member's answer may
  change only `answer` and `answeredAt` of the question.

The Today brief counts `inboxMessages` received in the last 24 hours, with the composite index
`inboxMessages (memberUid, receivedAt)`.

The contract tests cover the agent actions: `cli/contract/cases.ts` against the Go actions, and
`cli/e2e/test/go.test.ts`, which runs the inbox scenario through the Go CLI on the emulators and
requires the results and documents of its golden files (first recorded while the TypeScript client
and the Go CLI agreed).

### Plans: the agent side (item qwFAWxZM5xkcE7PPjAzi, slice 3)

- **`plan_propose`** `{threadId, note?, confidence?, steps: [{type, fields, note?, confidence?,
checks?}]}` (Go `actions.ProposePlan`, the port of `proposePlan`): one batch with the plan, its
  steps and the `plan.proposed` event. It returns `{planId, stepIds, steps: [{step, outcomeId,
type, kind}]}`. The CLI reads the steps from a JSON file: a list of steps, or `{steps, note,
confidence}`. Use it when the answer has more than one action or needs the person's OK on the
  way; put an `approval` step before anything that changes money, prices, contracts or public
  content. A single action stays `outcome_propose`.
- **`outcome_done`** on a plan step works only at its turn (the plan's cursor, the plan
  `proposed` or `active`): `done` moves the cursor on, `failed` blocks the plan (the member
  retries, skips or stops). A long step (build, release) is reported `started` when it begins (the
  step is `running`, the thread waits on the work), `step_progress` as it goes, then `done`.
- **`thread_wake`** on a thread whose live plan waits at a `snooze` step marks that step done and
  moves the plan on (no `woke` event to investigate).
- **`thread_read`** adds `plans`: each with `planId, state, cursor, progress` ("Step 3 of 5"),
  `note, confidence` and its `steps` (`step, outcomeId, type, kind, label, ui, atCursor`; `ui` as
  `planView`). Each outcome of a plan has `planId` and `step` ("3 of 5"); a plan's steps list in
  their order. `next` says carry out only for a step at its turn.
- **`inbox_list`** `toCarryOut` lists a plan step only at its turn, with `planId` and `step`.
- **Revising a step** is `outcome_propose revises=<stepId>`, as for a single outcome: only that
  step changes, its `planId` stays.
- The Go actions are kept equal to the TypeScript ones by the contract cases (`proposePlan`,
  `finishOutcome/plan/…`, `wakeThread/plan/…`, `planThreadState`, `planView`); the golden
  scenario "plans (item qwFAW)" in `cli/e2e/test/go.test.ts` runs a plan through the Go CLI against the rules, and `channel.test.ts` checks one
  `carry_out` per step at its turn.
- An older CLI sends `carry_out` for every approved step at once: `EVENT_MIN_VERSION.plan`
  (`cliversion.ts`) is the first CLI that handles plans, for the web app's hint.

### Keep green (item OE8FmrTaIxFVGcaeGG3N, slice 6c)

The Development template (`packages/shared/src/planTemplates.ts`) has a long agent step
**Keep green** (`keepgreen`) between Build and Ship it?: Shape → Approve idea → Build → Keep green
→ Ship it? → Release + live check → Accept on live. Plans made before keep their six steps.

- The agent rebases the pull request onto main, reruns the local checks (GitHub Actions is off:
  the local checks are the pipeline), fixes failures and loops until the PR is green and current,
  reporting each loop with `step_progress`; then `outcome_done done`: the plan moves to Ship it?.
- While Ship it? waits, the done Keep green step still takes `step_progress` from its executor
  (only while it is the step right before the cursor), with `check`: `rechecking` (main moved),
  `green`, or `blocked` (not solvable). The gate then shows "Re-checking after main moved" (or
  "Keep green is stuck") and its Approve reads **Approve anyway**: the member may still approve,
  since Release rebases and re-checks before it merges. Once Ship it? is decided, Keep green ends
  (`stepProgress` refuses: "Keep green ended").
- Not solvable before Ship it? (a rebase conflict that needs a product decision, the same check
  failing after 3 fixes, an infrastructure failure): `outcome_done failed` with the evidence; the
  plan is blocked and the member retries, skips, or **sends it back** (a plan blocked by a failed
  step at its turn may be sent back by the member, to Build by default), or stops it.
- Rules: `step.progress` on a done `keepgreen` step, `progress.check` in the known values; a member
  `plan.sent_back` from a blocked plan whose cursor step failed (it is reset to approved). CLI:
  `EVENT_MIN_VERSION.keepgreen`.

### Their reply (a step that waits on someone outside Hivenod)

`their_reply` (packages/shared/src/theirreply.ts) is a plan step for one person outside Hivenod
reached by a message: `who`, `org?`, `channel`, `address`, `need` and `remindAfterDays` (working
days, default 3). The member approves every message that goes out:

1. At its turn (`carry_out`) the home agent drafts the ask (`step_ask`, kind ask): the step runs
   with `ext.ask` proposed and the thread is the member's call.
2. The member approves it (maybe edited) on the decision page or from the notifier (Approve
   follow-up · Mark done · Open): the agent gets `ask_approved`, sends it exactly as approved and
   reports `step_sent` (`ext.outAt`, `ext.sent`); the thread waits on them and the step shows a
   purple "waiting on Ana · 2 d".
3. Their reply comes in with `inbox_add` and reopens the thread; the CLI pushes
   `external_reply` with the step's outcome id. A clear yes is `outcome_done` with `evidence`
   (their message's id and a quote; the quote becomes the result); unsure is `inbox_ask`; partial
   or unclear is a `step_ask` follow_up quoting the reply. The member can Mark done anyway.
4. No reply: the notifier keeps one in-memory timer per waiting step (send time + working days)
   and writes `remindDue` = the message number once when it fires; the CLI pushes `nudge_due`
   with the step and the agent drafts one reminder. Nothing more fires until another message
   goes out. The thread-level 3-day nudge is skipped while a Their reply step waits.

Rules (`inboxExt`, `inboxExtEvidence`): only the executor drafts and reports sent, only after the
member's approval; only the member approves or marks done; done only with evidence that names a
message from them on this thread created after `ext.outAt` (mutation tests in mutate.mjs). Cost:
no polling; one timer write per waiting step; one model turn per reply.

### Scheduled tasks (schedules, slices 1-8)

A schedule is a recurring job of one agent for one member: a rule (daily, weekly, monthly,
quarterly, once, yearly; a time of day in the member's zone) and the plan each run follows.
Design: `~/drafts/schedules/design.md`. Docs of the clock itself: NOTIFIER.md.

- **How agents propose.** The agent never keeps its own timers. When the person asks for something
  recurring, it checks `schedule_list` (nothing scheduled twice) and calls `schedule_propose` on the
  thread: a `schedule` outcome (the rule in words, the steps of each run, a note, confidence and
  checks) and a `proposed` schedule doc, so the thread goes to Your call. Nothing runs until the
  member approves it (Set up schedule); he can edit it first (`outcome.approved` with
  `edited`). A change of a schedule the agent runs is `replaces=<scheduleId>`; Ask for changes comes
  back as `reason="revise"` (`revises=<outcomeId>`, the whole schedule again). The member can also
  add, edit, pause, resume and delete schedules on the Schedules page; every write is a batch with
  its event (`schedule.created|updated|paused|resumed|deleted`, `scheduleActions.ts`).
- **How runs fire.** The notifier's scheduler fires each occurrence once: one batch writes the run
  `{scheduleId}_{key}` (create(), so a restart or second notifier cannot double it), a thread under
  the schedule's subject, its first message and the plan with its steps. The agent then gets the
  thread like any other work (`carry_out` per step, `step_progress`, `outcome_done`). The run thread
  is shown with the schedule's name; the run's state follows the plan (`running`, `done`,
  `stopped`, `failed`).
- **Can't run.** At due time the gates may say no: the agent is Off, paused or revoked, its CLI is
  too old, it is offline (it gets 15 minutes to come online), the host was down (missed
  occurrences are never fired late), or it did not start within 30 minutes. The run becomes
  `cantRun` with the reason, and the member is asked (bell, push, Telegram, the daily digest for
  daily ones): **Run now**, **Try later** (a time within 35 days) or **Skip this one**
  (`decideRun`, `run.decided`). The scheduler acts on the answer and asks again if a later try
  still cannot run. A run the member stopped is not asked about.
- **Cost.** A run is an ordinary thread: one model turn per step the agent does, nothing while it
  waits. The scheduler itself polls nothing (listeners, one timer, a 15-minute beat); the Firestore numbers are in the NOTIFIER.md
  cost table.
  Off and pause cost nothing.
- **Off.** The member's Off switch (all agents, or some; `agentsOff/{memberUid}`) silences agents
  for him until he switches it on: no timer turns it back on. Scheduled runs for an Off agent become
  `cantRun` (`off`); the session side is in "Off" under Channel events.
- **Activity.** Every one of these is an `inboxEvents` row, shown on Activity under the
  **Schedules** filter in one line each, linked to the schedule or the run thread: proposed
  (`outcome.proposed` of a schedule outcome), approved or turned down, `schedule.*`, `run.fired`,
  `run.done`, `run.expired`, `run.cantRun` (with the reason), `run.decided` (the choice),
  `agents.off` and `agents.on`. The scheduler writes `run.*` as the system actor "Hivenod
  scheduler". The all view asks in two chunks of at most 30 types (Firestore's `in` limit) and
  merges them (`mergeFeeds`, `apps/web/src/activity/data.ts`); the Schedules view is one query.

## Channel events (part 2)

A channel session (`hivenod mcp --channel`, `cli/internal/hive/inboxfeed.go`) pushes `<channel source="hivenod" kind="inbox">` events for
the threads that need agent work. They don't count toward `max_items` (which limits the long plan steps running at once) and are
never claimed: the event carries the thread to work. (In Claude Code, the plugin's `hivenod` skill runs each thread in a background sub-agent of its own.)

**Who gets what.** Each event goes to exactly one agent's session:

- **Investigating a thread** goes to the thread's home agent (`fetchedBy`), the agent that
  brought it in. It is the organization's main agent for that inbox. Reasons: `new` (a new
  thread), `message` (a new message), `answered` (the member answered `inbox_ask`), `woke` (a
  snooze is over), `rejected` (the member turned the proposal down), `failed` (carrying out
  failed), `restored` (the member brought it back), `resume` (still investigating when a new
  session starts).
- **Asked for changes** (`revise`, with `outcome_id` and `outcome_type`) goes to the agent that
  proposed the outcome, while it is `revising` (a second listener: `proposedBy == me`,
  `state == 'revising'`). The text carries the chips and the instruction and says to revise
  with `outcome_propose revises=<id>`: apply only what was asked, keep the rest, never reject or
  start a new outcome. One event per request; a new request after a cancel is a new event.
- **Re-check** (`recheck`) goes to the home agent while the thread's `recheck.state` is
  `pending` (a listener: `fetchedBy == me`, `recheck.state == 'pending'`). One event per request
  (`requestedAt`); a later request after the answer is a new event. The text says to re-read, keep
  or revise each open proposal and unrun step, or ask, then answer with `thread_recheck_done`.
- **Ask the agent** (`instruct`, with `instruction_id`) goes to the home agent while the thread's
  `instruct.state` is `pending` (a listener: `fetchedBy == me`, `instruct.state == 'pending'`).
  Priority 1. One event per request (its id); the text quotes the request and says to answer with
  `thread_answer_instruction`.
- **A nudge due** (`nudge_due`) also goes to the home agent: the thread has waited on them for
  `nudgeAfter` (3 days) since its last change. Noting why not (`inbox_note`) restarts the wait.
- **Carrying out an approved outcome** (`carry_out`, with `outcome_id` and `outcome_type`) goes
  to its executor, which the rules fix to the home agent. A plan step is sent only at its turn:
  the session also listens to the workspace's live plans (`inboxPlans`, state proposed, active
  or blocked) and sends a step's `carry_out` only when it is at its plan's cursor and the plan
  runs (not blocked). A step approved ahead waits; when the step before it is done (or the gate
  before it passed) the cursor moves and its `carry_out` follows. A long step's text says
  to report `started` first.
- **A plan rejected or stopped** (`plan.rejected`, `plan.stopped`, or Not approved on a gate:
  `outcome.rejected` with `planId`) puts the thread back to investigating: `rejected` with
  `plan_id` (and `outcome_id`, `step` for a gate). The text says to re-plan (`plan_propose`,
  `outcome_propose`) or ask.
- A due snooze is woken by the home agent's session itself (`thread_wake`), and the wake then
  sends `woke`.

Meta: `kind: inbox, thread_id, reason, member, inbox_cap, inbox_active`, plus `outcome_id` and
`outcome_type` for `carry_out` and `revise`, and `plan_id` and `step` ("3 of 5") when the event is
about a plan (`carry_out`, `revise` of a step, `rejected`). `update: true` means that thread is already being worked on,
so the session passes the event on instead of starting another one.

**Dedupe.** It's one event per thread state change. The session remembers, per thread, the
last event id it handled (`lastEventId`):

- Notes, filing and titles aren't triggers.
- A listener that reconnects delivers the same documents, and nothing is pushed twice.
- An approved outcome is sent once per session.
- A new session (a restart) sends each thread that still needs work once more, since the old
  session's sub-agents are gone. This stays within the same cap and rate.

**Flow control.**

- At most `maxInbox` threads are in flight at once (`--max-inbox N` or `HIVENOD_MAX_INBOX`,
  0-10, default 3; 0 turns inbox events off).
- A thread is in flight from its event until it leaves the state it was sent for (or the
  outcome leaves `approved`), or for at most 30 minutes.
- At most 10 events go out a minute.
- Waiting ones go out in this order: approved outcomes, answers and change requests (the
  member waits on them now), new messages, the rest, then nudges. Oldest first within each.
- Tuning and tests: `HIVENOD_INBOX_PER_MIN`, and in milliseconds `HIVENOD_INBOX_NUDGE_MS`,
  `HIVENOD_INBOX_LEASE_MS` and `HIVENOD_INBOX_TICK_MS`.

**Off (scheduled tasks slice 7).** A member switches agents Off (all, or some) in an
organization: `agentsOff/{memberUid}` (`setAgentsOff`, his own doc; no timer turns it back on).
The session listens to the organization's Off docs (one listener, no polling) and, while Off for
this agent:

- **holds** what the agent would do on its own for that member: `carry_out` of a step decided
  before `since` (`decision.at`, else `createdAt`), `message` and `new` brought in from outside
  (`inbox.added`), `nudge_due`, `summarize`, `woke` and the wake itself, `failed`, `resume`
  (a long step's too), `item_done` and `item_stopped`;
- **delivers** what he does himself: his New thread (`thread.created`), `answered`, `rejected`,
  `restored`, `instruct`, `revise`, `recheck`, and `carry_out` of a step he approved after
  `since`;
- sends `kind="info" code="off"` once per Off (meta `member`, and `outcome_ids` of the work
  already in this session's hands, told to stop at a safe point and report) and
  `code="on"` when it ends; what was held then goes out in the usual order.

Its tools refuse automated writes for that member with the same line: `inbox_add`,
`thread_wake`, `outcome_done` started or done of a step decided before Off (failed always goes),
and `outcome_propose`, `plan_propose`, `schedule_propose` on a thread the member did not touch
since Off (his message, Ask the agent, a re-check or an answer). Revisions he asked for go. The
rules backstop the step start for older CLIs (`inboxOnFor`, below `off` in `cliversion.ts`).

## The Inbox view (web app)

- **`/inbox`**: the member's subjects, across all their organizations or one (`?org=<id>`).
  Subjects are grouped by area (areas A to Z, then "No area"; no headings while no subject
  has an area), quiet ones in a "Quiet" section at the end. Within a group, subjects with
  threads waiting for the member (Needs you, Your call) come first, then the rest by activity. Threads not filed yet gather under "Not filed yet". **Find** searches the
  subject names, thread titles, the people who wrote, the channels and the text of the
  messages; the filters are: organization, waiting for me, has open threads, active in the
  last 7, 30 or 90 days, and the label. Find runs `searchSubjects` (see "Finding subjects") in the browser over
  the member's own records, one call per organization, so it answers like `subject_search`.
- **`/inbox/<org>/s/<subject>`**: the subject's threads (open and closed) and its timeline, with
  Rename, Merge (pick the target) and Split (pick the threads, name the new subject), and its
  related subjects: links an agent proposed (OK or No), related ones (Unlink), and Link a
  subject with an optional note.
- **`/inbox/<org>/t/<thread>`**: the agent's question with an answer box, the proposed outcomes,
  the decided ones, and the timeline: each message with its sender, source, the original text,
  attachments and a link to the original, and the agents' notes and the decisions. Each outcome
  is drawn from the registry; its fields become editable with **Edit**, and **Approve** (the
  registry's word, e.g. Send for a reply) or **Reject** counts down on the pressed button with
  Undo before it is written. The member can also move the thread to another subject, mark it
  done, ignore it, bring it back, mark it urgent or not (`flagThread`).
  An old approved `reply_book` still shows the slot it booked.
- **Ask for changes** (Today card, the thread page's agent panel and its phone bottom sheet,
  key C): a box with four toggle chips (Shorter, More formal, Warmer, Add my availability), a
  textarea with a 500-character counter and **Ask agent** (⌘↵). While the agent revises, a
  dashed "<agent> is revising · …" strip sits over the dimmed v1, the button reads "Revising… ·
  Cancel", and Send v1 and Edit stay live. A new version shows an inline word diff against the
  one before (added text green and underlined, removed text red and struck; "Hide changes"),
  "You asked: …", and a "‹ v2 of 2 ›" switcher (keys [ and ]). Send names the version shown
  ("Send v1", "Send v2") and counts down on the button with Undo. At 10 versions the button is
  off: edit it yourself or pick another outcome. What the member typed (an edit, the open box,
  the version on show) is kept for the tab, so a remount never drops it: Send sends exactly
  what is on screen.
- **Plans** (item qwFAWxZM5xkcE7PPjAzi, slice 4; `apps/web/src/threads/PlanPanel.tsx`): a
  thread's plans sit at the top of the agent panel (live ones; done and stopped ones after the
  notes). A plan is a numbered checklist: per step a circle in its state's colour (`planView`
  states), a kind icon (agent action, or your approval), a one-line title from its fields
  (`stepTitle`), a state pill and a ⋯ menu (Move up, Move down, Add my approval before/after,
  Remove step) for the steps that have not started; those steps also drag by their handle. One
  step is open at a time (by default the one waiting for the member). An agent step not yet
  approved opens the usual proposal (versions, Edit, **Approve step**, Ask for changes; Remove
  step replaces Reject). An approval step at its turn has **Approve** and **Not approved**
  (the plan stops); before its turn it says it waits. A failed step offers **Retry**, **Skip**
  and **Stop plan**. Above: the plan's note, confidence, "Plan · N steps", what is done,
  approved and still needs the member, a progress bar and **Approve plan** (agent steps only).
  Below: **Add an approval step** and **Reject plan**. Every decision counts down with Undo
  (one countdown per plan). A plan's steps never show as single proposals. If the thread's home
  agent reports a CLI older than `EVENT_MIN_VERSION.plan` (0.2.171), a notice asks for
  `hivenod update` before approving. On a phone the plan is in the bottom sheet ("k of N done")
  with one main button (Approve plan, Approve step k for a gate, Review step k, Retry step k),
  Reject plan (×) and a ⋯ menu (Add an approval step, Stop plan).
- **Today and plans** (slice 5): Today lists a thread with a live plan when the plan asks the
  member something now (`planAsksNow`): it is proposed, blocked (a step failed: listed even with
  nothing proposed), its step at the cursor waits, or an agent step can still be approved ahead.
  An approval step not reached yet keeps it off Today. The row reads "Plan · N steps to approve",
  "Plan · step k of N waits for you" or "Plan · step k of N failed: retry, skip or stop". The card
  shows the plan's progress ("Plan · Step k of N", "j of N done", a bar) and only the step that
  waits (`planMain`): a proposed plan lists its steps with **Approve plan**; an approval step at
  its turn has **Approve** and **Not approved**; an agent step not approved yet is the usual
  proposal (Approve step, Edit, Ask for changes, versions); a blocked step has **Retry**, **Skip
  step** and **Stop plan**. Keys A (the main action), E, C and [ ] work as on any card, and
  **Open plan** opens the thread page. Plan steps never join a tidy-up batch. Single outcomes keep
  their card.
- Every query filters on `memberUid == me`; the rules allow nothing wider.

## Notices (notifier)

A thread arriving at **Needs you** (an agent's question) or **Your call** (outcomes proposed)
tells its member alone: a bell entry (`inboxAsk`, `inboxCall`; `projectId` is `inbox`, `itemId`
the thread: legacy field names) and push and Telegram, linking to the thread page. One arrival is one notice: a new
question, or a new round of proposals after the earlier ones were decided, is a new arrival.
A thread with `urgent: true` (`thread_flag`, or the member's Mark urgent) skips quiet hours and
the summary.

## Still to come

- **Later slices:** personal Google sync, and
  per-workspace auto-OK per outcome type.
