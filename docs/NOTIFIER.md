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

Not built: the daily email digest (needs an email provider, a spend card).

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

## Tests

`pnpm --filter @hive/notifier test` (engine: who/when/how often) and, with the emulators,
`pnpm test:rules` (rules, then the notifier against Firestore: listeners, buttons, linking).
