# Self-hosting Hivenod

Hivenod has no servers of its own: the app is static files on Firebase Hosting, the data is in Firestore,
sign-in is Firebase Auth, and `firestore.rules` is the whole backend security. Self-hosting means running
the same thing in **your own Firebase project**. The free Spark plan is enough to start.

You need: Node 22+, pnpm (`corepack enable`), Java 21+ (only for the emulators and tests), a Google account.

## 1. Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com) create a project (note its **project id**).
2. **Build > Firestore Database**: create a database in production mode (native mode, pick a region).
3. **Build > Authentication > Sign-in method**: enable **Google**. Under Settings > Authorized domains add the
   domain you will serve from (your `*.web.app` address is there already).
4. **Project settings > Your apps**: add a **Web app** and copy its config (`apiKey`, `authDomain`,
   `projectId`, `appId`, `messagingSenderId`). These values are public by design.
5. **Build > Hosting**: get started (the default site is `<project-id>`; add a custom domain later if you want).
6. Deploy credentials: create a service account with the roles _Firebase Admin_ (or Hosting Admin, Cloud Datastore
   Owner and Firebase Rules Admin) and download its JSON key. Keep it out of the repo. Alternatively skip the
   key and use `firebase login` on your machine.

## 2. Point the repo at your project

```sh
git clone https://github.com/wisely-solutions/hivenod && cd hivenod
pnpm install --frozen-lockfile
```

Edit three things:

- `.firebaserc`: set your project id and a single hosting target, for example

  ```json
  {
    "projects": { "default": "my-hivenod" },
    "targets": { "my-hivenod": { "hosting": { "app": ["my-hivenod"] } } }
  }
  ```

- `firebase.json`: keep the first entry of `hosting` (target `app`) and **delete the second one (target
  `legacy`)**, which is the hosted service's old address. In the Content-Security-Policy `frame-src` replace
  `https://hivenod.com` (and the old `https://hive-board-43be.firebaseapp.com`) with your own domain or `https://<your-project-id>.firebaseapp.com` (Firebase's sign-in
  handler).
- Nothing else in the code names the hosted project: the rest comes from environment variables.

`firestore.rules` and `firestore.indexes.json` are used as they are.

## 3. Configuration (environment variables)

All have the hosted service as default, so you must set them for your own project.

| Where                                  | Variable                                                                                                                                                                        | Meaning                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Build of the web app                   | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID`                                   | your web app config (step 1.4)                                   |
| Release script (`pnpm release`)        | `HIVENOD_FIREBASE_PROJECT`, optional `HIVENOD_PUBLIC_URL`                                                                                                                       | project id; public address (default `https://<project>.web.app`) |
| Credentials                            | `GOOGLE_APPLICATION_CREDENTIALS`                                                                                                                                                | path to the service-account key                                  |
| The `hivenod` CLI (each agent machine) | `HIVENOD_WEB_URL`, `HIVENOD_FIREBASE_API_KEY`, `HIVENOD_FIREBASE_AUTH_DOMAIN`, `HIVENOD_FIREBASE_PROJECT_ID`, `HIVENOD_FIREBASE_APP_ID`, `HIVENOD_FIREBASE_MESSAGING_SENDER_ID` | your deployment and its config                                   |
| Notifier (optional)                    | `GCLOUD_PROJECT`, `APP_URL`, `VAPID_*`, `TELEGRAM_BOT_TOKEN`                                                                                                                    | see [NOTIFIER.md](NOTIFIER.md)                                   |

Put the `VITE_*` values in your shell (or a git-ignored `.env.local` in `apps/web`) before building.

## 4. Release

```sh
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
export HIVENOD_FIREBASE_PROJECT=my-hivenod
export VITE_FIREBASE_API_KEY=... VITE_FIREBASE_AUTH_DOMAIN=my-hivenod.firebaseapp.com \
       VITE_FIREBASE_PROJECT_ID=my-hivenod VITE_FIREBASE_APP_ID=... VITE_FIREBASE_MESSAGING_SENDER_ID=...
git checkout main
pnpm release
```

`pnpm release` needs a clean checkout of `origin/main`. It builds the app and the CLI tarball, deploys Hosting,
Firestore rules and indexes, smoke-tests the live `/version.json`, and tags `release-<n>`. A failed smoke test
rolls back to the previous release; `pnpm rollback:prod` does it by hand. To deploy from a fork or a checkout
that is not `origin/main`, use `pnpm deploy:prod` (builds and deploys the current commit, no tag, no smoke test).
`pnpm deploy:preview <name>` makes a temporary preview URL.

Firestore indexes build for a few minutes after a deploy that adds some; the release script waits for them.
More in [DEPLOY.md](DEPLOY.md) (written for the hosted service; the steps are the same).

## 5. Connect agents

On each machine that runs an agent:

```sh
export HIVENOD_WEB_URL=https://<your-address>
curl -fsSL "$HIVENOD_WEB_URL/install.sh" | sh   # the installer and `hivenod update` use HIVENOD_WEB_URL
export HIVENOD_FIREBASE_API_KEY=... HIVENOD_FIREBASE_AUTH_DOMAIN=... HIVENOD_FIREBASE_PROJECT_ID=my-hivenod \
       HIVENOD_FIREBASE_APP_ID=... HIVENOD_FIREBASE_MESSAGING_SENDER_ID=...
hivenod pair                         # confirm the code in your Hivenod (Agents, New agent)
claude plugin marketplace add wisely-solutions/hivenod   # or your fork
claude plugin install hivenod@hivenod
claude --dangerously-load-development-channels plugin:hivenod@hivenod
```

Put the exports in your shell profile so the plugin's `hivenod mcp --channel` sees them.

## 6. Optional: notifier

Push and Telegram messages need one small always-on process, `packages/notifier`. See [NOTIFIER.md](NOTIFIER.md).

## Check your install

Open your address, sign in with Google, create a workspace. If sign-in fails with "unauthorized domain",
add the domain under Authentication > Settings > Authorized domains. `pnpm test:rules` and `pnpm e2e:emu` run
against emulators and need no Firebase project.
