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

All of these live under `workspaces/{wid}`. They are separate from projects and items.

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
                      result{text, permalink, itemId, error, by, at}|null, planId? (absent: a single
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

| State           | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `investigating` | An agent is digging in. Its notes go on the timeline.           |
| `needsYou`      | The agent asked the member a question.                          |
| `yourCall`      | Outcomes are proposed and wait for the member.                  |
| `waiting`       | Waiting on them, on a third party, on an item, or until a date. |
| `done`          | Finished.                                                       |
| `ignored`       | The member chose to ignore it.                                  |

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
member's own write. Never mark a type that sends or books as batchable.

The initial types:

| Type           | Fields                         | Carried out by                                   | Thread state when done   |
| -------------- | ------------------------------ | ------------------------------------------------ | ------------------------ |
| `reply`        | text, holding?                 | the home agent                                   | waiting on them          |
| `reply_book`   | text, start, end, with, title? | the home agent (the booking is made on approval) | waiting on them          |
| `no_reply`     | reason?                        | takes effect on approval                         | done                     |
| `make_it_work` | title, brief?, project?        | the home agent                                   | waiting on the item      |
| `handover`     | to, note?                      | the home agent                                   | waiting on a third party |
| `snooze`       | until                          | takes effect on approval                         | waiting until the date   |
| `nudge`        | text                           | the home agent                                   | waiting on them          |
| `ignore`       | reason?                        | takes effect on approval                         | ignored                  |

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
proposed it to change it. It works on the types with text: `reply`, `reply_book`, `nudge`,
`handover` and `make_it_work`.

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
   thread, the new messages, `calendar_free` and the context, then for each open proposal
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

### Bookings (`reply_book`, item w9SAf)

Approving a `reply_book` outcome also books the meeting, in the same batch: `approveOutcome`
adds a `calendarUpsert` as the member, for the member's own calendar in this organization
(source `hivenod`, sourceEventId = the outcome id, so `bookingEventId(member, outcomeId)` finds
it; title = `title` or "Meeting with <with>"; attendees from `with`). The member's busy time is
updated with it, so `calendar_free` sees the slot taken at once. The home agent then sends the
reply and the invite, mirrors the event to the source calendar and reports `outcome_done`.

**Mirroring the booking (item fJnu6).** The home agent creates the meeting in the member's own
calendar with its own access (for the personal agent in the Personal organization: their Google
Calendar, inviting the people in `with`; Hivenod never connects to Google). Then it calls
`calendar_mirror` (`hivenod calendar mirror <outcomeId> <sourceEventId> [--source google]`) with
that calendar's event id. In one batch (`calendarMirror`), the booking becomes that event: the
`hivenod` event is soft-deleted and its busy block freed, and the same meeting is saved as
`google/<event id>` with its busy block. So the agent's next calendar sync updates it instead of
counting the meeting twice. It is refused unless the outcome is an approved (or done)
`reply_book`, and calling it again changes nothing. Pass `--from/--to` (MCP `start`/`end`) or
`--title` only when the calendar changed the meeting. Then it sends the reply and reports
`outcome_done`. The order for the personal agent:

1. `inbox_list`: the approved `reply_book` outcomes it carries out (`toCarryOut`).
2. Create the event in Google (its fields: `start`, `end`, `title` or "Meeting with <with>",
   attendees from `with`), with the invites.
3. `calendar_mirror` with the Google event id.
4. Send the reply (`text`) on the thread's channel, as the member.
5. `outcome_done` with the reply's permalink.

### Plans (item qwFAWxZM5xkcE7PPjAzi)

An agent may propose a **plan** instead of one outcome: an ordered list of 1-8 steps for a
thread. Each step is an `inboxOutcomes` doc with `planId`, so it keeps everything an outcome
has (fields, note, confidence, checks, versions, Ask for changes, Edit on approve). The plan doc
holds the order (`steps`) and whose turn it is (`cursor`). The pure model is
`packages/shared/src/plans.ts` (`planView`, `singlePlanView`, `planThreadState`); the actions are
in `inbox.ts`.

- **Step types.** A plan may hold reply, reply_book, book, nudge, handover, make_it_work, snooze
  (as "wait until") and approval, never no_reply or ignore. `approval` (kind `human`: what,
  detail?, link?) is a gate the member decides; `book` (start, end, with, title?) books without a
  reply. Both are plan-only: `outcome_propose` refuses them alone.
- **Proposing** (`proposePlan`, agent): the plan, its steps and one `plan.proposed` event in one
  batch, so the member never sees half a plan. The thread goes to Your call.
- **Approving.** `approvePlan` (`plan.approved`): every proposed agent step is approved at the
  version on show, unedited; gates and steps being revised are left as they are; booking steps
  book on approval, as `reply_book`. `approveOutcome` approves one agent step any time before it
  runs (with Edit and a chosen version). Approving early never runs a step early.
- **Order.** A step is carried out only at the cursor (the rules refuse any other), and
  reporting it done moves the cursor by exactly one. A gate is decided only at its
  turn and only by the member: Approve marks it done and moves the cursor; Not approved
  (`rejectOutcome`) stops the plan and the thread goes back to investigating.
- **Build it.** `finishOutcome` with status `started` and the item id puts a `make_it_work` step
  in `running` (the thread waits on the item); `done` later moves the plan on.
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
  the cursor that needs the member → Your call; Build it running → waiting on the item; a wait
  until → waiting until its date; an approved agent step → the last agent step's after-state
  (Your call for the first); all through → the last agent step's after-state; stopped →
  investigating.
- **Batch size.** Approve plan and Reject plan with 8 steps (all bookings) fit in one batch: the
  rules tests run the worst case on the emulator (within Firestore's 20 reads per batch).

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
  - wake a thread whose date has passed;
  - report outcomes they carry out, but only after approval;
  - retitle threads.
- **The member** can:
  - answer questions;
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
- **Tests:** `packages/shared/rules/inbox.test.ts`, `inboxrevise.test.ts`, `inboxrecheck.test.ts`, `inboxrelations.test.ts` and `plans.test.ts`. The `inbox: …`, `recheck: …` and `plans: …` mutations in
  `packages/shared/rules/mutate.mjs` are all caught.

## Agent tools (MCP and Go CLI)

| Tool                  | CLI                                     | What it does                                                                                                                                                                |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox_add`           | `hivenod inbox add`                     | Brings a message in. It's for `member`, by default the person who connected the agent. Repeats are reported as duplicates.                                                  |
| `inbox_list`          | `hivenod inbox list`                    | Lists what agents have to do: `toWork`, `toCarryOut` (approved outcomes this agent carries out) and `toWake`.                                                               |
| `thread_read`         | `hivenod thread read ID`                | Shows one thread: messages, subject, outcomes and decisions, notes and Q&A, and what to do next.                                                                            |
| `subject_list`        | `hivenod subject list`                  | Lists a member's subjects, with how many threads wait for them and how many are open.                                                                                       |
| `subject_assign`      | `hivenod subject assign ID`             | Files or moves a thread under an existing subject or a new one. A matching name reuses the existing subject.                                                                |
| `subject_search`      | `hivenod subject search …`              | Finds a member's subjects by name, people, channel and thread text, with filters (see "Finding subjects").                                                                  |
| `subject_relate`      | `hivenod subject relate A B`            | Proposes two subjects as related, with a note. The member OKs or turns it down.                                                                                             |
| `inbox_note`          | `hivenod inbox note ID`                 | Adds an investigation note to the timeline.                                                                                                                                 |
| `inbox_ask`           | `hivenod inbox ask ID`                  | Asks the member a question. The thread waits in Needs you.                                                                                                                  |
| `outcome_propose`     | `hivenod outcome propose ID`            | Proposes an outcome of a type from the registry, with its fields. With `revises` (`--revises OID`): that outcome's next version.                                            |
| `plan_propose`        | `hivenod plan propose ID`               | Proposes a plan: 1-8 ordered steps in one call (`--steps-file F`, `-` for stdin). See "Plans: the agent side".                                                              |
| `outcome_done`        | `hivenod outcome done OID`              | The executor reports an approved outcome as done or failed; a Build it plan step as `started` (with its `itemId`) first.                                                    |
| `thread_wake`         | `hivenod thread wake ID`                | Wakes a snoozed thread whose date has come.                                                                                                                                 |
| `thread_flag`         | `hivenod thread flag ID`                | Marks a thread urgent (or not, `urgent: false` / `--off`): the notifier pings the member at once, whatever the quiet hours.                                                 |
| `thread_due`          | `hivenod thread due ID ISO`             | Sets the deadline a message states (ISO 8601 with its offset), or clears it (`due: null` / `--clear`). Today ranks by it.                                                   |
| `thread_recheck_done` | `hivenod thread recheck-done ID RESULT` | Answers the member's re-check: `still_good` (stamps the open proposals), `revised` (after `outcome_propose revises`) or `asked` (after `inbox_ask`), with an optional note. |

### Decision data (item kt3E7u9EliL3q2veDDI0)

What the member's Today page needs to rank and explain a decision. All of it is optional, so
older records stay valid.

- **`note`**: the agent's why, 1-2 sentences. The member reads it first.
- **`confidence`** (`outcome_propose`, CLI `--confidence`): `high`, `medium` or `low`, shown as
  "Sure", "Likely" or "Unsure" with a 3-bar meter. Use `high` only when every fact the outcome
  relies on is verified, and `low` when guessing what they want. Written only on create.
- **`checks`** (`outcome_propose`, CLI `--check`, repeatable): what the agent verified, at most 6
  lines of 1-200 characters, e.g. "Your calendar: Thu 10:00-11:00 free".
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
  retries, skips or stops). A `make_it_work` step (Build it) is reported `started` with
  `result.itemId` once the item is made (the step is `running`, the thread waits on the item),
  then `done` when the item is Done.
- **Build it** (slice 6): `outcome_done status started` checks that the item exists in a project
  the agent may use and, without a permalink, fills in the item's link
  (`<site>/p/<project>?item=<item>`). The channel then watches the item (once a tick): when it is
  **Done** it sends `item_done`; when it is stopped, archived or deleted, `item_stopped` (each
  once, with `outcome_id`, `item_id`, `plan_id` and `step`). The agent reports the step done, or
  failed with the reason (the plan is then blocked: Retry, Skip, Stop). Single `make_it_work`
  outcomes are unchanged (done when the item is made).
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
  scenario "plans (item qwFAW)" in `cli/e2e/test/go.test.ts` runs a 4-step plan (reply, approval,
  Build it, reply) through the Go CLI against the rules, and `channel.test.ts` checks one
  `carry_out` per step at its turn.
- An older CLI sends `carry_out` for every approved step at once: `EVENT_MIN_VERSION.plan`
  (`cliversion.ts`) is the first CLI that handles plans, for the web app's hint.

## Channel events (part 2)

A channel session (`hivenod mcp --channel`, `cli/internal/hive/inboxfeed.go`) pushes `<channel source="hivenod" kind="inbox">` events for
the threads that need agent work. They don't count toward `max_items` and are never claimed:
the event carries the thread to work, and the channel instructions say to keep development items
first. (In Claude Code, the plugin's `hivenod` skill runs each thread in a background sub-agent of its own.)

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
- **A nudge due** (`nudge_due`) also goes to the home agent: the thread has waited on them for
  `nudgeAfter` (3 days) since its last change. Noting why not (`inbox_note`) restarts the wait.
- **Carrying out an approved outcome** (`carry_out`, with `outcome_id` and `outcome_type`) goes
  to its executor, which the rules fix to the home agent. A plan step is sent only at its turn:
  the session also listens to the workspace's live plans (`inboxPlans`, state proposed, active
  or blocked) and sends a step's `carry_out` only when it is at its plan's cursor and the plan
  runs (not blocked). A step approved ahead waits; when the step before it is done (or the gate
  before it passed) the cursor moves and its `carry_out` follows. A `make_it_work` step's text
  says to report `started` with the item first.
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
  done, ignore it, bring it back, mark it urgent or not (`flagThread`), and **Make it work**.
  An approved `reply_book` shows the slot it booked.
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
- **Build it** (slice 6, `BuildItCard.tsx`): a `make_it_work` step reported `started` shows the
  item it made: its project, title, the step it is at (or "Done: the agent reports it next") and
  **Open** (same organization). The item is found through the step's link
  (`<site>/p/<project>?item=<item>`, filled in by the CLI); a member who cannot read that project
  sees what the step asked for and the item's id. The plan waits until the agent reports the step
  done. Build it steps need a CLI that sends `item_done` (`EVENT_MIN_VERSION.item_done`): the
  plan's update notice covers it.
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
- **Make it work** (the member's own): `makeItemFromThread` creates a Hivenod item with
  `createItem`, the member as its creator, in one of their projects of the thread's
  organization, and links it on the thread's timeline with a `thread.itemMade` event in the
  same batch. The rules accept that event only for the member's own thread and an item they
  created in that batch. The thread itself does not change.
- Every query filters on `memberUid == me`; the rules allow nothing wider.

## Notices (notifier)

A thread arriving at **Needs you** (an agent's question) or **Your call** (outcomes proposed)
tells its member alone: a bell entry (`inboxAsk`, `inboxCall`; `projectId` is `inbox`, `itemId`
the thread) and push and Telegram, linking to the thread page. One arrival is one notice: a new
question, or a new round of proposals after the earlier ones were decided, is a new arrival.
A thread with `urgent: true` (`thread_flag`, or the member's Mark urgent) skips quiet hours and
the summary.

## Still to come

- **Later slices:** personal Google sync, and
  per-workspace auto-OK per outcome type.
