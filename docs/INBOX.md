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
inboxSubjects/{sid}   memberUid, name, createdBy{type,id}, createdAt, updatedAt, lastEventId
inboxThreads/{tid}    memberUid, subjectId|null, state, waiting{on, until|null}|null,
                      question{text, by, at, answer|null, answeredAt|null}|null, title, refs[],
                      lastMessageAt, fetchedBy (the home agent), createdAt, updatedAt, lastEventId
inboxMessages/{mid}   memberUid, threadId, direction in|out, source, sender{name, handle}, text,
                      threadRef, messageId, permalink, replyRef, receivedAt, attachments[{name,url}],
                      fetchedBy, createdAt, lastEventId
inboxOutcomes/{oid}   memberUid, threadId, type, fields{}, state, note, proposedBy, executor|null,
                      decision{byUid, at, edited, reason}|null,
                      result{text, permalink, itemId, error, by, at}|null, createdAt, updatedAt, lastEventId
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

The initial types:

| Type           | Fields                  | Carried out by           | Thread state when done   |
| -------------- | ----------------------- | ------------------------ | ------------------------ |
| `reply`        | text, holding?          | the home agent           | waiting on them          |
| `reply_book`   | text, slot, with        | the home agent           | waiting on them          |
| `no_reply`     | reason?                 | takes effect on approval | done                     |
| `make_it_work` | title, brief?, project? | the home agent           | waiting on the item      |
| `handover`     | to, note?               | the home agent           | waiting on a third party |
| `snooze`       | until                   | takes effect on approval | waiting until the date   |
| `nudge`        | text                    | the home agent           | waiting on them          |
| `ignore`       | reason?                 | takes effect on approval | ignored                  |

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
  - wake a thread whose date has passed;
  - report outcomes they carry out, but only after approval;
  - retitle threads.
- **The member** can:
  - answer questions;
  - approve, edit and reject outcomes;
  - ignore, close and bring back threads;
  - move threads between subjects;
  - rename, merge and split subjects.
- **Related subjects:** agents of the organization propose links between two subjects of the
  same member; only that member relates, accepts, turns down and removes them.
- **Approval:** agents never write `approved` or a decision, so nothing is carried out without
  the member's OK.
- **Tracking:** every inbox write is tracked in `inboxEvents`, never in the organization-wide
  `events`, which every member can read.
- **Tests:** `packages/shared/rules/inbox.test.ts` and `inboxrelations.test.ts`. The `inbox: …` mutations in
  `packages/shared/rules/mutate.mjs` are all caught.

## Agent tools (MCP, Go CLI and TS agent)

| Tool              | CLI                          | What it does                                                                                                               |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `inbox_add`       | `hivenod inbox add`          | Brings a message in. It's for `member`, by default the person who connected the agent. Repeats are reported as duplicates. |
| `inbox_list`      | `hivenod inbox list`         | Lists what agents have to do: `toWork`, `toCarryOut` (approved outcomes this agent carries out) and `toWake`.              |
| `thread_read`     | `hivenod thread read ID`     | Shows one thread: messages, subject, outcomes and decisions, notes and Q&A, and what to do next.                           |
| `subject_list`    | `hivenod subject list`       | Lists a member's subjects, with how many threads wait for them and how many are open.                                      |
| `subject_assign`  | `hivenod subject assign ID`  | Files or moves a thread under an existing subject or a new one. A matching name reuses the existing subject.               |
| `subject_search`  | `hivenod subject search …`   | Finds a member's subjects by name, people, channel and thread text, with filters (see "Finding subjects").                 |
| `subject_relate`  | `hivenod subject relate A B` | Proposes two subjects as related, with a note. The member OKs or turns it down.                                            |
| `inbox_note`      | `hivenod inbox note ID`      | Adds an investigation note to the timeline.                                                                                |
| `inbox_ask`       | `hivenod inbox ask ID`       | Asks the member a question. The thread waits in Needs you.                                                                 |
| `outcome_propose` | `hivenod outcome propose ID` | Proposes an outcome of a type from the registry, with its fields.                                                          |
| `outcome_done`    | `hivenod outcome done OID`   | The executor reports an approved outcome as done or failed.                                                                |
| `thread_wake`     | `hivenod thread wake ID`     | Wakes a snoozed thread whose date has come.                                                                                |

The contract tests cover the agent actions: `cli/contract/cases.ts` against the Go actions, and
`packages/agent/test/go.integration.test.ts`, which runs the inbox scenario through both CLIs on
the emulators and requires equal results and documents.

## Still to come

- **Part 2:** `inbox` channel events to the organization's main agent, outside `max_items`.
- **Part 3:** the Inbox view (per workspace and across workspaces), decisions on outcomes,
  rename, merge, split and move, and notifier notices, including urgent pings.
- **Later slices:** the Calendar (which completes `reply_book`), personal Google sync, and
  per-workspace auto-OK per outcome type.
