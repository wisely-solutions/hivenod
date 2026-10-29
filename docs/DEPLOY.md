# Deploying Hivenod

> This is how the hosted service https://hivenod.com is released. To run your own copy, see [SELF-HOST.md](SELF-HOST.md).

Production: https://hivenod.com (Firebase Hosting + Firestore rules/indexes, Spark plan, no billing).
This is the only address anyone is given: links, defaults, docs, Telegram/push messages and CLI output all use
it (a check in `scripts/web-urls.test.mjs` fails on `*.web.app` / `*.firebaseapp.com` outside a short allow-list).
www.hivenod.com redirects to it. The Firebase project id stays `hive-board-43be` (it cannot change).

Two Hosting sites (card 9ZbSDmos), mapped by `.firebaserc` targets and the `hosting` array in `firebase.json`:
`app` = site `hivenod` (serves the app and `/cli/*`; custom domains `hivenod.com` and `www.hivenod.com` are
attached to it in Firebase Hosting, DNS is at the registrar) and `legacy` = site `hive-board-43be` (the old address:
every page 301-redirects to `https://hivenod.com/<same path and query>`, except `/cli/**`, which is served as before
so installed CLIs and the `hive` stub keep working). `pnpm release` deploys the same build to both.

The site's own default address (hivenod on web.app) is the same Hosting site as hivenod.com, so Hosting cannot
redirect it by host (it would loop). Instead `apps/web/public/theme-init.js`, the first script of every page, does
`location.replace` to hivenod.com (same path, query and hash) when the host is exactly that address or the old one.
Preview channels are not affected. Data and `/cli/**` on that address are not redirected, so CLIs installed from
it keep working (they read `/version.json` there). The smoke test checks: hivenod.com serves the commit, the old
address answers 301 to hivenod.com and still serves the tarballs, and the redirect script is live on the default address.

Sign-in: `authDomain` is `hivenod.com` (Firebase Hosting serves `/__/auth/**` on it), so Google's popup says
"continue to hivenod.com". The Google OAuth client must list `https://hivenod.com/__/auth/handler` as an authorized redirect
URI (Google Cloud console). The CSP `frame-src` allows hivenod.com and the old `hive-board-43be.firebaseapp.com` handler. Email
verify/reset links still go through `hive-board-43be.firebaseapp.com/__/auth/action` (Firebase refuses to change the template
action URL for this project; see the card vyH5uux3 findings). The smoke test checks that hivenod.com `/__/auth/handler` and
`/__/firebase/init.json` answer 200.

## How a change goes live (a maintainer, from their machine)

