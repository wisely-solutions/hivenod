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
emulator lock any more. `test:rules:mutate` mutates a temp copy of
`firestore.rules` (handed to the suite as `HIVE_RULES_FILE`) and never edits the tracked file, so an interrupted
run leaves nothing behind; every mutation edit is tagged `/*MUTATED*/` and `test:scripts` fails on a leftover.

`pnpm install` prints an EBADENGINE warning: the Firebase web SDK 13 declares Node >=24.12, the VM runs
Node 22. It is harmless for the build, tests and deploy (checked); the repo's own `engines` stays `>=22`.

Release tags: `pnpm release` tags `release-<max+1>` (numeric, so a stray `release-3` is ignored). It is
idempotent: a commit that already has a release tag keeps it, a taken name moves on to the next free
number, and existing tags are never moved or deleted.

## Rules size

Google refuses to **release** Firestore rules whose compiled executables are 256000 bytes or more
("Total size of compiled executables must be smaller than 256000 bytes (actual: N bytes)", a 400 on
`PATCH releases/cloud.firestore`). Uploading the ruleset still succeeds, and firebase-tools then reports a
misleading 409 "release already exists". This is a size limit for the whole file, separate from the
1000-expression budget per request that `test:rules:headroom` measures.

- **Measure:** `node scripts/rules-size.mjs [file]` prints the compiled size Google computes, e.g.
  `rules compiled size: 232566 of 256000 bytes (9% headroom)`, and exits 1 over the budget. Nothing
  reports the size of rules that fit, so it uploads a throwaway ruleset and tries a throwaway release
  `size-probe` (never `cloud.firestore`), padded with identical unused functions until Google refuses it,
  and reads the size from the 400 (two pad sizes give the cost per pad, which is subtracted). It deletes
  every ruleset and release it creates (Google keeps at most 2500 rulesets). It needs the deploy service
  account (`GOOGLE_APPLICATION_CREDENTIALS`) and takes about a minute.
- **Release guard:** `pnpm release` runs the same probe before deploying rules and stops with
  "rules too big: N of 256000 bytes" (nothing deployed). A 409 behind which the 400 hides is reported the same
  way and never retried.
- **Offline budget (before merging):** `pnpm test:scripts` (`scripts/rules-size.test.mjs`) fails when the
  _estimated_ compiled size of `firestore.rules` is over **235000 bytes** (`RULES_COMPILED_BUDGET`, about 8%
  under the limit). The estimate (`estimateCompiledSize` in `scripts/rules-size-lib.mjs`) is
  4.4727 x tokens + 0.9526 x characters of names, strings and numbers - 10837, comments and whitespace
  excluded, fitted on eight measured rulesets, within about 1500 bytes. Every token costs about 4.5 bytes and every
  character of a name about 1, so what grows the size is repeated code, not comments.
- **When it is tight:** measure with the probe, then trim without weakening a guarantee: repeated
  `request.resource.data` / `resource.data` become `let d` / `let r` in a function; functions inside a match
  read its wildcards (`wid`, `pid`, `iid`, ...) instead of taking them as parameters; `touched(keys)` is
  `changed(keys + ['updatedAt', 'lastEventId'])`; repeated unrolled checks become a small function.
  Re-fit the estimate if the probe and the estimate drift apart by more than about 2000 bytes.

## Migrating a project's open items to Inbox threads

Before Projects are removed (Inbox item OE8Fm, slice 8), the open items of a project become Inbox threads with
a Development plan (`dev` template), filed under the subject "Hivenod development" (findings under "Hive
findings"):

```sh
node scripts/migrate-project-to-threads.mjs --org <wid> --project <pid> --member <uid> --agent <agentId> --dry-run
node scripts/migrate-project-to-threads.mjs --org <wid> --project <pid> --member <uid> --agent <agentId> --yes
```

| Item now                                                    | Becomes                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| waiting at a person step named Approve...                   | thread, plan at 2 Approve idea (Shape done)                                                                  |
| waiting at a person step named Accept...                    | thread, plan at 6 Accept on live (steps 1-5 done: PR link, release number, live commit taken from the notes) |
| open finding (status suggested) of the last 30 days         | thread (source `finding`) with a Development plan proposed by the agent (Approve plan = accept)              |
| at an agent step (Shape, Build, Release, Test)              | skipped: nothing is migrated mid-flight; finish it in the project, then rerun                                |
| done, stopped, archived, older findings, other person steps | skipped (they are in the export)                                                                             |

Each thread's first message is the item's description, a link back to the old item, its notes (oldest
dropped past 50 000 characters) and decisions; the item's attachments are copied as thread attachments where
they fit the thread rules (an SVG image or a non-https link is reported and left out). The dry run prints
the mapping table and builds and checks every document without writing. The documents are made by the shared
Inbox actions (`createMemberThread`, `approveOutcome`, `finishOutcome`, `addInboxMessage`, `proposePlan`,
`assignSubject`, `threadAttach`) replayed in memory, then checked against the shared zod schemas (the Admin
API skips the rules, so the script validates itself). Ids derive from the item; each item is one atomic
commit (attachments may follow in further commits) and the item gets `migratedTo {threadId, planId, at, by}`
last, so a rerun skips migrated items and finishes a half-written one. Nothing is deleted (slice 11 does).
Afterwards the home agent writes a summary for each thread.

Admin access through the REST API with the service account (`GOOGLE_APPLICATION_CREDENTIALS`); a production
run needs `--yes` and the owner's OK at run time, after he saw the dry-run table. Against the emulator:
`--emulator host:port` (project `demo-hive`, or `--firebase-project`; token `owner`). The emulator test
(`scripts/migrate-project.emu.test.mjs`, in `pnpm test:rules`) seeds items at Shape, Approve, Build and
Accept plus findings, runs it twice and checks threads, plans and no duplicates. The script loads
`packages/shared/src/*.ts` directly (Node 22 strips the types; `scripts/ts-resolve-hook.mjs` adds the `.ts`
extension to their imports).

## GitHub Actions

`Release` (after green CI on `main`) and `Rollback` deploy only when the repo secret
`GCP_SA_KEY` exists. Without it they log a notice and skip; the local `pnpm release` path above is the one that ships.
