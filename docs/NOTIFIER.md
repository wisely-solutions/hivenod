# Hivenod notifier (reach people outside the app)

The app has no server (Spark plan, no Cloud Functions), so a small process sends the
messages: `packages/notifier`. It costs nothing: Web Push is free, a Telegram bot is free, Firestore
stays inside the free quota. It runs on any machine that stays on and needs two things:
a service account that can read and write Firestore, and its own secrets file.

## What it does

- A new approval (an item arriving at a gate) tells the deciders who have not voted yet; a new agent
  question tells the project's people. Once each, with a deep link `/p/<project>?item=<item>`.
- Telegram messages have **Open**, **Approve** and **Send back** buttons. Approve applies the same
  action the app uses, as the linked person. Send back asks for a reason (reply, 10+ characters) and
  sends the item to the step before the gate.
- After the gate's "Reminder after N hours" a reminder goes out once, and `workspaces/{wid}/notified/g-<item>`
  gets `remindedAt`, which the app shows as "Waiting 30 h · reminder sent" (Needs you and the board).
  Without the notifier the app shows "reminder due" instead.
- Quiet hours (per person) hold messages back until they end; several held become one summary.
- Arrivals older than 30 minutes found at start-up are recorded without a message (no replay).
- Pop-ups are live only: a push carries its send time (`sentAt`) and a 5-minute TTL, and the
  service worker (`apps/web/public/push-sw.js`) drops a push stamped more than 5 minutes ago, so a
  device that wakes up does not get a burst of old pop-ups.

- Reach out (item KZ6O9, `src/reach.ts`): see below.

Not built: the daily email digest (needs an email provider, a spend card).

## Reach out: work in agent hands that goes quiet

Every item an agent holds (held with a live heartbeat, parked, or a stale claim) and every Inbox
thread step in an agent's hands (an approved outcome it carries out, a plan's only at its turn, or a
running long step) gets **one in-memory timer** to its next due time (`reachNext` in
`packages/shared/src/reachout.ts`):

1. **Quiet** 30 min (parked: 2 h) without activity (a status, a tool write, a log line, the run's
   start) → a status request: `statusAsk` by `hivenod` on the item (or the outcome). The agent's
   channel delivers it as `kind="status"` (`why="check"`, parked items too) or, for a step, as an
   inbox event with `reason="status"`. When the channel session saw the agent call a tool on the
   item since its last status, it answers itself ("Alive, last: read_item 12 min ago"): no model
   turn. One request at a time: a new one only after activity answered the last.
2. **No answer** 10 min after a request (Hivenod's or a person's) → the silent flag (`silence` on
   the item or outcome: since, asked, agent, told), shown as "Hive silent for 41 min" on the card,
   the item, the thread's decision top and plan step, and Today's "Agents working"; and **one**
   message to the people who decide next (a thread's member) with **Ping again · Release to queue ·
   Stop · Open** (a thread step: Ping again · Open). At most one reminder per 2 h. Any activity
   clears the flag.
3. **Stale claim** (no heartbeat for 10 min) whose agent has no live session → back to the queue
   30 min later (`releaseStale` as `hivenod`, plus a note on the item). With a live session it is
   checked again 30 min later.

A project with "Flag silence after: never" is left alone. The buttons apply the app's own plans with
the Admin SDK (`src/reachDecide.ts`): Ping again for anyone on the project (at most once per 2 min),
Release and Stop only for those who may stop work.

**Cost** (no scans, no polling; writes only on transitions; free quota 50,000 reads and 20,000
writes a day):

| Per item or step, per day                     | Reads                     | Writes                     |
| --------------------------------------------- | ------------------------- | -------------------------- |
| Busy agent that writes (status, notes…)       | 0 extra (listener exists) | 0                          |
| Busy agent that only logs                     | ≤ 48 checks × ~8 ≈ 400    | 0                          |
| One quiet period answered                     | ~8                        | 1 (the request)            |
| Silent all day                                | ~100                      | ~26 (flag, reminders)      |
| Stale claim released                          | 1 (transaction) + 1       | 4 (item, run, event, note) |
| Running long step (CLI stamps it every 5 min) | 288 (outcomes listener)   | 0                          |

The working-items listener already existed (item AzveC: one read per heartbeat). The old 60-second
silence pass, which read the log and events about once a minute for every silent-looking item
(~3,000 reads a day each), is gone. LLM: at most one model turn per 30 minutes of real quiet (2 h
parked), none while flagged, none when the session answers itself. Host: one `setTimeout` per item.

## Secrets (files, never in the repo)

`~/.agent/secrets/hive-notify.env` (override with `HIVE_NOTIFY_ENV`), mode 600:

```
TELEGRAM_BOT_TOKEN=<from @BotFather>
VAPID_PUBLIC_KEY=...        # created by "init", below
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@your-domain   # your contact; push services want a real one
APP_URL=https://hivenod.com   # optional, used in "Open" links
```

Google credentials come from `GOOGLE_APPLICATION_CREDENTIALS` or `~/.agent/secrets/gcp.env`
(a service account of your Firebase project; it needs the Firestore role `roles/datastore.user`).

## Run

```sh
pnpm --filter @hive/notifier build
node packages/notifier/dist/notifier.mjs init   # once: creates the VAPID keys in the secrets file
node packages/notifier/dist/notifier.mjs        # runs; publishes config/notify (public key, bot name)
```

A systemd user unit (`~/.config/systemd/user/hivenod-notifier.service`):

```
[Unit]
Description=Hivenod notifier
After=network-online.target

[Service]
WorkingDirectory=/path/to/hivenod
ExecStart=/usr/bin/node packages/notifier/dist/notifier.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

`loginctl enable-linger` keeps it running without a login.

## Data

| Path                                             | Who writes                   | Content                                                   |
| ------------------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| `users/{uid}/notify/prefs`                       | the person                   | push, telegram, digest, quiet hours                       |
| `users/{uid}/pushSubs/{id}`                      | the person's browser         | Web Push subscription (one per device)                    |
| `users/{uid}/notify/telegram`                    | notifier (person may delete) | linked chat                                               |
| `telegramLinks/{code}`                           | the person                   | one-time link code, 15 minutes, read by the notifier only |
| `config/notify`                                  | notifier                     | VAPID public key and bot name (public)                    |
| `workspaces/{wid}/notified/{key}`                | notifier                     | what was already sent per gate/question                   |
| `telegramActions/{code}`, `telegramChats/{chat}` | notifier only                | button targets (no rule: clients cannot reach them)       |
| items' and outcomes' `statusAsk`, `silence`      | notifier (Admin SDK)         | reach out: Hivenod's status request and the silent flag   |

## Tests

`pnpm --filter @hive/notifier test` (engine: who/when/how often) and, with the emulators,
`pnpm test:rules` (rules, then the notifier against Firestore: listeners, buttons, linking).
