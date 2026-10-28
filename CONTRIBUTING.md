# Contributing to Hivenod

Thanks for helping. Hivenod is Apache-2.0; by sending a change you agree it is licensed the same way.

## Ground rules

- **Open an issue first** for anything bigger than a small fix, so we agree on the shape before you build it.
- Small pull requests to `main`, one topic each. Describe what changed and how you checked it.
- Keep the product plain: short copy, no jargon, and every screen works at 390 px and 1440 px,
  in light and dark, and passes the accessibility checks (axe) in the e2e tests.
- Never commit secrets, tokens, service-account files or personal data. `.env*` files are git-ignored.

## Setup

```sh
corepack enable && pnpm install     # Node 22+, Java 21+ for the Firebase emulators
pnpm dev                            # app on http://localhost:5173 with Auth + Firestore emulators
```

## Checks (the same as CI)

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scripts
pnpm build && pnpm size             # the initial JS has a size budget
pnpm test:rules                     # Firestore rules, on the emulator
E2E_WORKERS=2 pnpm e2e:emu <spec>   # Playwright against the emulators; run the specs you touched
```

Write the test first when you can. Security rules changes need a rules test for each allow and deny
you touch (`packages/shared/rules`). A new Firestore query needs an index in `firestore.indexes.json`
(`pnpm check:indexes` finds missing ones).

## Style

Prettier and ESLint are enforced (`pnpm format` fixes formatting). TypeScript is strict.

## Self-hosting changes

Anything specific to the hosted service (project id, domain) must come from configuration with the
hosted values as defaults, see [docs/SELF-HOST.md](docs/SELF-HOST.md). `scripts/web-urls.test.mjs` keeps
`*.web.app` and `*.firebaseapp.com` addresses out of user-facing text.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## CI layout

`.github/workflows/ci.yml` runs these jobs in parallel (about 7 minutes wall clock): `check` (lint, typecheck,
unit, scripts, build, size), `go`, `rules` (rules and integration tests against the emulators), `rules-headroom`
(the expression-budget probe, about 6 minutes on its own), `e2e` in 6 Playwright shards with 2 workers each, and
`perf`. Pull-request runs cancel when you push again; runs on `main` queue. `release.yml` and `rollback.yml`
skip without the deploy credentials, so this public repository never deploys.
