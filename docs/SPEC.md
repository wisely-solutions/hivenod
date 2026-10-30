# Hivenod v1 build spec

> Source of truth for building Hivenod v1 (written 2026-10-23, kept up to date as features land).

> **Projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 11).** There are no projects, items, processes,
> steps, gates, runs, claims, boards, Needs-you items, calendar or busy blocks any more. Work arrives as
> Inbox threads; development work is a plan on a thread (shape, build, release, with the person's
> gates). Old project data is read-only for admins until `scripts/delete-projects-data.mjs` deletes it
> (see [DEPLOY.md](DEPLOY.md)). This spec describes what is left.

## 1. What we are building

Hivenod is an Inbox where **agents do the work and humans make the decisions**. A request becomes a
thread. The organization's agents investigate it and propose outcomes (a reply, a handover, a snooze) or a
plan of several steps; the person approves, edits, asks for changes or rejects. Nothing is carried out
before the person approves it. See [INBOX.md](INBOX.md).

The screens:

1. **Today and Inbox**: the threads that wait for you (Needs you, Your call), grouped by subject
2. **Thread**: messages, the agent's summary, proposals and plans, attachments, the timeline
3. **Development plans**: shape, build and release as plan steps, with the gates Approve idea, Ship it? and Accept on live
4. **Agents**: connect, pair, revoke, rotate
5. **Settings**: members, groups, organization (export), notifications
6. **Activity**: the organization's events

