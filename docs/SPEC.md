# Hivenod v1 build spec

> Source of truth for building Hivenod v1 (written 2026-10-23, kept up to date as features land).

## 1. What we are building

Hivenod is a project board where **agents do the work and humans make the decisions**. v1 makes the 7 designed screens real:

1. **Needs you**: decision inbox across projects
2. **Board**: a project's process as columns, with agent columns folded and human gates highlighted
3. **Projects**: all projects, plus new from a template
4. **Send back**: reject with a mandatory reason and choose the target step
5. **Decision insights and log**
6. **Full-page review + found while working**
7. **Who decides**: deciders and approval rules per gate

On top: **agents log in with a named token**, and **everything an agent does is tracked** (runs, time, cost, every change).

**Out of scope for v1 ("no integrations"):** Telegram, email, GitHub, Slack, web push, payments, Cloud Functions. In-app notifications only (badge, live updates). The agent interface is Hivenod's own CLI/MCP, which is part of Hivenod, not an integration.

## 2. Quality bar (non-negotiable)

UX and UI must feel like the best apps online (Linear, Things, Arc, Vercel). Slick, but never slower to use.

- **Fast:** Lighthouse mobile ≥ 95 on Performance, Accessibility and Best practices. LCP < 1.8 s on a mid-range phone over 4G. INP < 150 ms. Initial JS ≤ 180 KB gzipped (route-split everything else).
- **Instant feel:** optimistic UI on every action. Live updates via Firestore listeners. Skeletons only if loading takes > 300 ms. Never a full-page spinner.
- **Mobile first, truly:** every screen designed for 375 px wide first. One-thumb reach for primary actions. Gestures with button fallbacks. Installable PWA. See §8.
- **Accessible:** WCAG 2.2 AA. Full keyboard support, visible focus, screen-reader labels, colour never the only signal. `prefers-reduced-motion` respected everywhere.
- **Light and dark** themes from day one (follow the system, with a manual toggle).
- **Copy:** short, plain English, sentence case. Verbs on buttons ("Approve → Plan", "Send back to Draft"). No jargon, no exclamation marks.
- **Evidence in Review:** every build card goes to Review with a preview URL plus screenshots at 375 px and 1440 px, light and dark, and a short screen recording (GIF/MP4) for any interaction with motion.

## 3. Tech stack (decided)

