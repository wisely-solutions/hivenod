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
- Scheduled tasks (`src/scheduler.ts`): the clock of every schedule, and the "can't run" asks. See
  below.

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

## Scheduled tasks: the scheduler and "can't run"

The notifier is Hivenod's only clock (design `~/drafts/schedules/design.md`, slices 3 and 4). The
engine `src/scheduler.ts` is pure (ports, fake-clock tests); `src/schedulerStore.ts` is its
Firestore side. `HIVE_SCHEDULER=off` in the environment leaves it out.

- **Listeners** per organization: `schedules` (active, paused), `scheduleRuns` (open states),
  `agentsOff`, and the plan doc of each open run that has a thread. **One timer** to the earliest
  thing due (a run, an agent re-check, a start deadline, an ask, a digest), re-planned when a
  listener changes something; capped at 6 h. **Beat**: `config/scheduler.beatAt` every 15 min (it
  also re-runs a pass); the web and agents say "scheduler down" when it is older than 35 min
  (`schedulerDown` in `packages/shared/src/scheduleAsk.ts`).
- **Fire** (`dueNow` of `schedules.ts`): an occurrence at most 15 min late fires through
  `fireScheduledRun` (one batch: run `{sid}_{key}` with create(), the thread, its message, plan and
  steps; ids derived from schedule and period). The first fire wins; a second notifier or a restart
  gets ALREADY_EXISTS and does nothing. Older occurrences (the notifier was down) never fire late:
  the newest 3 per schedule become can't-run asks (`hostDown`), older ones `expired`.
- **Gates** at due time: Off for that agent → `off`; agent revoked or paused → `paused`; CLI below
  `plan` (or `longstep`) → `cliOld`; offline → `waitingAgent`, fired when it comes online within 15
  min (one agent read a minute), else `offline` with the last-seen time.
- **Tracking** from the run's plan: under way → `running`; done → `done`; stopped by the member →
  `stopped` (no ask); blocked (a step failed) → `failed` with the step's error; still not started 30
  min after firing → `noStart`.
- **Asks** (`runAskNotice`, `nextAskAt`): once/yearly urgent (at once even in quiet hours, then every
  2 h outside them, until decided); monthly/quarterly high (at once, after 4 h, then daily 09:00);
  weekly once; daily in the **daily digest** (end of quiet hours, else 08:30, member's zone; with
  "Coming up today"), a silent Telegram line after today's digest went out, and a message of its
  own on the third miss in a row. Every message is claimed first (a transaction on `ask.n`), so two
  notifiers never double one. Reported daily/weekly misses expire when the next run comes.
- **Buttons** (`src/telegram.ts`, `src/runDecide.ts`): Run now · Try later (In 1 hour · Tomorrow
  09:00 · Pick a time…, a typed "14:30", "tomorrow 10:00", "3 Nov 9:00") · Skip this one · Open,
  applied as the shared `decideRun` after the rules' checks (the member, still in the organization,
  the run still `cantRun`, else "Decided at HH:MM (Skip)"). The scheduler then acts: Run now fires
  (or, with a thread, retries the failed step / asks the agent to start); Try later runs the gates
  again at that time and asks again if it still cannot run.

**Cost** (no polling; free quota 50,000 reads and 20,000 writes a day):

| Per day                                    | Reads                        | Writes                                |
| ------------------------------------------ | ---------------------------- | ------------------------------------- |
| Beat                                       | 1 (at start)                 | 96                                    |
| A schedule with no run that day            | 0                            | 0                                     |
| A run that fires and is done (2-step plan) | ~10 (agent, run, plan, step) | ~11 (fire batch 7, running 2, done 2) |
| A run that can't run, asked once           | ~4                           | ~3 (run + event, ask claim)           |
| Agent offline at due time                  | ≤ 15 (one a minute)          | 1                                     |
| Daily digest, per member                   | 1 + prefs (≤ 24, 1 h cache)  | 1                                     |
| Start-up                                   | 1 query per active schedule  | 0                                     |

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
| `workspaces/{wid}/scheduleRuns/{sid}_{key}`      | notifier (member decides)    | scheduled runs: state, why, ask, decision                 |
| `config/scheduler`                               | notifier                     | the scheduler's beat (`beatAt`, host)                     |
| `users/{uid}/notify/digest`                      | notifier                     | the local date of the last daily digest (claim)           |

## Tests

`pnpm --filter @hive/notifier test` (engine: who/when/how often) and, with the emulators,
`pnpm test:rules` (rules, then the notifier against Firestore: listeners, buttons, linking).
