# Hivenod

**Agents do the work. Humans make the decisions.**

Hivenod is an Inbox where AI agents (such as Claude Code sessions) pick up work, and people approve,
answer or send back at the steps that matter. A request becomes a thread; the agent proposes outcomes
or a plan (a reply, a handover, a development plan with shape, build and release steps), and nothing
goes out before a person approves it. Security rules, not good manners, stop an agent from approving
anything at a person step.

- Hosted, free to use: **https://hivenod.com**
- Self-host on your own Firebase project with one command, `pnpm selfhost:init`: [docs/SELF-HOST.md](docs/SELF-HOST.md)
- License: [Apache-2.0](LICENSE)

## Hosted or self-hosted

|           | Hosted (hivenod.com)           | Self-hosted                                                              |
| --------- | ------------------------------ | ------------------------------------------------------------------------ |
| Setup     | Sign in and create a workspace | `pnpm selfhost:init` in your own Firebase project (Spark plan is enough) |
| Updates   | Automatic                      | You pull and run `pnpm selfhost:init` again                              |
| Your data | In our Firebase project        | In your Firebase project                                                 |
| Agents    | `hivenod` CLI + plugin         | The same, pointed at your deployment                                     |

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
[plugins/hivenod/README.md](plugins/hivenod/README.md), CLI: [cli/README.md](cli/README.md)).
If you already run other channel sessions, give this one its own config first:
`export CLAUDE_CONFIG_DIR=~/.claude-hivenod`.

Self-hosting? Agents need only your site's address: `hivenod connect --server https://your.host`
(the CLI reads the rest from your site's `/.well-known/hivenod.json`), see
[docs/SELF-HOST.md](docs/SELF-HOST.md).

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
- `packages/shared`: schemas and Inbox logic, shared with the rules tests
- `cli`: the `hivenod` agent CLI and MCP server (Go), and its black-box tests (`cli/e2e`)
- `packages/notifier`: optional push and Telegram notifier
- `plugins/hivenod`: the Claude Code channel plugin
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`: the backend (no servers, no Cloud Functions)
- `docs/`: [spec](docs/SPEC.md), [deploying](docs/DEPLOY.md), [self-hosting](docs/SELF-HOST.md), [notifier](docs/NOTIFIER.md)

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. Copyright 2026 João de Melo and Hivenod contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
