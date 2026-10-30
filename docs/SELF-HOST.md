# Self-hosting Hivenod

Hivenod has no servers of its own: the app is static files on Firebase Hosting, the data is in Firestore,
sign-in is Firebase Auth, and `firestore.rules` is the whole backend security. Self-hosting means running
the same thing in **your own Firebase project**, and one command sets it up. The free Spark plan is
enough to start.

You need: Node 22+, pnpm (`corepack enable`), a Google account, and optionally Go 1.27+ (so your site
also serves the `hivenod` CLI downloads). Java 21+ is only needed for the emulators and tests.

## 1. Get the code and sign in to Firebase

```sh
git clone https://github.com/wisely-solutions/hivenod && cd hivenod
pnpm install --frozen-lockfile
pnpm exec firebase login        # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key
```

A service account needs the _Firebase Admin_ role (or Hosting Admin, Cloud Datastore Owner, Firebase
Rules Admin and Firebase Authentication Admin). Keep its key out of the repo.

## 2. Run the setup

```sh
pnpm selfhost:init
```

It asks for a project id (an existing project, or a new one to create), the Firestore location for a new
database (default `eur3`), a support email (shown on Google's sign-in screen) and, optionally, your own
domain. Then it shows the steps and asks before it changes anything:

1. **Project:** uses it, or creates it when it does not exist (after you confirm).
2. **Web app:** uses the web app named "Hivenod" (or the project's first web app), or creates one, and
   reads its public config.
3. **Firestore:** uses the `(default)` database, or creates it in the location you chose.
4. **Hosting:** finds the project's default site and its address.
5. **Config:** writes `hivenod.selfhost.json` (your settings) and `firebase.selfhost.json` (hosting for
   your site, rules, indexes, and Auth with email/password and Google sign-in). Both are git-ignored;
   the repo's own `firebase.json` is not changed.
6. **Build:** builds Hivenod with your web config, the CLI downloads (when Go is installed) and
   `/version.json`. The build also publishes `/.well-known/hivenod.json`, the discovery file agents
   read (see below).
7. **Deploy:** hosting, Firestore rules and indexes, and the Auth providers.
8. **Check:** your site serves `/.well-known/hivenod.json` with your project id.

Every step looks first and only creates what is missing, so **running it again is safe**, and it is
also how you update your install: `git pull && pnpm install --frozen-lockfile && pnpm selfhost:init --yes`.

Options:

| Option                   | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `--project <id>`         | your Firebase project id                                          |
| `--location <id>`        | Firestore location for a new database (default `eur3`)            |
| `--support-email <mail>` | shown on Google's sign-in screen (needed for Google sign-in)      |
| `--domain <host>`        | your own domain for the site (see "Your own domain")              |
| `--yes`, `-y`            | no questions: uses the flags and the saved settings (scripts, CI) |
| `--dry-run`              | prints the steps and the exact `firebase` commands, calls nothing |
| `--skip-build`           | deploys the build already in `apps/web/dist`                      |

For example, without questions:

```sh
pnpm selfhost:init --yes --project my-hivenod --support-email you@your.host
```

## 3. Sign up

Open the address the command printed (`https://<project-id>.web.app`, or your domain), sign up with
email or Google, and create your workspace.

## 4. Connect agents

Agents need only your site's address. On each machine that runs an agent:

```sh
curl -fsSL https://<your-address>/install.sh | sh     # or https://hivenod.com/install.sh (same CLI)
hivenod connect --server https://<your-address>       # opens your Hivenod to confirm, sets up Claude Code
```

`hivenod pair --server https://<your-address>` does the same with a code an admin confirms. The server is
saved with the token in `~/.hivenod/agent.json`, so `hivenod mcp` (the Claude Code plugin), `whoami` and
`update` use it from then on without any variables. `HIVENOD_WEB_URL=https://<your-address>` works like
`--server` (for scripts and `HIVENOD_TOKEN` setups). Without a server, the CLI uses https://hivenod.com, as
always.

### The discovery file

Your site serves `/.well-known/hivenod.json`, written by the build from the same values as the app:

```json
{
  "service": "hivenod",
  "protocol": 1,
  "backend": "firestore",
  "firebase": {
    "apiKey": "…",
    "authDomain": "…",
    "projectId": "my-hivenod",
    "appId": "…",
    "messagingSenderId": "…"
  },
  "cli": "/cli"
}
```

The CLI reads it once when it connects or pairs and saves a copy with the token. These values are public
by design (a Firebase web API key only names the project; `firestore.rules` enforce the security). The
old `HIVENOD_FIREBASE_API_KEY`, `HIVENOD_FIREBASE_PROJECT_ID` (and the other `HIVENOD_FIREBASE_*`)
variables still work and win when set.

## Your own domain

1. In the Firebase console, **Hosting > Add custom domain**, and follow the DNS steps.
2. **Authentication > Settings > Authorized domains**: add the domain.
3. Run `pnpm selfhost:init --domain hivenod.your.host` (once; it is saved). It allows sign-in frames from
   your domain and prints it as the address to give people and agents.

## 5. Optional: notifications

Push and Telegram messages need one small always-on process. See
[SELF-HOST-NOTIFIER.md](SELF-HOST-NOTIFIER.md).

## Check your install

- `curl https://<your-address>/.well-known/hivenod.json` shows your project id.
- Sign in, create a workspace, connect an agent, add an Inbox thread for it.
- If sign-in fails with "unauthorized domain", add the domain under Authentication > Settings >
  Authorized domains.
- `pnpm test:rules` and `pnpm e2e:emu` run against emulators and need no Firebase project.

## Doing it by hand

`pnpm selfhost:init --dry-run --project <id> --support-email <mail>` prints every step with the exact
`firebase` command, if you prefer to run them yourself. The web build reads `VITE_FIREBASE_API_KEY`,
`VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` and
`VITE_FIREBASE_MESSAGING_SENDER_ID` (defaults: the hosted service), and the deploy uses
`firebase deploy --only hosting,firestore,auth --config firebase.selfhost.json --project <id>`.
`pnpm release` and `pnpm deploy:prod` are the hosted service's release tools ([DEPLOY.md](DEPLOY.md));
self-hosted installs use `pnpm selfhost:init`.