On top: **agents log in with a named token**, and **everything an agent does is tracked** (the Inbox timeline and the organization's events).

**Out of scope ("no integrations"):** Hivenod connects to no external service itself (no Google, Teams, mail, GitHub); agents bring that in. The agent interface is Hivenod's own CLI/MCP, which is part of Hivenod, not an integration. Push and Telegram notices come from the optional notifier ([NOTIFIER.md](NOTIFIER.md)).

## 2. Quality bar (non-negotiable)

UX and UI must feel like the best apps online (Linear, Things, Arc, Vercel). Slick, but never slower to use.

- **Fast:** Lighthouse mobile ≥ 95 on Performance, Accessibility and Best practices. LCP < 1.8 s on a mid-range phone over 4G. INP < 150 ms. Initial JS ≤ 180 KB gzipped (route-split everything else).
- **Instant feel:** optimistic UI on every action. Live updates via Firestore listeners. Skeletons only if loading takes > 300 ms. Never a full-page spinner.
- **Mobile first, truly:** every screen designed for 375 px wide first. One-thumb reach for primary actions. Gestures with button fallbacks. Installable PWA. See §8.
- **Accessible:** WCAG 2.2 AA. Full keyboard support, visible focus, screen-reader labels, colour never the only signal. `prefers-reduced-motion` respected everywhere.
- **Light and dark** themes from day one (follow the system, with a manual toggle).
- **Copy:** short, plain English, sentence case. Verbs on buttons ("Approve → Plan", "Send back to Draft"). No jargon, no exclamation marks.
- **Evidence at person steps:** a thread's summary at an approval or verification carries a visual (chart, before/after screenshots at 375 px and 1440 px, or a diagram); see INBOX.md.

## 3. Tech stack (decided)

| Area | Choice |
|---|---|
| Repo | `wisely-solutions/hivenod`, pnpm workspaces: `apps/web`, `packages/shared`, `packages/notifier`, `cli/e2e`; the Go CLI in `cli/` |
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
| Agent client | Go CLI `hivenod` (one native binary) + MCP stdio server, in `cli/` |
| Tests | Vitest + Testing Library; `@firebase/rules-unit-testing` against the emulator; Playwright E2E (3 phone viewports + desktop) |
| Hosting | Firebase Hosting, project `hive-board-43be` (sites `hivenod` = https://hivenod.com, the only public address, and `hive-board-43be` = old address, 301 to https://hivenod.com except `/cli/**`; see docs/DEPLOY.md); preview channels per card (`firebase hosting:channel:deploy card-<n>`) |
| CI | GitHub Actions: lint, typecheck, unit, rules and E2E tests on every PR |

**Platform limits (Spark free plan, no billing):** no Cloud Functions, no Cloud Storage. So:
- All logic runs in the client (or agent CLI) and is **enforced by Firestore security rules**.
- Attachments are stored **inline in Firestore** (HTML, Markdown, text, and images/PDFs as data URLs) up to **900 KB each**. Anything larger is attached as a link.
- Free quotas: 50k reads/day, 20k writes/day. Design listeners to be narrow (per member Inbox) and paginate logs.

## 4. Concepts

- **Organization**: the top level; holds members, groups, agents and the Inbox. (Stored at `workspaces/{wid}`: it began life as the "workspace" and the path was kept so no data had to move.) A person can belong to many organizations, like GitHub, and switches between them. A first organization is created on first sign-in; more can be made any time. People join by an email invite link.
- **Member**: a human (Google sign-in) in an organization. Roles: `admin` and `member`. The creator is an admin. Admins manage members, roles, groups and agents. The organization always keeps at least one admin. Inbox data is private to the member it belongs to (and the organization's agents).
- **Group**: a named set of members (e.g. Product, Leadership).
- **Agent**: a named non-human identity that logs in with a token (§6). Has a colour and an avatar initial. `scope: 'inbox'` marks an Inbox-only agent. (`projectIds` is legacy and ignored.)
- **Subject, thread, message, outcome, plan**: the Inbox model, described in [INBOX.md](INBOX.md). Development work is a plan from the template `dev` on a thread.
- **Event**: an append-only record of every change by anyone (§5.3). Workspace events never name a project, item or run; old project events stay readable by admins until deleted.

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
workspaces/{wid}/agents/{agentUid}   name, color, createdBy, createdAt, revokedAt?, lastSeenAt?, tokenHint ('…a7f3'),
                                     scope? ('inbox' = Inbox only, immutable), cliVersion?,
                                     projectIds, guardrails, permissions (legacy, ignored, never written)
workspaces/{wid}/events/{eid}        actor{type:'human'|'agent', id, name}, type, data{}, at
                                     (older docs may also hold projectId, itemId, runId: admins read them until deleted)
pairings/{code}                      a terminal's pairing request (§6)
```

The Inbox collections (`inboxSubjects`, `inboxThreads`, `inboxMessages`, `inboxOutcomes`, `inboxPlans`,
`inboxEvents`, `inboxRelations`, `inboxConfig`) are described in [INBOX.md](INBOX.md). They are
private to the member each belongs to and the organization's agents.

Old collections with no rule any more (no reads or writes from clients): `projects` and everything under
them (items, attachments, messages, decisions), `runs`, `calendar`, `users/{uid}/busy` and `agentHomes`.
`scripts/export-org.mjs` still exports them for an operator, and `scripts/delete-projects-data.mjs`
deletes them (see DEPLOY.md).

### 5.1 Security rules (the backend)

The rules in `firestore.rules` are the backend. Rules tests must cover every allow and deny below.

- Only organization members (humans) and non-revoked agents of the organization can read what the rules give them.
- **Roles.** Only an admin changes roles, removes people, invites or renames the organization. One role change per write, and `adminUids` must follow `memberRoles`; the last admin can be neither demoted nor removed.
- **Many organizations.** `users/{uid}.workspaceIds` grows by one organization per write, and only with one the person belongs to. Names and pictures of other people are read from `workspaces/{wid}/members/{uid}`, never from `users`.
- **Agents cannot decide.** An agent can never approve, edit or reject a proposal, or decide a plan's person step. The Inbox rules in INBOX.md say who writes what.
- Only an `admin` can manage members, groups and agents. A member's `hivenod connect` creates an agent (no project checks).
- Agent tokens: an agent with `revokedAt` set is denied everything (including reads).
- **No rules for projects, items, runs, decisions, step proposals, item attachments and messages, calendar or busy.** An old CLI's item tools are refused by the rules (permission denied); the CLI says to run `hivenod update`. `CLI_PROTOCOL` is 3.
- **Inbox-only agents (item fJnu6).** An agent with `scope: 'inbox'` (a personal assistant, e.g. the personal agent in a "Personal" organization) uses only the Inbox of its organization. Only an admin creates one (Connect page: "Inbox only"); the scope is kept on rotation and never changes. The MCP server refuses its other tools up front with one message (`toolInScope`), and `whoami` shows `scope`.
- **The Personal organization (item fJnu6).** A person's own organization, for their Inbox; their personal agent joins it as an Inbox-only agent. It is created with the app's own batch (`personalOrgPlan` in `packages/shared/src/personalOrg.ts`: workspace, member card, `workspace.created`, plus the switcher entry `workspaceIds`, without switching them to it), either by the person (New organization) or by an operator with `notifier personal-org --email … [--apply]` (dry run by default; refuses when they already own one with that name). Setup: docs/PERSONAL.md.

### 5.2 Writes are batches

Every user or agent action is a single batched write (or transaction): the domain change, with `lastEventId` set, and **one event doc** (`events/{lastEventId}` for organization changes; `inboxEvents` for Inbox changes).

### 5.3 Tracking is enforced, not optional

Rules require that a write includes its event doc in the same batch (`existsAfter(...)`), with `actor.id == request.auth.uid` and `at == request.time`.

Events are **create-only** (no update/delete for anyone). So nothing an agent (or person) does can go untracked or be rewritten.

Organization event types: `agent.created`, `agent.revoked`, `agent.rotated`, `agent.renamed` (`oldName`, `newName`), `agent.updated`, `member.*`, `group.*`, `workspace.created`. The Inbox event types are in INBOX.md.

## 6. Agent identity and tokens

**Create (Settings → Agents → "New agent", admin only)**
- Name (e.g. "Research agent"), colour, and optionally Inbox only.
- The client creates a Firebase Auth email/password user using a **secondary Firebase app instance**, so the admin stays signed in:
  - email: `agent-<random12>@agents.hive-board.app`
  - password: 32 random bytes, base64url
- The agent doc is written with id = that auth uid.

**Token**
- Format: `hive_agt_<base64url(json{w:wid,e:email,p:password})>`
- Shown **once** in a dialog with a copy button and a "Copy as env var" (`HIVENOD_TOKEN=…`) button. The UI says it cannot be shown again. Only `tokenHint` (last 4 characters) is stored.

**Revoke**
- Sets `revokedAt`. Rules deny everything immediately.

**Rotate**
- Revokes the old agent doc and creates a new identity that keeps the same name, colour and history link (`previousAgentUid`).

**Connect a terminal (pairing, card MkUwvyWs)**
- `hivenod pair` without a token creates `pairings/{code}` (8 characters, no sign-in) holding only a fresh P-256 public key and what it runs on (cli, host, folder), and prints `https://hivenod.com/agents/connect?code=K7QX-29PD`.
- An admin opens the link (or Agents, "New agent", one guide with copy-paste steps: install the CLI, `hivenod pair`, add the plugin, start the channel session (card Ul32d6Ee), and types the code; "Advanced: plain MCP with a token" is the secondary path), checks the code matches the terminal, picks name and colour, and presses Connect: the agent is created as usual, then its token is encrypted for the terminal's key (ECDH P-256 + HKDF-SHA-256 + AES-256-GCM, bound to the code) and written to the pairing doc. The admin never sees the token. If that write fails (expired, used) the new agent is revoked again.
- The terminal decrypts the token, saves it to `~/.hivenod/agent.json` (0600) and deletes the pairing doc as the new agent. Rules: anyone may create a pending request and read one by its code (listing is denied); only an admin of the organization may complete it, once, within 15 minutes, for a non-revoked agent they created with the same name; deleting: a pending one by anyone, a paired one by the agent or an admin.

**Agent page** (`/agents/:id`)
- Status: online if last heartbeat < 2 min; Paused.
- **Settings:** name and colour; a read-only note says what the agent may do on its machine is set in that machine's Claude Code settings (Hivenod stores and enforces no permissions and no token limit).
- Recent activity of the agent from the organization's events.

## 7. Design system

Start from the canvas design (Geist / Geist Mono, near-black ink, amber for person steps). Build tokens as CSS variables on `:root` and `[data-theme=dark]`.

**Colour (light)**
- ink `#15171B` · text-2 `#4B5160` · text-3 `#6B7280`
- surface `#FFFFFF` · canvas `#F4F5F7` · line `#E1E4EA`
- **person step / needs-you amber** `#F2B32A` (bg `#FFF7E5`, text `#9A6200`)
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
1. **Decide flow:** the Approve or Reject button counts down with an **Undo** toast; the write is committed when the countdown ends or on navigation, and works offline (queued).
2. **Live presence:** a heartbeat pulse on the agent avatar while its session is online. Badge counts tick (number roll).
3. **Command palette ⌘K / Ctrl K:** jump to any thread, subject or agent.
4. **Keyboard:** `J/K` next/previous, `Enter` open, `A` approve (the main action), `E` edit, `C` ask for changes, `Esc` close, `?` shortcut sheet.
5. **Skeleton → content cross-fade**, never a jump in layout (CLS < 0.02).
6. **Haptics** (`navigator.vibrate(8)`) on swipe thresholds and decisions, on devices that support it.

## 8. Mobile (top priority)

- Breakpoints: phone < 640, tablet 640–1023, desktop ≥ 1024. Design and build phone first.
- **Bottom tab bar** (phone): Today (badge) · Inbox · Activity · Me. It hides on scroll down and shows on scroll up. Safe-area insets respected.
- **Today (phone):**
  - A card stack list; each card shows the thread, its subject, waiting time, the agent and what it needs.
  - **Swipe right → Approve**; **swipe left → Ask for changes**. Long-press → quick actions.
- **Thread (phone):**
  - Full screen, with a sticky bottom action bar (Approve · Ask for changes). The plan is in a bottom sheet.
  - Agent questions show as a chat thread with an answer box above the keyboard.
- **Full-page viewer (phone):** an attachment's HTML fills the screen. Pinch-zoom is allowed in the iframe.
- **Touch:** targets ≥ 44 px; no hover-only features; inputs ≥ 16 px (no iOS zoom); the keyboard never covers the focused field.
- **PWA:**
  - manifest, icons, theme colour, standalone display, iOS meta tags, splash
  - offline read of the last data (Firestore cache) and queued writes
  - an "Install Hivenod" hint after the 2nd visit (dismissible)
  - app badge (`navigator.setAppBadge`) with the count of threads that wait for you
- **Device test matrix (Playwright + manual screenshots):**
  - iPhone SE 375×667, iPhone 15 393×852, Pixel 7 412×915
  - iPad 820×1180, desktop 1440×900
  - Safari, Chrome and Firefox engines

- **As built (build 16):** `lib/mobile.ts` holds the shared phone behaviour.
  - Gestures: thread cards swipe to approve or ask for changes (with buttons as the non-gesture equivalent); a pull down on the full-page viewer header leaves it; sheets close by dragging down (vaul). Swipes ignore inputs, iframes and horizontal scrollers. Edge-swipe back (left 24 px) is only wired in an installed app (`display-mode: standalone`), where the browser has no back gesture, so it never fights iOS Safari's own.
  - Keyboard: `useKeyboardAvoidance` publishes the keyboard height as `--kb` from `visualViewport`; sticky action bars, toasts and the Decide pill sit above it, the tab bar hides, and the focused field is scrolled clear of the keyboard and the bar. Textareas grow with their content (to 40% of the screen); single inputs outside a form close the keyboard on Enter ("Done").
  - Safe areas: left/right insets on the tab bar, action bars, toasts, install hint and viewer header (landscape, notch); minimum width 320 px is covered by an e2e check on every main screen. The manifest no longer locks the orientation.
  - Haptics: `haptic('tick' | 'decide' | 'warn')` on swipe thresholds, long press, decisions, swipes and coming back online. No sound.
  - Offline: the persistent Firestore cache shows the last data; an approval made offline is queued and, when the connection returns, a toast says the changes are syncing.
  - PWA: `theme-color` follows the theme in use (not only the device's); the install hint waits 20 s into a session (second visit or later); the step scrubber sits below the phone header.
  - Performance (Pixel 7 profile, CPU 4x slower, 1.6 Mbps / 150 ms, `e2e/perf.spec.ts` with `PERF_DIR` set): LCP 1.24 s, INP 56 ms.
  - First load on a phone (card CGPynEQY): `index.html` paints the app shell as a skeleton from HTML and an inline `<style>` alone (`theme-init.js` sets `data-auth` when `hive-auth` is set; `components/AppSkeleton.tsx` is the same picture for React, a unit test keeps the two in step). `preload.js` (emitted by a plugin in `vite.config.ts`, an external file because the CSP allows no inline script) adds `modulepreload` links for Firebase and the first screen when the browser looks signed in, Firebase first. Firebase Auth starts without the popup/redirect resolver (it would load Google's sign-in iframe before the first auth state on phones); sign-in passes it, and the redirect result is read at once only when returning from a redirect. The service worker registers 4 s after load, when idle, so its 1.5 MB precache does not compete with the first screen. Measure with `PERF_DIR=out pnpm perf:emu` (`e2e/perf-load.spec.ts`: cold = fresh browser holding only the sign-in; warm = reload after the service worker is active; `E2E_SERVE_GZIP=1` serves dist gzip-compressed like Hosting). CI prints the numbers in the job summary.
  - Tests: `e2e/mobile.spec.ts` (swipe decide, sheets, pull down, keyboard overlap, offline, 320 px and landscape); `e2e/session.spec.ts` records a full phone session with `VIDEO_DIR` set.

## 9. Screens (behaviour)

**Shell (desktop):** left sidebar (Today with count, Inbox, Activity, Agents), a footer with "N agents online". Content area plus an optional right detail panel. The board, Projects, Decision insights, Process editor and Needs-you item screens were removed with projects (slice 11).

**Today and Inbox** (`/inbox`, details in [INBOX.md](INBOX.md))
- Today lists the threads that wait for the member (Needs you: an agent's question; Your call: outcomes proposed or a plan step at its turn), most urgent first. Each card has the thread's summary (headline, ask, bullets, visuals) and the main action: Approve, Edit, Ask for changes, Reject.
- The subject list groups threads under lasting subjects; a thread page shows messages, the agent's notes, proposals, plans, attachments and the timeline.
- Empty state: "Nothing needs you."

**Development plans** (a plan from the template `dev` on a thread)
- Steps: Shape → **Approve idea** → Build → **Ship it?** → Release + live check → **Accept on live**. The three approvals are the member's gates; shape, build and release are agent steps. Build and release are long steps (progress lines, resumable).
- Asking for changes at a gate sends the plan back to an earlier step; the third send back blocks the plan until the member goes on.

**Activity** (`/activity`)
- A live feed of the organization's events (members, groups, agents), grouped by day.

**Agents** (`/agents`)
- A list of agents with an online dot and the token hint. "New agent" (Connect), revoke, rotate. See §6.

**Me/Settings:** profile, theme, members (invite link, roles), groups, organization (name, **export**, delete). The browser export covers members, groups, agents and events; `scripts/export-org.mjs` stays the complete operator export (it also reads old project data). The browser's delete walk skips projects, runs and calendar.

## 10. Agent client (Go CLI, `cli/`)

- Install: `curl -fsSL https://hivenod.com/install.sh | sh` (Windows: `irm https://hivenod.com/install.ps1 | iex`); `hivenod update` updates it. One native binary per platform, built by `pnpm release` (`scripts/build-cli-bin.mjs`) and served from Hivenod's own hosting under `/cli/bin/` with `latest.json`. Since item MlWOc3O5NyfZcLgetrVo the Go CLI is the only agent client: the TypeScript client (`packages/agent`, its npm tarball `/cli/hivenod-latest.tgz` and the `hive-latest.tgz` stub, `hivenod run claude|codex|copilot` and the `work`/`item`/`run` subcommands) was removed. The MCP surface (`cli/internal/mcpserver/surface.json`) and the channel texts are Go's own (see cli/README.md); `cli/e2e` tests the binary as a black box. Unchanged technical names: token prefix `hive_agt_`, Firestore rules, collections and schema, the Firebase project id `hive-board-43be`, the workspace packages `@hive/*`.
- Self-hosting (item 07W4gCboOicS0lM1bqwZ): every site serves `/.well-known/hivenod.json` (`service: "hivenod"`, `protocol` 1, `backend: "firestore"`, the public Firebase web config, `cli` download base), written by the web build and rewritten from `/well-known/hivenod.json` by `firebase.json`. `hivenod connect|pair --server <site>` (or `HIVENOD_WEB_URL`) reads it and saves `server` plus the parsed `discovery` in `agent.json`; files without `server` mean https://hivenod.com (built-in config, no fetch). Explicit `HIVENOD_FIREBASE_*`/`HIVENOD_PROJECT_ID`/emulator variables win. `emulators` in the file is honoured only for a localhost site. Parsers: `packages/shared/src/discovery.ts` and `cli/internal/discovery`, both run against `cli/internal/discovery/testdata/cases.json`. Setup: `pnpm selfhost:init` (docs/SELF-HOST.md).
- Auth: reads `HIVENOD_TOKEN` or `~/.hivenod/agent.json` (`HIVENOD_HOME` moves the folder), signs in through Firebase Auth's REST API (email/password from the token), keeps the ID token refreshed and talks to Firestore over gRPC as the agent.

**CLI commands:**
```
hivenod connect [--server URL]   # one-click confirm in the browser by any member, saves the token, installs the plugin
hivenod pair [--server URL]      # shows a code an admin confirms (Agents, New agent)
hivenod whoami [--json]          # the agent and its settings
hivenod claude                   # starts Claude Code with the hivenod channel plugin
hivenod inbox|thread|subject|outcome|plan ...        # the Inbox tools from a shell (item 4PEHr)
hivenod mcp [--channel] [--max-items N] [--max-inbox N]   # the MCP stdio server
hivenod logout | update | version
```
- Projects were removed from Hivenod: the item tools (`list_work`, `wait_for_work`, `claim`, `read_item`, `log`, `attach`, `ask`, `progress`, `status`, `raise_finding`, `create_item`, `release`, `end_run`, `complete`, `send_back`, `add_note`, the path tools, `park`, `report_usage` and so on), `hivenod create-item` and `--project` / `--step` are gone; they say "Projects were removed from Hivenod; work arrives as Inbox threads". Findings go in with `inbox_add` (source `finding`).
- `hivenod mcp` starts an **MCP stdio server** with the Inbox tools (`inbox_*`, `thread_*`, `subject_*`, `outcome_*`, `plan_*`, `step_progress`); the list and schemas are `cli/internal/mcpserver/surface.json`.
- Every operation goes through the same batched write + event as the UI, so the rules enforce tracking.
- **Channel mode.** `hivenod mcp --channel` is also a Claude Code channel (`experimental['claude/channel']`, `notifications/claude/channel` with `content` and identifier-only `meta`). It pushes `kind="inbox"` events for the threads that need agent work (see INBOX.md) and `kind="info"` for the session's status. `--max-items N` (alias `--max-steps`) limits the long plan steps (build, release) run at once; `--max-inbox N` limits the threads sent at once. The Claude Code plugin (0.3.8) is threads only; its `hivenod` skill runs each thread in a background sub-agent.
- **Old CLIs.** `CLI_PROTOCOL` is 3. An older CLI is told to run `hivenod update`; its item calls are refused by the rules.

## 11. Testing

- Unit tests for logic (plan and outcome rules, summaries, token encode/decode).
- Rules tests for every allow/deny touched.
- Playwright E2E for the user flow on a phone (iPhone SE) and a desktop viewport.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:scripts` green in CI; see CONTRIBUTING.md.
