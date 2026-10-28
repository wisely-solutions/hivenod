# Inbox

Item 4PEHrOW5IfXBQWgOK9wo, slice (a). Incoming requests (Teams, mail, Jira or GitLab mentions,
Telegram, …) that a workspace's agents bring in for a member. They're filed under lasting, named
subjects, drafted by an agent in the member's voice, and sent **only after the member presses
Send**. Hivenod itself connects to no external inbox: agents bring the requests in and post the
replies.

## Records

All three collections live under the organization (`workspaces/{wid}`). They're separate from
projects and items. Code: `packages/shared/src/inbox.ts`.

```
inboxRequests/{rid}   memberUid, subjectId|null, status, source, sender{name, handle|null}, text,
                      threadRef, messageId, permalink|null, replyRef|null, receivedAt, attachments[{name, url}],
                      draft{reply, actions[], by{type,id}, at}|null, approved{reply, actions[], byUid, at}|null,
                      sent{permalink|null, by, at}|null, fetchedBy (agent uid), createdAt, updatedAt, lastEventId
inboxSubjects/{sid}   memberUid, name (1-120), createdBy{type,id}, createdAt, updatedAt, lastEventId
inboxEvents/{eid}     actor{type,id,name}, memberUid, requestId|null, subjectId|null, type, data{}, at   (create-only)
```

- **Flow:** `new` (an agent brought it in) → `drafting` (filed under a subject) → `yourCall` (a
  draft is waiting for the member) → `sending` (the member pressed Send) → `done` (the fetching
  agent posted it), or `ignored`. An ignored request can be brought back.
- **Dedup:** the request id is `rq` + the first 24 hex digits of
  SHA-256(`source \0 threadRef \0 messageId`). The same input twice is the same document. The
  rules allow a create only, never an overwrite. `messageId` defaults to the `receivedAt`
  milliseconds.
- **Subjects** have no open or closed state. "Waiting" means requests at `yourCall`; "open" means
  `new`, `drafting`, `yourCall` and `sending`. Both are counted from the requests, not stored.
  Merging moves every request of one subject into another and deletes the emptied subject. Its
  tombstone event is `del-subject-<sid>`. Splitting moves the picked requests into a new
  subject.
- **Timeline:** a subject's timeline is the inbox events of its requests (by `requestId`) plus
  its own events (by `subjectId`). Drafts, the approved text and the sent link are kept in the
  event data.

## Rules (firestore.rules, "inbox")

- **Who reads:** a request, a subject and an inbox event can be read only by the member in
  `memberUid` (while they're in the organization) and by the organization's non-revoked agents.
  Admins and other members can't read them. Members list with `where('memberUid', '==', uid)`.
- **Agents:** they add requests for a member of their organization (as `fetchedBy`, status
  `new`). They file a request under a subject of the same member and draft its reply (not
  before it's filed). They mark a request `done` only when it's `sending` and they're its
  `fetchedBy`.
- **Members:** they edit the draft, Send (`sending`, with `approved` equal to the draft as it
  stands), ignore and bring back their own requests. They rename, merge and split their own
  subjects.
- **Send-only:** agents never write `approved` or `sending`, so nothing goes out without the
  member's Send.
- **Tracking:** inbox writes are tracked in `inboxEvents` (one per batch, `actor.id ==` the
  caller, `at == request.time`). They never go to the organization-wide `events`, which every
  member can read.
- Tests: `packages/shared/rules/inbox.test.ts`. Mutations: "inbox: …" in
  `packages/shared/rules/mutate.mjs`.

## Agent tools (MCP, Go CLI and TS agent)

| Tool             | CLI                         | What it does                                                                                                                            |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox_add`      | `hivenod inbox add`         | Brings a request in. It's for `member`, or by default for the person who connected the agent. A repeat is reported as a duplicate.      |
| `inbox_list`     | `hivenod inbox list`        | Lists what agents still have to do: `toFile`, `toDraft`, and `toSend` (approved requests this agent brought in).                        |
| `inbox_read`     | `hivenod inbox read ID`     | Shows one request in full: its subject, the other requests in that subject (with the replies sent), and `next`.                         |
| `subject_list`   | `hivenod subject list`      | Lists a member's subjects, with their waiting and open counts.                                                                          |
| `subject_assign` | `hivenod subject assign ID` | Files a request under an existing subject (`subjectId`) or a new one (`name`). A name matching an existing subject reuses that subject. |
| `inbox_draft`    | `hivenod inbox draft ID`    | Writes the proposed reply (plus follow-up `actions`). It waits for Send.                                                                |
| `inbox_sent`     | `hivenod inbox sent ID`     | Marks a request sent, after the fetching agent posted `approved.reply`.                                                                 |

Contract: `cli/contract/cases.ts` covers the agent actions. `packages/agent/test/go.integration.test.ts`
runs the inbox scenario through both CLIs and checks that the results and documents are equal.

## Still to come

- Part 2: `inbox` channel events, which reach the workspace's main agent outside `max_items`.
- Part 3: the Inbox view (per workspace and across workspaces), Send · Edit · Ignore, rename,
  merge, split, "Make it work", and notifier notices.
- Later slices: the Calendar and personal Google sync.
