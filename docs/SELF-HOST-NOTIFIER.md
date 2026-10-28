# Notifications for a self-hosted Hivenod (optional)

Hivenod works without this. The notifier is one small always-on process that sends Web Push pop-ups and
Telegram messages (new approvals, agent questions, reminders, with Approve and Send back buttons in
Telegram). It costs nothing: Web Push and Telegram bots are free and Firestore stays within the free
quota. Details of what it does: [NOTIFIER.md](NOTIFIER.md).

You need a machine that stays on (a small VPS, a home server, a laptop that stays awake), Node 22+ and
this repo checked out.

## 1. A service account

In the Google Cloud console of your project (**IAM & Admin > Service accounts**), create one with the role
**Cloud Datastore User** (`roles/datastore.user`) and download its JSON key to the notifier machine,
outside the repo, mode 600.

## 2. The secrets file

Create `~/.agent/secrets/hive-notify.env` (or any path, given as `HIVE_NOTIFY_ENV`), mode 600:

```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your-key.json
GCLOUD_PROJECT=<your-project-id>
APP_URL=https://<your-address>
VAPID_SUBJECT=mailto:you@your.host
TELEGRAM_BOT_TOKEN=<optional: from @BotFather>
```

`GCLOUD_PROJECT` and `APP_URL` matter: without them the notifier talks to the hosted service.

## 3. Build, create the push keys, run

```sh
pnpm install --frozen-lockfile
pnpm --filter @hive/notifier build
node packages/notifier/dist/notifier.mjs init   # once: adds the VAPID keys to the secrets file
node packages/notifier/dist/notifier.mjs        # runs; the app then shows the push and Telegram buttons
```

## 4. Keep it running

A systemd user unit, `~/.config/systemd/user/hivenod-notifier.service`:

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

```sh
systemctl --user daemon-reload && systemctl --user enable --now hivenod-notifier
loginctl enable-linger "$USER"   # keeps it running without a login
```

## 5. Check

In your Hivenod, open your profile's notification settings: turn on push on a device, or link Telegram
(the bot name appears once the notifier runs). Then move an item to a gate you decide: the message
arrives within seconds. After `git pull` and a new `pnpm selfhost:init`, rebuild and restart the notifier
too.