| Area | Choice |
|---|---|
| Repo | `wisely-solutions/hivenod`, pnpm workspaces: `apps/web`, `packages/shared`, `packages/agent` |
| Web | React 19 + TypeScript (strict) + Vite |
| Routing | TanStack Router (typed routes, route-level code splitting) |
| Styling | Tailwind CSS v4 with CSS-variable design tokens (§7) |
| Primitives | Radix UI (dialog, popover, dropdown, tooltip, tabs) |
| Motion | Motion (`motion` package) for springs and layout animations; View Transitions API for route changes (with fallback) |
| Sheets | `vaul` (drag-to-dismiss bottom sheets) |
| Drag and drop | `@dnd-kit` |
| Command palette | `cmdk` |
| Data | Firebase JS SDK (modular): Auth, Firestore with persistent local cache (offline reads) |
| Schemas | Zod in `packages/shared` (used by the web app, the agent CLI and the tests) |
| Agent client | Node 22 CLI `hivenod` + MCP stdio server, in `packages/agent` |
| Tests | Vitest + Testing Library; `@firebase/rules-unit-testing` against the emulator; Playwright E2E (3 phone viewports + desktop) |
| Hosting | Firebase Hosting, project `hive-board-43be` (sites `hivenod` = https://hivenod.com, the only public address, and `hive-board-43be` = old address, 301 to https://hivenod.com except `/cli/**`; see docs/DEPLOY.md); preview channels per card (`firebase hosting:channel:deploy card-<n>`) |
| CI | GitHub Actions: lint, typecheck, unit, rules and E2E tests on every PR |

**Platform limits (Spark free plan, no billing):** no Cloud Functions, no Cloud Storage. So:
- All logic runs in the client (or agent CLI) and is **enforced by Firestore security rules**.
- Attachments are stored **inline in Firestore** (HTML, Markdown, text, and images/PDFs as data URLs) up to **900 KB each**. Anything larger is attached as a link.
- Free quotas: 50k reads/day, 20k writes/day. Design listeners to be narrow (per project, per user inbox) and paginate logs.

## 4. Concepts

- **Organization**: the top level; holds members, groups, agents and projects. (Stored at `workspaces/{wid}`: it began life as the "workspace" and the path was kept so no data had to move.) A person can belong to many organizations, like GitHub, and switches between them. A first organization is created on first sign-in; more can be made any time. People join by an email invite link.
- **Member**: a human (Google sign-in) in an organization. Roles: `admin` and `member`. The creator is an admin. Admins see and manage everything in the organization (members, roles, groups, agents, every project and who is on it). The organization always keeps at least one admin. A plain member sees **no project** until an admin adds them to it.
- **Group**: a named set of members (e.g. Product, Leadership). Used by gates.
- **Agent**: a named non-human identity that logs in with a token (§6). Has a colour, an avatar initial and allowed projects.
- **Project**: has a **process** (ordered steps), items, its spend (shown only, from agent-reported cost; Hivenod has no budgets or spending limits, card KJh1RxSl) and **people** (`memberUids`): who may see it besides the admins. Agents are scoped per project (`projectIds`), unchanged.
- **Step**: `kind: agent | human`.
  - An agent step has instructions and expected outputs.
  - A human step is a **gate**, with deciders and a rule.
- **Item**: a unit of work moving through the steps (idea, request, bug, finding, task).
- **Run**: one agent working one item at one step: start, heartbeats, log lines, attachments, reported cost, end.
- **Decision**: a human outcome at a gate: `approved | sentBack | stopped | answered`, with rationale (mandatory for send back/stop) and tags.
- **Finding / suggestion**: something an agent noticed outside its task. It is created as an item of type `finding` with status `suggested` at the project's first step (no claim, no gate), linked to the item it was found on (and the run, when the agent held that item). A suggestion is **not work**: it never appears in `work list` / `wait_for_work` and cannot be claimed. Any agent allowed on the project can raise one; it does not have to hold the item. People who may triage (see below) **Add to <first step>** (it becomes a normal item there and agents can pick it up), **Add to this item** (from the review panel), or **Dismiss** with a reason (10+ characters, kept in the `finding.triaged` event so agents learn what is not wanted). Card TU5pDmzE. Findings filed before this were moved to `suggested` by `scripts/migrate-suggestions.mjs` (dry run by default, writes a backup, `--rollback <file>` restores); triaged ones were left as they were.
- **Who triages suggestions** (`canTriage`, one rules function mirrored by `packages/shared/src/suggestions.ts`): organization admins, the project's creator, and the deciders of the first step when it is a gate. Assumption pending João's confirmation; change it in those two places only.
- **Event**: an append-only record of every change by anyone (§5.3). This is the tracking backbone.

## 5. Data model (Firestore)

All documents are validated with the Zod schemas in `packages/shared/schema.ts`. Timestamps are `serverTimestamp()`.

```
users/{uid}                          name, email, photoURL, color, workspaceId (the organization on screen),
                                     workspaceIds[] (every organization joined), theme
workspaces/{wid}                     name, ownerUid (creator), memberRoles{uid: 'admin'|'member'},
                                     adminUids[] (the admins in memberRoles, so rules can guard the last one), createdAt
workspaces/{wid}/members/{uid}       name, email, photoURL, color   (the card others in this org see; written by the person)
workspaces/{wid}/invites/{code}      email, role ('admin'|'member'), createdBy, expiresAt, usedBy?
workspaces/{wid}/groups/{gid}        name, memberUids[]
workspaces/{wid}/agents/{agentUid}   name, color, projectIds[] | '*', createdBy, createdAt,
                                     revokedAt?, lastSeenAt?, tokenHint ('…a7f3'),
                                     guardrails?{maxFailedRuns (3)}  (older docs also hold maxTokensPerItem: ignored),
                                     permissions?[] (legacy, ignored, never written), failStreak?,
                                     pausedAt?, pausedReason?   (optional: absent = defaults, card zSzW3LXy)
workspaces/{wid}/projects/{pid}      name, emoji, color, templateId,  (older docs also hold budgetEur: ignored, never written)
                                     steps[] (see Step), memberUids[] (who may see it besides admins),
                                     stepAgents?{agentStepId: agentUid[]} (per-step allowed agents),
                                     createdBy, createdAt, archivedAt?
  Step: { id, name, kind:'agent'|'human', description, instructions?, outputs[]?,
          gate?: { deciderUids[], groupIds[], rule:'any'|'atLeast'|'all'|'specific',
                   n?, mustInclude[], rejectPolicy:'one'|'majority', remindAfterHours } }
  (deciderUids is the resolved union of people + group members, recomputed on save)
.../projects/{pid}/items/{iid}       title, type, stepId, status:'queued'|'working'|'waiting'|'done'|'stopped'|'suggested',
                                     summary, source{kind,label}, createdBy{type,id}, parentItemId?,
                                     claim?{runId, agentUid, heartbeatAt}, progress?{done,total},
                                     gate?{stepId, approvals{uid:{at,rationale}}, rejections{uid:{at,rationale}}},
                                     sendBackCount, costEur, order, updatedAt, lastEventId,
                                     awaitingAnswer?{questionId, agentUid, at, reason?: 'tokenLimit'}  (held for people's answer; a legacy reason is read as an ordinary question, nothing writes it any more),
                                     workStopped?{mode:'back'|'cancel', byUid, at, reason (≤ 500), runId}  (Stop work, card BrK0r2FE)
.../items/{iid}/attachments/{aid}    kind:'html'|'markdown'|'text'|'image'|'pdf'|'link', name, content?|url?,
                                     bytes, runId?, by{type,id}, at
.../items/{iid}/messages/{mid}       by{type,id}, kind:'question'|'answer'|'note', text, at, answered?
.../projects/{pid}/decisions/{did}   itemId, itemTitle, stepId, outcome, toStepId?, byUid, rationale, tags[], at
workspaces/{wid}/runs/{rid}          agentUid, projectId, itemId, stepId, startedAt, heartbeatAt, endedAt?,
                                     status:'running'|'done'|'failed'|'released'|'stopped', costEur, tokensIn, tokensOut,
                                     stoppedBy?{uid, name} (status stopped: a person pressed Stop work),
                                     tokensCached? (part of tokensIn read from cache), model?, summary?
workspaces/{wid}/runs/{rid}/log/{n}  at, level, text            (agent log lines, max 500 per run)
workspaces/{wid}/events/{eid}        actor{type:'human'|'agent', id, name}, projectId?, itemId?, runId?,
                                     type, data{}, at
```

**Inbox** (item 4PEHrOW5IfXBQWgOK9wo): `workspaces/{wid}/inboxSubjects`, `inboxThreads`,
`inboxMessages`, `inboxOutcomes` and `inboxEvents` (its own create-only tracking log), private to
the member each belongs to and the organization's agents. See [INBOX.md](INBOX.md).

### 5.1 Security rules (the backend)

The rules in `firestore.rules` are the backend. Rules tests must cover every allow and deny below.

- Only organization members (humans) and non-revoked agents of the organization can read.
- **Project privacy.** A project, its items, messages, decisions, attachments, runs and project events can be read and written only by the organization's admins and by the people in the project's `memberUids` (and by agents in their `projectIds`). A plain member who is not listed cannot read any of it. Lists are queried per member with `memberUids array-contains uid` (projects) or per `projectId` (runs, events, cross-project questions and decisions); organization-wide queries are for admins.
- **Roles.** Only an admin changes roles, removes people, invites, renames the organization or changes a project's people. One role change per write, and `adminUids` must follow `memberRoles`; the last admin can be neither demoted nor removed. A member can create a project only for themselves (`memberUids == [uid]`); an admin can create one for anyone.
- **Many organizations.** `users/{uid}.workspaceIds` grows by one organization per write, and only with one the person belongs to. Names and pictures of other people are read from `workspaces/{wid}/members/{uid}`, never from `users`.
- Agents can only read/write projects in their `projectIds` (or all if `'*'`).
- **Agents cannot decide.** They can never write `gate.approvals`, decisions, or move an item out of a human step.
- Agents can claim an item at an **agent step** if it is unclaimed, or if the claim is stale (`heartbeatAt < request.time - 10 min`). They can heartbeat and release only their own claim, and move an item **forward one step** when completing.
- Humans can decide at a gate only if `request.auth.uid in step.gate.deciderUids`.
- An item may advance past a gate only if the approvals map satisfies the rule:
  - `any`: ≥ 1
  - `atLeast`: ≥ n
  - `all` / `specific`: `hasAll(deciderUids)`
  - always also `hasAll(mustInclude)`

  This is checked in rules against the project's step definition.
- A send back with `rejectPolicy:'one'` is allowed for any single decider. With `'majority'`, rejections must exceed half of deciderUids.
- Only an `admin` can manage members, groups, agents and project deletion.
- Agent tokens: an agent with `revokedAt` set is denied everything (including reads).
- **Agent settings and guardrails (card zSzW3LXy).** An agent's settings (projects, guardrails) and resuming a paused agent are admin-only. Which agents may do a project's agent steps (`project.stepAgents`) changes only by admins and the project's creator (`canSetStepAgents` in the rules, mirrored by `canEditAgentSettings` in `packages/shared/src/agents.ts`); anyone who edits the process may still drop the limit of a step the save removes. A step limited to some agents is claimable by those agents only (empty or missing = any agent allowed on the project). A paused agent claims nothing. The agent keeps its own `failStreak` in the batch that ends one of its runs: a done run resets it, a failed run adds exactly one and, at `maxFailedRuns`, must set `pausedAt` (paused); a released run does not count. Only an admin clears a pause; nobody pauses by hand (revoke stays the stop switch). A heartbeat may carry the run's token usage so far (counters only grow, `tokensCached ≤ tokensIn`). All new fields are optional, so agents and projects from before need no migration.
- **Stop work (card BrK0r2FE).** Admins and the deciders of any gate of the project (João, Q23; `canStopWork` in the rules, mirrored by `stopGateFor` in `packages/shared/src/stopwork.ts`; a non-admin's action names that gate in its event, `gateStepId`) may stop an agent's work on a claimed item at an agent step: in one batch the claim is cleared, the claimed run ends as `stopped` with `stoppedBy` = them (unless it had already ended), the item gets `workStopped` and goes to `queued` (Go back: on hold) or `stopped` (Cancel completely), with an `item.workStopped` event (and, for Go back with a reason, a note for the next agent). No agent claims an item whose `workStopped` is set (rules `claimIt`), so a held one waits until Resume (`item.resumed`, same people) clears it. A stop never touches the agent's failure streak. Optional fields: no migration.

### 5.2 Writes are batches

Every user or agent action is a single batched write (or transaction):
1. the domain change (item, decision, attachment…), with `lastEventId` set
2. **one event doc** at `events/{lastEventId}`

### 5.3 Tracking is enforced, not optional

Rules require that any write to an item/project/decision/run includes an event doc in the same batch. Use `existsAfter(events/$(request.resource.data.lastEventId))`, and the event's `actor.id == request.auth.uid` and `at == request.time`.

Events are **create-only** (no update/delete for anyone). So nothing an agent (or person) does can go untracked or be rewritten.

Event types:
- `item.created`, `item.moved`, `item.claimed`, `item.released`, `item.completed`, `item.updated`, `item.workStopped` (data: mode back|cancel, reason, agentUid, gateStepId?), `item.resumed`
- `attachment.added`, `message.posted`
- `decision.approved`, `decision.sentBack`, `decision.stopped`, `decision.answered`
- `finding.raised`, `finding.triaged`
- `run.started`, `run.heartbeat` (coalesced: at most one event per 5 min), `run.ended`
- `agent.created`, `agent.revoked`, `agent.rotated`, `agent.updated` (settings changed, or `resumed: true`). A run end that pauses the agent says `agentPaused: true` in its `run.ended` / `item.released` event.
- `project.created`, `project.processChanged`, `project.membersChanged`, `member.*`, `group.*`

## 6. Agent identity and tokens

**Create (Settings → Agents → "New agent", admin only)**
- Name (e.g. "Research agent"), colour, allowed projects.
- The client creates a Firebase Auth email/password user using a **secondary Firebase app instance**, so the admin stays signed in:
  - email: `agent-<random12>@agents.hive-board.app`
  - password: 32 random bytes, base64url
- The agent doc is written with id = that auth uid.

**Token**
- Format: `hive_agt_<base64url(json{w:wid,e:email,p:password})>`
- Shown **once** in a dialog with a copy button and a "Copy as env var" (`HIVENOD_TOKEN=…`) button. The UI says it cannot be shown again. Only `tokenHint` (last 4 characters) is stored.

**Revoke**
- Sets `revokedAt`. Rules deny everything immediately; any running claims show "Agent revoked".

**Rotate**
- Revokes the old agent doc and creates a new identity that keeps the same name, colour and history link (`previousAgentUid`).

**Connect a terminal (pairing, card MkUwvyWs)**
- `hivenod pair` (or `hivenod run claude` when `HIVENOD_ALLOW_RUN=1`) without a token creates `pairings/{code}` (8 characters, no sign-in) holding only a fresh P-256 public key and what it runs on (cli, host, folder), and prints `https://hivenod.com/agents/connect?code=K7QX-29PD`.
- An admin opens the link (or Agents, "New agent", one guide with copy-paste steps: install the CLI, `hivenod pair`, add the plugin, start the channel session (card Ul32d6Ee), and types the code; "Advanced: plain MCP with a token" is the secondary path), checks the code matches the terminal, picks name, colour and projects, and presses Connect: the agent is created as usual, then its token is encrypted for the terminal's key (ECDH P-256 + HKDF-SHA-256 + AES-256-GCM, bound to the code) and written to the pairing doc. The admin never sees the token. If that write fails (expired, used) the new agent is revoked again.
- The terminal decrypts the token, saves it to `~/.hivenod/agent.json` (0600) and deletes the pairing doc as the new agent. Rules: anyone may create a pending request and read one by its code (listing is denied); only an admin of the organization may complete it, once, within 15 minutes, for a non-revoked agent they created with the same name; deleting: a pending one by anyone, a paired one by the agent or an admin.

**Agent page** (`/agents/:id`)
- Status: online if last heartbeat < 2 min; working on X (with tokens in/out and model of the live run); Paused.
- **Paused banner** (card zSzW3LXy): why ("3 failed runs in a row") and **Resume** for admins.
- **Settings** (Draft 1 of card wIQIiEIr): allowed projects (chips; All projects); the agent steps of those projects it may take (struck through when the step is limited to other agents; limits are set in each project's process); guardrails: stop after N failed runs in a row (default 3, 1-20), when unsure: ask in Hivenod (Needs you), the item goes back to the queue and is picked up again once answered; a read-only note says what the agent may do on its machine is set in that machine's Claude Code settings (card rifzGl8M: Hivenod stores and enforces no permissions and no token limit; usage is tracked and shown only). Admins edit and save; others read.
- Today / 7 days: runs, items completed, time working, cost, approvals first-time rate of its work, send-backs received with reasons, tokens (new, with in / out / cached) and models.
- Run list: each run expands to show its log, attachments and resulting decision, new tokens in / out, cache reads and model.

## 7. Design system

Start from the canvas design (Geist / Geist Mono, near-black ink, amber for human gates). Build tokens as CSS variables on `:root` and `[data-theme=dark]`.

**Colour (light)**
- ink `#15171B` · text-2 `#4B5160` · text-3 `#6B7280`
- surface `#FFFFFF` · canvas `#F4F5F7` · line `#E1E4EA`
- **gate / needs-you amber** `#F2B32A` (bg `#FFF7E5`, text `#9A6200`)
- **agent blue** `#2F5FD0` (soft `#F2F5FF`)
- **approve green** `#1E8E5A`
- **send-back red** `#A93622` (border `#E8B4A8`)

Dark equivalents must keep ≥ 4.5:1 contrast. Agents get a palette of 8 distinguishable colours for avatars.

**Type and shape**
- Type: Geist 13/14/16/20/28/34; Geist Mono 11 uppercase tracking .08em for eyebrows.
- Radius: 7 (buttons), 10–12 (cards), 16 (panels), 999 (pills). Spacing on a 4 px grid.
- Elevation: 3 levels, soft shadows in light mode, lighter surfaces in dark mode.

**Motion tokens**
- Durations: `fast 120ms`, `base 200ms`, `slow 320ms`.
- Standard easing `cubic-bezier(.2,.8,.2,1)`; springs `{stiffness: 500, damping: 40}` (UI), `{stiffness: 260, damping: 26}` (sheets).
- Everything animates transform/opacity only (60 fps). Under reduced motion: cross-fade only, no movement.

**Signature interactions** (all have a non-gesture equivalent)
1. **Decide flow:** the "Approve" button morphs into a check, the item collapses out of the inbox, and the next item slides up into focus. A 5 s **Undo** toast appears; the write is committed when the toast ends or on navigation, and works offline (queued).
2. **Shared-element open:** tapping an inbox/board card expands it into the detail view (layout animation); back reverses it.
3. **Folded agent columns:** slim strips showing count, animated "working" dots for live runs, a send-back badge and a progress ring. Clicking expands with a width spring; multiple strips can expand.
4. **Live presence:** a heartbeat pulse on the agent avatar while its run is alive. New items arriving in real time drop in with a soft amber highlight that fades in 2 s. Badge counts tick (number roll).
5. **Send back sheet:** the step picker is a vertical stepper. The chosen target step glows, and an animated path shows how far back the item goes.
6. **Command palette ⌘K / Ctrl K:** jump to any project, item or agent; actions ("New item", "Approve current").
7. **Keyboard:** `J/K` next/previous, `Enter` open, `A` approve, `R` send back, `Esc` close, `?` shortcut sheet.
8. **Skeleton → content cross-fade**, never a jump in layout (CLS < 0.02).
9. **Count-up and bar-grow** on insights numbers when first in view.
10. **Haptics** (`navigator.vibrate(8)`) on swipe thresholds and decisions, on devices that support it.

## 8. Mobile (top priority)

- Breakpoints: phone < 640, tablet 640–1023, desktop ≥ 1024. Design and build phone first.
- **Bottom tab bar** (phone): Needs you (badge) · Projects · Activity · Me. It hides on scroll down and shows on scroll up. Safe-area insets respected.
- **Needs you (phone):**
  - A card stack list; each card shows project, step, waiting time, agent and what it needs.
  - **Swipe right → Approve** (opens a compact rationale sheet, optional, with "Approve" as the sheet's big button); **swipe left → Send back** (opens the send-back sheet).
  - Long-press → quick actions. Filters as horizontally scrolling chips (All · Approvals · Questions · Findings).
- **Item detail (phone):**
  - Full screen, with a sticky bottom action bar (Approve → Next step · Send back).
  - The deliverable preview is a tappable card that opens the full-page viewer.
  - Agent questions show as a chat thread with an answer box above the keyboard.
- **Full-page viewer (phone):** the HTML fills the screen. A floating "Decide" pill opens a bottom sheet with findings, approvals so far, rationale and the actions. Pinch-zoom is allowed in the iframe.
- **Board (phone):**
  - One column per screen with horizontal snap scroll.
  - At the top, a **step scrubber**: pills for all steps, with agent steps as small dots and human gates as amber pills with counts. Tap to jump.
- **Process editor (phone):** a vertical list of steps; reorder by drag handle; tap a step to edit in a sheet. The "Who decides" editor is the same, in a sheet.
- **Touch:** targets ≥ 44 px; no hover-only features; inputs ≥ 16 px (no iOS zoom); the keyboard never covers the focused field.
- **PWA:**
  - manifest, icons, theme colour, standalone display, iOS meta tags, splash
  - offline read of the last data (Firestore cache) and queued writes
  - an "Install Hivenod" hint after the 2nd visit (dismissible)
  - app badge (`navigator.setAppBadge`) with the Needs-you count
- **Device test matrix (Playwright + manual screenshots):**
  - iPhone SE 375×667, iPhone 15 393×852, Pixel 7 412×915
  - iPad 820×1180, desktop 1440×900
  - Safari, Chrome and Firefox engines

- **As built (build 16):** `lib/mobile.ts` holds the shared phone behaviour.
  - Gestures: item detail swipes left/right to the next/previous item (with prev/next buttons and an "n of m" counter, the non-gesture equivalent); a pull down on the full-page viewer header leaves it; sheets close by dragging down (vaul). Swipes ignore inputs, iframes and horizontal scrollers. Edge-swipe back (left 24 px) is only wired in an installed app (`display-mode: standalone`), where the browser has no back gesture, so it never fights iOS Safari's own.
  - Keyboard: `useKeyboardAvoidance` publishes the keyboard height as `--kb` from `visualViewport`; sticky action bars, toasts and the Decide pill sit above it, the tab bar hides, and the focused field is scrolled clear of the keyboard and the bar. Textareas grow with their content (to 40% of the screen); single inputs outside a form close the keyboard on Enter ("Done").
  - Safe areas: left/right insets on the tab bar, action bars, toasts, install hint and viewer header (landscape, notch); minimum width 320 px is covered by an e2e check on every main screen. The manifest no longer locks the orientation.
  - Haptics: `haptic('tick' | 'decide' | 'warn')` on swipe thresholds, long press, decisions, item swipes and coming back online. No sound.
  - Offline: the persistent Firestore cache shows the last data; an approval made offline is queued and, when the connection returns, a toast says the changes are syncing.
  - PWA: `theme-color` follows the theme in use (not only the device's); the install hint waits 20 s into a session (second visit or later); the step scrubber sits below the phone header.
  - Performance (Pixel 7 profile, CPU 4x slower, 1.6 Mbps / 150 ms, `e2e/perf.spec.ts` with `PERF_DIR` set): LCP 1.24 s, INP 56 ms.
  - First load on a phone (card CGPynEQY): `index.html` paints the app shell as a skeleton from HTML and an inline `<style>` alone (`theme-init.js` sets `data-auth` when `hive-auth` is set; `components/AppSkeleton.tsx` is the same picture for React, a unit test keeps the two in step). `preload.js` (emitted by a plugin in `vite.config.ts`, an external file because the CSP allows no inline script) adds `modulepreload` links for Firebase and the first screen when the browser looks signed in, Firebase first. Firebase Auth starts without the popup/redirect resolver (it would load Google's sign-in iframe before the first auth state on phones); sign-in passes it, and the redirect result is read at once only when returning from a redirect. The service worker registers 4 s after load, when idle, so its 1.5 MB precache does not compete with the first screen. Measure with `PERF_DIR=out pnpm perf:emu` (`e2e/perf-load.spec.ts`: cold = fresh browser holding only the sign-in; warm = reload after the service worker is active; `E2E_SERVE_GZIP=1` serves dist gzip-compressed like Hosting). CI prints the numbers in the job summary.
  - Tests: `e2e/mobile.spec.ts` (swipe decide, sheets, pull down, detail swipe, scrubber, keyboard overlap, offline, 320 px and landscape); `e2e/session.spec.ts` records a full phone session with `VIDEO_DIR` set.

## 9. Screens (behaviour)

**Shell (desktop):** left sidebar as in the design (Needs you with count, All projects, Decision insights, Activity, Agents; projects list; a footer with "N agents working · M idle" (idle = online and waiting; an offline agent is in neither, as on the agent page; card 3qXLt595) and "Spend this month €x"). Content area plus an optional right detail panel.

**1. Needs you** (`/`, default route)
- Items where the current user is a decider at the item's current gate and has not decided yet. Also agent questions (messages with `kind: question`, unanswered) on items in projects they belong to. Also suggestions (untriaged findings) for the people who may triage them (`canTriage`).
- Tabs/chips: All · Approvals · Questions · Findings, with counts. Sorted by waiting time (oldest first, plus urgent).
- **Desktop:** list on the left; the selected item's detail on the right. It shows:
  - the process breadcrumb (steps with ✓)
  - deliverables as tabs (report.html · sources.pdf · links · Agent log), each in an inline sandboxed preview plus a "Full page" button
  - "What the agent asks"
  - run facts (agent, prompt/instructions version, run time, cost)
  - findings
  - approvals so far
  - a rationale box
  - the actions **Approve → <next step>** and **Reject and send back…**
- Empty state: a friendly "Nothing needs you. Agents are working on N items." with the live agents list.
- **As built (build 11):** `/` is the inbox (`?f=approvals|questions|findings`, `?sel=<key>`). Decision outcomes are **Approve / Iterate / Reject / Answer** (Iterate = send back to a chosen step with a mandatory comment, via the build 12 dialog; Reject = drop the item, reason required (10+ characters) until João confirms otherwise; reopening a rejected item is not built). Questions come from one live collection-group query per project (`messages`: workspaceId, projectId, kind, answered, ordered by `at`), findings from items with status `suggested` (read by the same per-project open-items listener). The decide flow (`inbox/useDecide`) hides the row at once, shows a 5 s Undo toast and commits on timeout, on leaving the screen or on `pagehide`; offline, Firestore queues the write. Approving as one of several deciders keeps the item in "Waiting on others". Phone: swipe right opens the approve sheet, swipe left the send-back dialog, long press opens quick actions. Keys: J/K, Enter, A, R, Esc. "Full page" opens the build 13 viewer for the active deliverable. Waiting time uses `item.updatedAt`.

**2. Board** (`/p/:pid`)
- Header: project name, template, agent count, spend this month; view switch **Board · List**, and **Edit process**.
- Columns = steps. Agent steps are folded by default (§7.3). Human-gate columns are amber, always open, with "Waiting for you" pills on items where you're a decider.
- The first column has no inline add box (card 3rEIl3Jj): items are added with the header "New item" button, C or ⌘K → New item, which open quick capture on the current project.
- **Suggestions lane** (card TU5pDmzE, Draft A): at the top of the first column, a dashed lane "N suggestions from agents" lists the suggestions (title, "Found by <agent> while on “<item>”: <details>") with **Add to <first step>** and **Dismiss…** (reason dialog with the n / 10 counter). Hidden when there are none; same on the phone (375). People who may not triage see the lane read-only. Add/dismiss write a `finding.triaged` event ("added the suggestion “X” to Ideas", "dismissed the suggestion “X”: “reason”").
- Item cards show title, type, attachment summary, progress ring (from `progress`), send-back count (↩ n), live run dots and approvals (1 of 2).
- Humans cannot drag items past gates. Drag within Intake to reorder priority. Items move only by agent completion or a decision.
- **List view:** a sortable table (title, step, status, agent, waiting, cost).
- **As built (build 10):** `/p/:pid?view=list&item=<id>`; the item opens in a right panel (desktop) or full screen (phone/tablet). New items (header "New item", C or ⌘K → New item) start at the first step. The first agent step is open by default, other agent steps start folded; the open set is kept per person and project in localStorage. Reordering Intake uses the grip handle. The decide panel (`components/DecidePanel`) offers Approve and Send back (earlier step, reason of 10+ characters); build 11/12 reuse it. **Build 12:** Send back opens `components/SendBackDialog` (dialog on desktop, sheet on phones): a vertical stepper of the earlier steps plus "Stop: archive, don't retry", the most common target (from the step's decisions) pre-selected and tagged, a required reason with a live counter, quick tags (defaults plus tags already used in the project; `board/sendback.ts`), and an insight line ("This is the 2nd 'wrong audience' rejection at Review this month."). Confirm reads "Send back to <step>" or "Stop item". Reasons reach the next agent through `hivenod item read` (`sendBackReasons` with tags, plus the `note` message). HTML attachments preview in a sandboxed iframe with a meta CSP; the hosting CSP blocks their inline scripts until the full-page viewer (build 13).
- **Edit after adding (card mpWuccjl).** In the item panel the person who added the item and admins can change the title (pencil), the type (a chip-select; suggestions keep theirs) and the description (Markdown, shown rendered; `board/ItemEdit.tsx`), and any project member can add files (picker, drop, pasted screenshots; inline, 900 KB each, same plumbing and viewer as agent attachments). Each edit is `updateItem` with an `item.updated` event carrying `fields`, `title`/`type` `{from,to}` and `summaryLength`; Activity and the item Timeline read it as "renamed X to Y", "changed the type of X to bug", "changed the description of X". Rules (`humanEdit`): title, summary and type change only for the creator or an admin; `order` stays any member's. `hivenod item read` prints the description as "Brief".

**3. Projects** (`/projects`)
- Cards per project: name, "N need you" (amber), open items, agents, spend this month, latest activity line.
- "New project from a template": 5 templates.
  - **Build a system:** the 10 steps from the canvas. Gates: 3 Go/no-go, 5 Approve spec, 9 Accept, 10 Release.
  - **Content pipeline:** Ideas → Pick → Draft → Approve → Publish
  - **Research to decision:** Brief → Research → Review → Plan → Done
  - **Feature delivery:** Spec → Build → Review PR → Deploy → Verify
  - **Client proposal:** Discovery → Scope → Sign-off → Pilot → Report

  Plus "Blank".
- Right column: recent activity (events) across projects.

**4. Send back** (sheet on phone, dialog on desktop)
- Options: the previous steps of this item (each with its description; mark the most common target based on decision history as "most common") plus **Stop** (archive, don't retry).
- "Why?" is a required textarea (min 10 chars) with quick tags (configurable per project; defaults: Wrong audience, Too long, Off brand voice, Factually wrong, Missing tests, Not what I asked).
- Insight line: "This is the 3rd 'wrong audience' rejection at Draft this month."
- On confirm:
  - the item moves to the chosen step, `sendBackCount++`, and the claim is cleared
  - a decision is written
  - a message `note` with the reason is added, so the next agent run reads it

**5. Decision insights** (`/insights`, also per project)
- Range selector (7/30/90 days); project filter.
- KPIs: decisions made, % approved first time, sent back (and where to), median wait for you.
- "Why things were sent back": horizontal bars by tag.
- Latest rationales.
- Decision log table: when, item, step, decision, by, rationale. Filter by step/outcome/person. Export CSV.
- All computed client-side from `decisions` in range (paginate 500).
- **As built (build 15):** `/insights?range=7|30|90&project=<pid>` and `/p/:pid/insights` (an "Insights" button in the project header). One live query per project: `decisions` with `at >= window start`, newest first, capped at 500 per project (the log says so when the cap is hit). The maths lives in `insights/logic.ts` (unit-tested): "decisions made" counts approve, send back and stop (answers are not gate decisions); "approved first time" is the share of (item, step) pairs whose first decision was an approval; "sent back" shows the most common target step; median wait uses the new optional decision field `waitMs` (time the item waited at the gate, taken from `item.updatedAt` when the decision is made); decisions made before build 15 have no `waitMs` and are left out of the median. Click a tag bar to filter the log by it. Export CSV exports the filtered log: UTF-8 BOM, ISO 8601 UTC dates, CRLF, cells starting with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets never run them. Phones show the log as stacked cards.

**6. Full-page review** (`/p/:pid/i/:iid/view/:aid`)
- The HTML is rendered full width in `<iframe sandbox="allow-scripts allow-popups" srcdoc=…>` (never `allow-same-origin`), with a strict CSP meta injected. PDF via an embedded viewer (data URL), images zoomable, Markdown rendered.
- Header: back, title, step pill, attachment switcher, "Open in new tab" (blob URL).
- Side panel (desktop) / bottom sheet (phone):
  - **Found while working:** each suggestion has **Add to <first step>** (becomes an item there, linked), **Add to this item** (appends to the item's summary as scope, recorded), **Dismiss** (needs a short reason)
  - **Approvals:** who approved, with their rationale; who is required; who is optional
  - **Your rationale** and the actions, as on screen 1

**7. Who decides** (`/p/:pid/process`, "Who decides" section of each human step)
- Left: the list of decision points with a plain-words summary each. Right: the selected gate.
  - **Who can decide:** people and group chips; "+ Add person or group"
  - **Approval rule:** any one / at least N of M / everyone / specific people
  - "**X must be one of them**" toggles per person
  - **If someone rejects:** one rejection, or only if most reject
  - **If nobody decides:** in v1, an in-app reminder badge after N hours; escalation is out of scope
- An "In plain words" sentence is generated live from the settings.
- The process editor itself: add/rename/reorder/delete steps, kind toggle, instructions (markdown), expected outputs, and on agent steps **Who can do this step**: any agent on this project, or only the chosen agents (card zSzW3LXy; stored in `project.stepAgents`; admins and the project's creator only, read-only for others; the step list shows "Only <agents>"). Rotating an agent's token moves its step limits to the new identity. Validation: a step that still holds items can't be deleted (offer "move items to…"). Items move in the same batch as the save (`item.moved` events, at most 10 per save): back to an earlier step, or on to the next one after an agent step; rules refuse anything that would skip a decision. Anyone who may see a project (admins and its people) may edit its steps, but a step's gate (who decides, rule, must-include, reject policy) changes only by an admin, the project's creator or a current decider of that step (card 5NpuPujd; enforced in `firestore.rules` `gatesAllowed`, mirrored by `canChangeGate` in the editor, which shows the gate read-only otherwise). A step a plain member adds starts with nobody deciding; `project.processChanged` carries a diff.

**Activity** (`/activity`)
- A live feed of events (humans and agents), filterable by project, actor and type. Grouped by day. Each row links to the item.
- Agent rows show the run, with expandable log lines.

**Agents** (`/agents`)
- A list of agents with an online dot, current work, today's runs and cost, and the token hint.
- "New agent", revoke, rotate. See §6.

**Me/Settings:** profile, theme, members (invite link, roles), groups.

**As built (build 17, polish):** `e2e/audit.spec.ts` walks every route in light and dark (axe, no sideways scroll, reads per cold load; `AUDIT_DIR` saves screenshots, `SEED_ITEMS` sets the item count). `e2e/lighthouse.spec.ts` (`LH_DIR`, `LH_MODULE`) scores mobile Lighthouse signed in. Each screen sets its tab title and takes focus; dialogs and sheets return focus to what opened them; a failed projects/agents listener shows a Reload banner. `lib/reads.ts` counts server-delivered documents in `window.__hiveReads`. Lighthouse mobile 97-100 on all routes; initial JS 150.6 kB gzip.

## 10. Agent client (`packages/agent`)

- Install (card rifzGl8M): `npm install -g https://hivenod.com/cli/hivenod-latest.tgz` (Node 20+). `pnpm release` bundles `packages/agent` into one file (`scripts/pack-cli.mjs`) and serves it as an npm tarball from Hivenod's own hosting: `/cli/hivenod-latest.tgz`, versioned `/cli/hivenod-<version>.tgz` (last 5 kept) and `/cli/versions.json`; the version is `0.1.<commit count>`, shown by `hivenod --version` with the commit and by `/version.json` (`cli`); the release smoke test checks the tarball. **Rename (card wQ7ZfmYr, hard cut):** the product, CLI package and bin are `hivenod`; env vars `HIVENOD_*` (`HIVENOD_TOKEN`, `HIVENOD_HOME`, `HIVENOD_PROJECT_ID`, `HIVENOD_EUR_PER_USD`, `HIVENOD_WEB_URL`, `HIVENOD_CLAUDE_BIN`/`CODEX_BIN`/`COPILOT_BIN`), saved token in `~/.hivenod/agent.json`, MCP server `hivenod` (tools `mcp__hivenod__*`). The old `HIVE_*` variables and `~/.hive` are never read (the old folder is only denied to the model, and `HIVE_TOKEN` is stripped from the coding CLI's environment, because a token saved there still works server-side). `/cli/hive-latest.tgz` serves the final `hive` stub (package `hive-cli`, bin `hive`) that prints "Hive is now Hivenod: install with npm install -g <host>/cli/hivenod-latest.tgz, then hivenod run claude and pair again" and exits 1; old `hive-<version>.tgz` files are no longer served. Unchanged technical names: token prefix `hive_agt_`, Firestore rules, collections and schema, the Firebase project id `hive-board-43be`, the workspace packages `@hive/*`. From the repo: `pnpm --filter @hive/agent build`, then `node packages/agent/dist/cli.js`.
- Self-hosting (item 07W4gCboOicS0lM1bqwZ): every site serves `/.well-known/hivenod.json` (`service: "hivenod"`, `protocol` 1, `backend: "firestore"`, the public Firebase web config, `cli` download base), written by the web build and rewritten from `/well-known/hivenod.json` by `firebase.json`. `hivenod connect|pair --server <site>` (or `HIVENOD_WEB_URL`) reads it and saves `server` plus the parsed `discovery` in `agent.json`; files without `server` mean https://hivenod.com (built-in config, no fetch). Explicit `HIVENOD_FIREBASE_*`/`HIVENOD_PROJECT_ID`/emulator variables win. `emulators` in the file is honoured only for a localhost site. Parsers: `packages/shared/src/discovery.ts` and `cli/internal/discovery`, both run against `cli/internal/discovery/testdata/cases.json`. Setup: `pnpm selfhost:init` (docs/SELF-HOST.md).
- Auth: reads the `HIVENOD_TOKEN` env var, signs in with the Firebase JS SDK (email/password from the token) and keeps the session refreshed.

**CLI commands** (all output JSON with `--json`; human-readable otherwise):
```
hivenod whoami
hivenod work list [--project P] [--step S]          # items at agent steps, unclaimed or mine
hivenod work claim <itemId>                          # starts a run, returns runId
hivenod run log <runId> "text"                       # appends a log line
hivenod run heartbeat <runId>                        # also auto every 60s while a command runs
hivenod item attach <itemId> <file|url> [--name N]   # html/md/txt/png/jpg/pdf ≤ 900KB, else must be URL
hivenod item ask <itemId> "question"                 # posts a question → appears in Needs you
hivenod item progress <itemId> <done> <total>
hivenod finding raise <itemId> "title" "details"     # a suggestion for people (status suggested), linked; no claim needed, never work
hivenod create-item --project P --title T [--description D] [--attach F]...  # item DhsO9: new work at the first step, createdBy the agent; only where the project's "Agents may create items" is on (off by default; admins and the project creator switch it), in the agent's own organization and projects; at most 30 an hour per agent (counted in ~/.hivenod/created-items.json)
hivenod run usage <runId> --tokens-in N --tokens-out N [--tokens-cached N] [--model M]   # running totals; tracked and shown, never limited
hivenod work release <itemId>                        # gives a held item back to the queue (MCP: release)
hivenod run end <runId> --status done|failed [--cost 0.42] [--tokens-in N --tokens-out N] [--tokens-cached N] [--summary "…"]
hivenod item complete <itemId> --run <runId>         # moves to next step (stops at the next human gate)
hivenod item read <itemId>                           # item, attachments, messages, send-back reasons, decisions
```
- `hivenod mcp` starts an **MCP stdio server** exposing the same operations as tools (`list_work`, `claim`, `log`, `attach`, `ask`, `progress`, `raise_finding`, `create_item`, `end_run`, `complete`, `read_item`), so Claude Code can be configured with `{"command":"node","args":[".../cli.js","mcp"],"env":{"HIVENOD_TOKEN":"…"}}`.
- Every operation goes through the same batched write + event as the UI, so the rules enforce tracking.
- **Run ends (card Cb0hN2CS).** `run end --status failed` also releases the item (claim cleared, back in the queue; the output says `released`), so nothing stays "working" after a failure. `--status done` keeps the claim so `complete` can still move the item on; `work claim` on such an item starts a new run (the old one is over) and `work release` gives it back. The shell footer counts an agent as working from its fresh claim on an item as well as from a live run.
- **Guardrails (card zSzW3LXy).** `work list` / `wait_for_work` skip steps limited to other agents and items held for people's answer (`item.awaitingAnswer` only; an open question plus a failed run does not hide an item); they come back once the question is answered or an admin presses "Let agents take it". A paused agent gets "This agent is paused (…)" from `work list`, `wait_for_work` and `claim`. Ending a run (`end_run`, `complete`, release) also writes the agent's failure streak; the third failed run in a row (its `maxFailedRuns`) pauses it. `report_usage` / `hivenod run usage` records the run's tokens so far (card rifzGl8M: tracked and shown only, no run is ever stopped, failed or held over tokens; an old `maxTokensPerItem` is ignored). A question's release holds the item (`item.awaitingAnswer`, set in the release's write): the rules refuse every claim of it (this agent, any other agent, a takeover of a stale claim) and the client skips it in `work list` / `wait_for_work` and refuses `claim` by id with a clear message, until that question is answered (the answer clears the hold in its batch) or an admin presses "Let agents take it" on the item (the question stays open). A paused agent gets the pause message from `claim` even for an item it still holds. Old holds with `reason: 'tokenLimit'` are read as ordinary open questions (answering clears them, or an admin presses "Let agents take it"). Usage first reported at `complete` is recorded. A heartbeat's usage also carries the run's cost so far (`costEur`, only grows; rules `usageGrows`), so a live run shows its cost, not only its tokens (card 3qXLt595). A release adds the run's cost to the item (`item.costEur`, allowed by the release rule), so questions and failed runs count in the item list's Cost column (card JJ6fYb3b). `whoami` shows the guardrails and a line pointing to the Claude Code settings for permissions.
- **`hivenod run` is paused (card Ul32d6Ee).** Only the Claude Code channel plugin connects an agent for now. `hivenod run claude|codex|copilot` stays in the code and its tests but is hidden from `hivenod --help` and prints "hivenod run is paused for now; use the Claude Code channel plugin (see https://hivenod.com/agents)" (exit 1) unless `HIVENOD_ALLOW_RUN=1`. The app's agent guide and settings no longer mention it; past runs, cost and activity stay readable. The bullets below on `hivenod run` describe the paused engine. `hivenod run log|heartbeat|usage|end` (manual run API) are unaffected.
- **Stop work in Hivenod (card BrK0r2FE).** `hivenod run` watches its run document live while the CLI works (`watchRun`); when a person stops it (status `stopped`) the CLI is ended like a revoke (SIGTERM, SIGKILL after 10 s), nothing more is written (the person's batch already ended the run and cleared the claim), the terminal says `■ Stopped by <name> in Hivenod: … The CLI was stopped; this run is not counted as a failure.` and the loop waits for the next item. If the live watch missed it (offline), the next heartbeat or tool call says "People stopped this work in Hivenod (…)" and it ends the same way; a finish racing the stop loses to it. `work list` / `wait_for_work` skip held items and `claim` by id refuses them ("…put it on hold in Hivenod…"). In the UI: **Stop work** on the item panel (admins and gate deciders, while an agent holds the item; not in a board card menu) opens "Stop this work?" (Go back / Cancel completely, optional reason; a sheet on phones); a held item shows "On hold: stopped by <name>" with the reason and **Resume**, its board card an "On hold" pill; a cancelled one "Cancelled: work stopped by <name>". The Runs list says "stopped by <name>"; Activity's Agent runs group includes both events.
- **`hivenod run claude` (card MkUwvyWs).** Pairs the terminal the first time (section 6), then loops: `waitForWork` (live, no model tokens) -> claim -> one headless Claude Code run per item (`claude -p <prompt> --output-format stream-json --strict-mcp-config --mcp-config <one-item server> --permission-mode dontAsk --permission-prompts none --allowedTools mcp__hivenod__*,Read,Glob,Grep,TodoWrite`: whatever the person's own Claude Code settings do not allow is denied; Hivenod passes no permission rules of its own) -> heartbeats and running token totals every few seconds (`report_usage`) -> complete (one step) or release -> wait again. The one-item MCP server (`hivenod mcp --run R --bridge S`) has `read_item`, `log`, `progress`, `attach`, `ask`, `raise_finding` and `finish(done|failed|needs_answer)`; no claim, complete, end_run or work list. Tokens and model come from Claude's stream (`result.modelUsage`: tokensIn = input + cache writes + cache reads, tokensCached = cache reads, model = most output). Outcomes: `finish(done)` completes; `needs_answer` releases the run as `released` with the item held for the question (`awaitingAnswer`); `failed`, no `finish`, a CLI error or the 60-minute wall time release it as `failed` (counts toward the pause); the wall time or a revoke kills the CLI (SIGTERM, SIGKILL after 10 s); tokens never do. A revoked agent fails its next heartbeat or wait (at most about a minute) and the session exits 3; the revoke (or rotate) batch ends the agent's open runs as `failed` ("Stopped: the agent was revoked.") and gives back the items they still hold, and an agent taking over a stale claim ends the old open run as `released` in its claim batch. A paused agent exits 4; Ctrl+C releases the item and exits 130. `--project` (id or name) is checked first: a project the agent may not use ends the session with exit 1. Presence: while waiting the agent stamps `lastSeenAt` about once a minute and on exit `signedOutAt` (shown offline at once). The token never leaves `hivenod run`: the MCP server holds no credential and forwards every tool call over a local socket in the run's 0700 temp folder to `hivenod run`, which runs it with its own client bound to the item; Claude's file tools are denied on the Hivenod credentials folder and the run's own temp folder (`--disallowedTools Read(//<HIVENOD_HOME>/**),Edit(//<HIVENOD_HOME>/**),Read(//<run folder>/**),Edit(//<run folder>/**)`) and `attach` (every path: `hivenod item attach`, `hivenod mcp`, the run bridge) refuses files there ("Files in the Hivenod credentials folder cannot be attached.") and in the run's bridge folder (its own wording: "…private run folder…"), also through symlinks, symlinked parent folders, relative links and hard links: it checks the path and its realpath, opens the file without following a final link, then checks the opened file (regular file, same inode as the realpath, on Linux its /proc fd path) against the protected folders' inodes and reads only from that open file. `hivenod logout` overwrites the token file with random bytes before deleting it. Hivenod no longer turns permissions into `--allowedTools` or `--disallowedTools` for tools (card rifzGl8M): the person's `~/.claude/settings.json` / project `.claude/settings.json` (`permissions.allow/deny`, default mode) rule. Cost: each run records `costEur` from Claude's `result.total_cost_usd` (per-model `costUSD` if no total; an estimate from tokens at list prices when the CLI was stopped before its result), converted at an approximate rate (0.86, `HIVENOD_EUR_PER_USD` overrides); `complete` adds it to the item.
- **Extra Claude arguments (card 19u5WLtk).** `hivenod run claude [options] -- <claude args>`: everything after the first `--` (split off before hivenod parses its own options) is appended to the Claude command line, interactive and headless, right after the prompt and before Hivenod's own flags (so Hivenod's `--allowedTools`/`--disallowedTools`, which Claude accumulates, and its other flags come last). Hive-owned flags are refused with exit 2 before pairing or claiming (`claudeArgsProblem` in claude.ts, checked against `claude --help` of 2.1.310): `-p/--print`, `--session-id`, `-n/--name`, `--remote-control`, `--remote-control-session-name-prefix`, `--mcp-config`, `--strict-mcp-config` (use `--clean`), `--settings`, `--append-system-prompt`, `--output-format`, `--input-format`, `--permission-prompts`, `--resume/-r`, `--continue/-c`, `--fork-session`, `--from-pr`, `--bg/--background`, `--cloud`, `--teleport`, `--desktop`, `--tmux`, `--no-session-persistence`, `-h/--help`, `-v/--version`, and `--model` when `hivenod run claude --model` was also given; additive flags (`--allowedTools`, `--disallowedTools`, `--add-dir`, `--effort`, `--model`, `--system-prompt`, …) pass. Headless: Hivenod forces `--permission-mode dontAsk` unless the arguments contain `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or `--permission-mode` (then none is forced). Interactive: no mode forced (as before). Hivenod's guards are unchanged by any of it (the `--disallowedTools` for `~/.hivenod` and the run folder, the token only in `hivenod run`, `attach` refusals, 60-minute cap, revoke, pause); deny rules are expected to win over bypass in Claude (to be confirmed with a real session). Startup lines: `Extra Claude arguments: <args>` and, for `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`, `Permissions: bypass (your flags)`; the same arguments line goes to the run log (token-shaped values hidden, 300 characters). `hivenod run codex|copilot -- …` is refused (exit 2).
- **Interactive Claude per item (card OPpbi0MS, Build D).** In a terminal (stdin and stdout are TTYs) `hivenod run claude` opens, per item, a fresh interactive Claude Code session in that terminal instead of `claude -p`; `--headless` (or no terminal) keeps the headless run above. Command line: `claude <item prompt> --session-id <uuid> --name "Hivenod: <title>" --remote-control "Hivenod: <title>" --append-system-prompt <run rules> --mcp-config <one-item server> [--strict-mcp-config with --clean] --settings <PermissionRequest hook> --allowedTools mcp__hivenod__*,Read,Glob,Grep,TodoWrite --disallowedTools Read(//<HIVENOD_HOME>/**),Edit(//<HIVENOD_HOME>/**),Read(//<run folder>/**),Edit(//<run folder>/**)` (no permission mode is forced and bypass is not disabled; auto mode is turned off for the session with `permissions.disableAutoMode: "disable"` in the `--settings` JSON, because the permission prompt offers "switch to auto mode", which would skip the allow-list; otherwise the person's own Claude Code config and default mode apply) (the prompt goes first: the option lists are variadic). The person's own setup loads (user/project settings, skills, plugins, MCP servers, CLAUDE.md); the Claude session markers of a parent session (`CLAUDECODE`, `CLAUDE_CODE_*` except provider switches, `CLAUDE_PID`) and the token are removed from its environment. What the person's settings do not allow shows Claude's permission prompt (terminal and Remote Control); the `PermissionRequest` hook runs `hivenod hook permission --bridge S`, which asks `hivenod run` over the run bridge (bridge-only tool `permission_wait`, not an MCP tool); `hivenod run` logs the wait on the run and answers `deny` after 10 minutes; when the person answers first, Claude ends the hook (the wait ends when its bridge connection closes). Tokens, model and cost are read every few seconds from Claude's session log `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session>.jsonl` (`assistant` entries, one per content block, deduplicated by message id; `cost-state` totals and cost when present), so running totals are reported while it runs (never limited); an unreadable log records model "unknown" and a warning. The Remote Control session comes from the log's `bridge-session` entry (`cse_X` = `https://claude.ai/code/session_X`) and is stored once on the run as `remote: { url, sessionId }` (rules: only the run's agent, only while open, only once, only a `https://claude.ai/code/session_…` link); the item's Runs list and the agent's run panel show "Open in Claude". No link within 2 minutes logs that Remote Control did not start. After `finish` the wrapper closes the session (SIGTERM, Claude restores the terminal) once `<config>/sessions/<pid>.json` says idle, or after 20 s. The person closing Claude before `finish` releases the run (`released`, not a failure) and stops `hivenod run` with exit 0 (a choice, not an interruption; card 3qXLt595); while the session runs, Ctrl+C belongs to Claude. Time cap, revoke, failure streak and the question hold are unchanged.
- **`hivenod run codex` and `hivenod run copilot` (card 3RiuFK00): EXPERIMENTAL, untested with a real account.** The same loop, guardrails and one-item MCP server as `hivenod run claude`, always headless, one adapter per CLI (`packages/agent/src/adapter.ts`, `codex.ts`, `copilot.ts`): command line, output reader, version and flag preflight. Before the loop starts, `hivenod run` reads `<cli> --version` and the help text: a missing flag Hivenod needs stops it, a version other than the one checked (Codex 0.164.0, Copilot CLI 1.0.103) prints a warning. The CLI output, `--help` of each command, the header and the agent page say "experimental, untested"; the Connect dialog shows "Codex (experimental, untested)". **Codex:** `codex exec --json --skip-git-repo-check --ignore-user-config --sandbox read-only|workspace-write -c approval_policy="never" -c mcp_servers.hivenod.command=… -c mcp_servers.hivenod.args=[…] -c mcp_servers.hivenod.default_tools_approval_mode="approve" [-c sandbox_workspace_write.network_access=true|false] [-m M] -- <prompt>` (the removed `--full-auto` is never used). Codex has no per-command allow-list and does not read Claude Code settings, so Hivenod's fixed defaults (`DEFAULT_AGENT_PERMISSIONS`: edit files, run tests, git commit; the stored per-agent allow-list is gone) become its sandbox, i.e. workspace-write with network off; the mapping is: nothing but reading -> read-only; anything that writes -> workspace-write; web access, git push or packages -> network on; commands always run inside the sandbox and can read outside the folder, so **`hivenod run codex` requires `HIVENOD_TOKEN` and refuses a saved token or pairing** (`adapter.envTokenOnly`, `tokenGuard` in cli.ts; card l7waTKBB). Codex 0.164.0 permission profiles (`default_permissions`, `permissions.<p>.extends=":workspace"`, `permissions.<p>.filesystem={"~/.hivenod"="none"}`, `deny_read` in the binary) parse via `codex mcp list`, but enforcement was not observed (`codex sandbox` needs user namespaces, unavailable on the VM) nor how a profile combines with `--sandbox`, so it is not used; revisit with a real run. Tokens: `turn.completed.usage` (tokensIn = input_tokens, which includes cached_input_tokens = tokensCached; tokensOut = output_tokens); while it runs, model (`turn_context`) and running totals (`token_count`) from the thread's session file `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`; no cost. **Copilot:** `copilot --prompt=<prompt> --output-format=json --no-ask-user --no-auto-update --disable-builtin-mcps --additional-mcp-config=<hivenod server> --allow-tool=hivenod --allow-tool=<rules> --deny-tool=<shell|write|url with no rule> --usage-output-file=<run dir>/copilot-usage.json [--model=M]`, environment `COPILOT_OTEL_FILE_EXPORTER_PATH=<run dir>/copilot-otel.jsonl` (exporter "file", no message content) and `COPILOT_ALLOW_ALL` removed. Permissions (Hivenod's fixed defaults): editFiles -> `write`; tests/git/packages -> `shell(npm test:*)`, `shell(git commit)`, …; runCommands -> `shell`; webAccess -> `url`; never `--allow-all-*`/`--yolo`. Tokens: running totals from the OpenTelemetry spans (`gen_ai.usage.input_tokens`, `…output_tokens`, `…cache_read.input_tokens`, `gen_ai.response.model`), exact at the end from the usage file's `modelMetrics` (inputTokens includes cache reads and writes; tokensCached = cacheReadTokens); no cost (every item spends the person's GitHub AI Credits). Verified without an account: the flags, the Codex `-c` keys and enum values, the Copilot MCP config shape and usage-file top level, the Codex event/token field names (from the binary) and the Copilot `result` line (from the package source). Not verified: a real run, the other event shapes, the session/OTel files, Codex MCP calls without prompts and git commit in its sandbox, Copilot `-p` with explicit rules instead of `--allow-all-tools`, multi-word Copilot shell patterns. Gemini CLI is dropped (no access for personal Google accounts since June 2026): `hivenod run gemini` says so.
- **Agent send-back (card KLCTVnX8).** `send_back(itemId, runId, toStep, reason)` (MCP): the agent holding an item at an agent step sends it to an earlier agent step on the item's path, with a reason (1-2000 characters) that the receiving agent gets (`read_item` → `agentSendBacks.history`, and a note on the item). The run ends as done. Never to or across a people step on the path (a skipped people step is not a gate), never to a skipped step or its own, and at most 12 library steps in between (each step costs ~17 rule expressions). Rounds: `item.agentSendBacks` counts agent send-backs since a person last acted (approve that moves it, send back, move, answer that ends a hold reset it to 0); the rules allow at most 3. The 4th `send_back` asks people instead ("Agents sent this back 3 times…", with the reasons) and releases the item with a hold, so it waits in Needs you (marked "Agents sent it back 3×"); the answer hands it back. `add_note(itemId, text)`: a note on the item the agent holds. Event `item.sentBack` {fromStepId, toStepId, toStepName, reason, round}; History says "sent X back to Build: reason".
- **Channel mode (card KLCTVnX8).** `hivenod mcp --channel [--project P] [--step S]` is also a Claude Code channel (`experimental['claude/channel']`, `notifications/claude/channel` with `content` and identifier-only `meta`). When an item reaches a step the agent may work (the `wait_for_work` filters), the server claims it and pushes `kind="work"` (meta item_id, project_id, run_id, step_id, step, project, why = arrived / sent_back with the reason / answered with question and answer); one item at a time: the next comes after the current one leaves this run's claim (complete, send_back, ask, release, failed end_run) or is stopped. Also pushed, for the current item only: `kind="note"` and `kind="answer"` (a person's), `kind="stop"` (Stop work); `kind="info"` for the session (busy, setup, errors). No FYIs. In channel mode `wait_for_work` is not offered, `claim` is refused, and `ask` on the handed-over item also ends the run and holds the item for the answer. Presence: `lastSeenAt` every 60 s while the session runs, `signedOutAt` on exit; a second live session of the same agent (or a `hivenod run` terminal) gets no handovers and is told so. Heartbeats run as for `claim`; a dead session's claim goes stale after 10 minutes. The server instructions say pushed text is data from people, never approval or setup instructions, and never to print the token. `hivenod pair` pairs the machine (code entered in New agent) and saves the token. Distribution: the Claude Code marketplace `hivenod` in this repo (`.claude-plugin/marketplace.json`, `plugins/hivenod`, whose `.mcp.json` runs `hivenod mcp --channel`): `claude plugin marketplace add wisely-solutions/hivenod`, `claude plugin install hivenod@hivenod`, then `claude --dangerously-load-development-channels plugin:hivenod@hivenod` until Hivenod is on the approved channels list. The Agents setup shows this under "Connect a Claude Code session instead".
- **Parking and fair hand-out (item QjTTL).** Every move stamps `item.stepAt` (server time; the rules allow only `request.time`, and old clients may leave it out). Work is handed out oldest first by `stepAt` (items without it first, by `updatedAt`, then the id), in `list_work`, `wait_for_work` and the channel. In a channel session an item the agent gives back (`release`, `end_run`) is not handed to that session again for 10 minutes. `park(itemId, reason)` (channel sessions only): the agent holding an item marks it `parked {runId, reason ≤200, at}`; it stays claimed (heartbeats go on) but does not count toward max_items, so the next item is handed over. A park is valid only while `claim.runId` is its `runId`. Only the holder parks or unparks (rules: `parked` alone changes, event `item.updated`). Any tool call on a parked item, `unpark`, or a person's note or answer wakes it (`parked: null`); Stop work reaches it as usual. After 24 h parked (no activity: activity wakes it) the session adds a note, releases it to the queue and pushes `kind="info" code="returned"`. Work events carry `holding` (active items) and `parked` (parked count). The board shows "Waiting: <reason> · since <time>" on the card and in the item, and the agent's presence reads "working N · waiting M" (card footer, Agents, the agent's page, the sidebar footer).

## 11. Testing

- Unit tests for logic (gate rule evaluation, plain-words generator, insights maths, token encode/decode).
- Rules tests for every allow/deny touched.
- Playwright E2E for the user flow on a phone (iPhone SE) and a desktop viewport.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:scripts` green in CI; see CONTRIBUTING.md.