1. Get the change onto `main` (PR merged, CI green, or the same checks run locally, see below).
2. From a clean checkout of `main` (your clone):

   ```sh
   git checkout main && git pull --ff-only
   pnpm install --frozen-lockfile
   pnpm release
   ```

   `pnpm release` refuses a dirty tree or a HEAD that is not `origin/main`. It builds, writes
   `dist/version.json` with the commit, deploys Hosting + Firestore rules/indexes with the
   deploy service account (`GOOGLE_APPLICATION_CREDENTIALS`, read from
   `~/.agent/secrets/gcp.env` when unset), then smoke-tests production: the live
   `/version.json` must show this commit. On success it tags `release-<n>` (the rollback point)
   and pushes the tag. On a failed smoke test it redeploys the previous `release-<n>`.

   It also writes `dist/stars.json` with the GitHub star count of wisely-solutions/hivenod (one
   API call, using `GH_TOKEN_WISELY` or `GH_TOKEN` when set), which the landing page shows from 50
   stars up. A failed call writes `{"stars":null}` and never fails the release.

   The landing page's product screenshots are real, from a made-up demo organization on the
   emulators: `pnpm shots:landing` rewrites `apps/web/src/landing/shots/*.webp` (commit them;
   `SHOTS_PREVIEW=<dir>` keeps the full-size PNGs to look at first).

   If the release touches `firestore.indexes.json`, new composite indexes build for a few minutes
   and queries needing them fail (the app shows "Still preparing this view"). After the smoke test
   `pnpm release` therefore polls the Firestore admin API until every index is READY (15 min
   timeout; it only warns on timeout or API errors). Do not test the release while it says
   "indexes still building" or warns; check with `gcloud firestore indexes composite list`.

   The emulator never checks indexes, so `pnpm test:scripts` runs an index guard
   (`pnpm check:indexes` alone): it finds every Firestore `query()` in `apps/web/src` and
   `packages/shared/src` (not the Go CLI's queries) and fails with `file:line` and the index to add
   when `firestore.indexes.json` cannot serve it. Queries built at run time must be listed in
   `scripts/firestore-index-allowlist.mjs` with the test that covers them.

   The npm tarball of the old TypeScript CLI (`/cli/hivenod-latest.tgz`, `hive-latest.tgz`) is no
   longer built or served (item MlWOc3O5NyfZcLgetrVo): the Go CLI below is the only agent client.
   The smoke test still checks npm tarballs when a rollback deploys an older commit that made them.

   The Go CLI (item zLwtX2WEEg3mER4CR74g, `cli/`): `scripts/build-cli-bin.mjs` cross-compiles five
   binaries into `apps/web/dist/cli/bin/` (`hivenod-linux-x64`, `-linux-arm64`, `-darwin-x64`,
   `-darwin-arm64`, `-windows-x64.exe`), each with a `.sha256` next to it, plus `latest.json` (the
   manifest `install.sh`, `install.ps1` and `hivenod update` read), and copies `cli/install/install.sh`
   and `install.ps1` to the site root. It needs Go (`HIVENOD_GO`, `~/.local/go/bin/go` or `go` on
   PATH). The version is `0.2.<commits that touched cli/>` and the commit the last one that touched
   `cli/`, so a release that leaves the CLI alone ships byte-identical binaries (`-trimpath`,
   `CGO_ENABLED=0`, the Go version pinned in `cli/go.mod`). `version.json` gets `"cliBin"`. The smoke
   test downloads all five from the live site and checks size and SHA-256 against the manifest and the
   `.sha256` files, checks `/install.sh` and `/install.ps1`, and runs the linux-x64 binary:
   `--version`, `mcp --channel` initialize, and `pair` (shows a pairing URL on the site, then is
   cancelled, which deletes its pairing request). macOS and Windows get a manual check once per CLI
   release.

3. Check it live: `curl -s https://hivenod.com/version.json` shows the commit; open
   the changed screen on production and check the changed screen.

Rollback: `pnpm rollback:prod` redeploys the release tag before the latest one.

Preview channels (your own testing only, never for Review): `pnpm deploy:preview <name>`.

## Checks before merging (same as CI)

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:scripts && pnpm build && pnpm size
pnpm test:rules   # Firestore rules, emulator
pnpm e2e:emu      # Playwright against the auth + firestore emulators
pnpm e2e:midnight # day-bound specs (bell, parked, agentsettings, activity) with the clock at 00:05 and 23:55 UTC
```

Time budget: the whole run must finish in `E2E_BUDGET_MIN` minutes (default 5; Playwright stops itself
15 s earlier, about 285 s). If tests are left unrun, `e2e-emu` prints "N tests did not run" and exits 1, so a
cut-short suite never looks green. Measured on the 16-CPU host (2026-10-27, `E2E_WORKERS=8`, 332 tests ran, 0 cut): before card bBf3LD7G
4m42-4m57 wall (a worker's targeted run alongside pushed it past 5 minutes); now **3m24s on a quiet host and
3m36s with a targeted `E2E_WORKERS=2` run alongside**. The time is throughput-bound (sum of test times / 8
workers), so what helped was less work per test: (1) specs sign in through the app's own button but hand the
Auth emulator the sign-in directly (`signIn` in `e2e/helpers.ts`; `auth.spec.ts` still drives the real
popup and redirect flows with `{ ui: true }`), about 2 s per test; (2) `fastTimers(page)` shortens the Undo
window to 2 s and "Can't reach the server" to 3 s for the specs that only wait for the commit
(inbox, motion, session, mobile, reloadundo, unreachable). Both are read from `localStorage` only when the
app is built with `VITE_USE_EMULATOR=1` (`src/lib/undoWindow.ts`, `src/auth/signin.ts`); the production build
never sets it, so the code is removed from it (checked: no `hive.e2e` in `apps/web/dist`). Specs that check
the real 5 s window (finalpath, polish138, the Undo-click tests' own timing) keep it. If it gets close again,
trim the slowest specs (audit, bulk, paths, orgs) rather than raising the budget.

Parallel workers: `pnpm e2e:emu` (`scripts/e2e-emu.mjs`) needs no lock. Each run starts its own Auth
and Firestore emulators on ports of its own (a fixed block per worktree, or free ones when those are
taken), passed to the emulators through a generated `firebase.json` and to the app and specs through
`VITE_*_EMULATOR_PORT` / `E2E_*_PORT`; the preview server takes a free port (or `E2E_PORT`). The
emulator build of the app is reused while its sources and settings are unchanged
(`scripts/e2e-build.mjs`). The suite runs on one phone (iPhone SE, 375 px) and one desktop (1440 px),
one worker per CPU (`E2E_WORKERS` overrides).

Time limit: the whole `pnpm e2e:emu` must finish in 5 minutes on the 8-CPU VM. Past
`E2E_BUDGET_MIN` (default 5) the run is stopped and fails with a message saying so. Keep new specs
fast: no fixed sleeps (wait for the condition, or `settle(page)` before axe or a screenshot), and seed
data through the emulator (`adminSet`, `adminSetAll`) rather than through the UI.

`pnpm test:rules` (and `test:rules:core`, `:headroom`, `:mutate`, `pnpm smoke:claude`) start their
emulators through `scripts/emu-exec.mjs`, the same way as the e2e: every port is picked for the run
(ports 5-9 of the worktree's block when free, so they never clash with that worktree's e2e on ports 0-4;
otherwise any free ones), written into a generated firebase.json, and handed to the tests through
`FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST`. Each run also has its own TMPDIR (the emulator
hub's locator file). So worktrees and a release on main run side by side: there is no machine-wide
emulator lock any more. Only one run of `test:rules:mutate` per worktree at a time: it rewrites that
worktree's `firestore.rules` while it runs.

`pnpm install` prints an EBADENGINE warning: the Firebase web SDK 13 declares Node >=24.12, the VM runs
Node 22. It is harmless for the build, tests and deploy (checked); the repo's own `engines` stays `>=22`.

Release tags: `pnpm release` tags `release-<max+1>` (numeric, so a stray `release-3` is ignored). It is
idempotent: a commit that already has a release tag keeps it, a taken name moves on to the next free
number, and existing tags are never moved or deleted.

## GitHub Actions

`Release` (after green CI on `main`) and `Rollback` deploy only when the repo secret
`GCP_SA_KEY` exists. Without it they log a notice and skip; the local `pnpm release` path above is the one that ships.
