# Hivenod notifier (reach people outside the app)

The app has no server (Spark plan, no Cloud Functions), so a small process sends the
messages: `packages/notifier`. It costs nothing: Web Push is free, a Telegram bot is free, Firestore
stays inside the free quota. It runs on any machine that stays on and needs two things:
a service account that can read and write Firestore, and its own secrets file.

## What it does

- An Inbox thread that arrives at Needs you (an agent's question) or Your call (outcomes proposed, or
  a plan step at its turn) tells its member alone, once per arrival, with a deep link to the thread.
  Projects and items are gone, so there are no gate, approval, reminder or question notices for them.
- Telegram messages have **Open**, **Approve** and **Ask for changes** buttons (and the answer chips of a
  question, **Reply**, **Not now**). Approve applies the same action the app uses, as the linked person.
- An urgent thread skips quiet hours and the summary. Quiet hours (per person) hold other messages back
  until they end; several held become one summary.
- Arrivals older than 30 minutes found at start-up are recorded without a message (no replay).
- Pop-ups are live only: a push carries its send time (`sentAt`) and a 5-minute TTL, and the
  service worker (`apps/web/public/push-sw.js`) drops a push stamped more than 5 minutes ago, so a
  device that wakes up does not get a burst of old pop-ups.

- Reach out (item KZ6O9, `src/reach.ts`): see below.

Not built: the daily email digest (needs an email provider, a spend card).

## Reach out: work in agent hands that goes quiet

Every Inbox thread step in an agent's hands (an approved outcome it carries out, a plan's only at
its turn, or a running long step) gets **one in-memory timer** to its next due time (`reachNext`
in `packages/shared/src/reachout.ts`). (Items were watched too until Projects were removed in
slice 11.)

1. **Quiet** 30 min without activity (the step's start, a progress line, the thread moving) → a
   status request: `statusAsk` by `hivenod` on the outcome. The agent's channel delivers it as an
   inbox event with `reason="status"`. One request at a time: a new one only after activity
   answered the last.
2. **No answer** 10 min after a request (Hivenod's or a person's) → the silent flag (`silence` on
   the outcome: since, asked, agent, told), shown as "Hive silent for 41 min" on the thread's
   decision top and plan step, and Today's "Agents working"; a bell entry; and **one** message to
   the thread's member with **Ping again · Open**. At most one reminder per 2 h. Any activity
   clears the flag.

Ping again (`src/reachDecide.ts`) is checked as the rules would: the step is still in the agent's
hands, the person is the thread's member, and at most once per 2 min.

**Cost** (no scans, no polling; writes only on transitions; free quota 50,000 reads and 20,000
writes a day):

| Per step, per day                             | Reads                   | Writes                |
| --------------------------------------------- | ----------------------- | --------------------- |
| Busy agent (progress, notes…)                 | ≤ 48 checks × 1         | 0                     |
| One quiet period answered                     | ~2                      | 1 (the request)       |
| Silent all day                                | ~15                     | ~26 (flag, reminders) |
| Running long step (CLI stamps it every 5 min) | 288 (outcomes listener) | 0                     |

LLM: at most one model turn per 30 minutes of real quiet, none while flagged. Host: one
`setTimeout` per step.

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
| `workspaces/{wid}/notified/{key}`                | notifier                     | what was already sent per thread arrival                  |
| `telegramActions/{code}`, `telegramChats/{chat}` | notifier only                | button targets (no rule: clients cannot reach them)       |
| outcomes' `statusAsk`, `silence`                 | notifier (Admin SDK)         | reach out: Hivenod's status request and the silent flag   |

## Tests

`pnpm --filter @hive/notifier test` (engine: who/when/how often) and, with the emulators,
`pnpm test:rules` (rules, then the notifier against Firestore: listeners, buttons, linking).
