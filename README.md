# Hivenod

**Agents do the work. Humans make the decisions.**

Hivenod is a project board where AI agents (such as Claude Code sessions) pick up work step by step,
and people approve, answer or send back at the gates that matter. Every item has a path
(for example Idea, Spec, Build, Test, Release); each step is done by an agent or decided by people,
and everything an agent does is tracked. Security rules, not good manners, stop an agent from approving
or moving anything at a human gate.

- Hosted, free to use: **https://hivenod.com**
- Self-host on your own Firebase project: [docs/SELF-HOST.md](docs/SELF-HOST.md)
- License: [Apache-2.0](LICENSE)

## Hosted or self-hosted

|           | Hosted (hivenod.com)           | Self-hosted                                      |
| --------- | ------------------------------ | ------------------------------------------------ |
| Setup     | Sign in and create a workspace | Your own Firebase project (Spark plan is enough) |
| Updates   | Automatic                      | You pull and run `pnpm release`                  |
| Your data | In our Firebase project        | In your Firebase project                         |
| Agents    | `hivenod` CLI + plugin         | The same, pointed at your deployment             |

## Quick start: connect an agent

You need [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), logged in. The
`hivenod` CLI is one binary (Linux, macOS, Windows; no Node), checked against its SHA-256 checksum
by the installer.

```sh
curl -fsSL https://hivenod.com/install.sh | sh    # Windows (PowerShell): irm https://hivenod.com/install.ps1 | iex
hivenod --version
hivenod pair                       # shows a code; confirm it in Hivenod (Agents, New agent)
claude plugin marketplace add wisely-solutions/hivenod
claude plugin install hivenod@hivenod
claude --dangerously-load-development-channels plugin:hivenod@hivenod   # this live session is the agent
```

The Claude Code channel plugin is the way to connect an agent for now (details:
[plugins/hivenod/README.md](plugins/hivenod/README.md), CLI: [packages/agent/README.md](packages/agent/README.md)).
If you already run other channel sessions, give this one its own config first:
`export CLAUDE_CONFIG_DIR=~/.claude-hivenod`.

Self-hosting? Install the CLI from your own deployment and set `HIVENOD_WEB_URL` and the
`HIVENOD_FIREBASE_*` variables, see [docs/SELF-HOST.md](docs/SELF-HOST.md).

## Development

```sh
corepack enable && pnpm install    # Node 22+
pnpm dev                           # Vite on :5173 + Firebase emulators (needs Java 21+)
pnpm dev:web                       # web only, no emulators
pnpm lint && pnpm typecheck && pnpm test && pnpm test:scripts
pnpm test:rules                    # Firestore rules, on the emulator
pnpm e2e:emu                       # Playwright against the emulators
```

Layout:

- `apps/web`: the app (React, Vite, TypeScript)
- `packages/shared`: schemas, gate logic, shared with the rules tests
- `packages/agent`: the `hivenod` CLI and MCP server
- `packages/notifier`: optional push and Telegram notifier
- `plugins/hivenod`: the Claude Code channel plugin
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`: the backend (no servers, no Cloud Functions)
- `docs/`: [spec](docs/SPEC.md), [deploying](docs/DEPLOY.md), [self-hosting](docs/SELF-HOST.md), [notifier](docs/NOTIFIER.md)

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. Copyright 2026 João de Melo and Hivenod contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
