# hivenod CLI (Go)

The Hivenod agent CLI as one native binary (item zLwtX2WEEg3mER4CR74g): `connect` (one-click
browser confirm by any member, item EJ2Cxq4k), `pair`, `whoami`,
`logout`, `mcp` (the MCP stdio server for Claude Code), `update`, `version`. It is the only agent
client: the TypeScript CLI (`packages/agent`) was removed (item MlWOc3O5NyfZcLgetrVo); the web app
stays TypeScript. Install it with `curl -fsSL https://hivenod.com/install.sh | sh`.

- Signs in with the agent token (`HIVENOD_TOKEN` or `~/.hivenod/agent.json`, same format as before)
  through Firebase Auth's REST API, and talks to Firestore over gRPC with the agent's ID token on
  every call, so `firestore.rules` decide everything (no service account, no admin access).
- `internal/actions` builds the same write plans as `packages/shared/src/actions.ts`; the contract
  fixture `internal/actions/testdata/contract.json` is generated from the TypeScript actions
  (`scripts/go-contract.test.mjs`); after changing the TypeScript actions run
  `UPDATE_GO_CONTRACT=1 pnpm test:scripts`.
- CLI version and old CLIs (item N9EEnCa1MzIw5UYfe70N): `MarkSeen` writes `update.Version` as
  `cliVersion` with each presence stamp (dev builds write none). `packages/shared/src/cliversion.ts`
  is the minimum-version-per-event-kind table; its copy `internal/actions/cliversions.json`
  (`actions.EventMinVersion`) is kept equal by `scripts/cli-versions.test.mjs`
  (`UPDATE_GO_CONTRACT=1 pnpm test:scripts` rewrites it). Add a row when a new event kind needs a
  new CLI. `CLI_PROTOCOL` is 3 (projects removed); an older CLI is told to run `hivenod update`. `update.Updater.Notice` compares with `<site>/cli/bin/latest.json` at session start, at
  most once a day (time kept in `~/.hivenod/update-check`), and the session pushes an info event;
  `HIVENOD_NO_UPDATE_CHECK=1` turns it off. Tests use a fake latest.json, never the network.
- The MCP surface is Go's own: a tool change is made here only.
  - `internal/mcpserver/surface.json` lists the tools (name, description, input schema) for
    `hivenod mcp` and `hivenod mcp --channel`. Edit it by hand, and add or remove the handler in
    `internal/hive/tools.go` (`ToolRuns`). The tools are the Inbox ones (`inbox_*`, `thread_*`,
    `subject_*`, `outcome_*`, `plan_*`); the item tools and `hivenod create-item` were removed with
    projects (slice 11) and say "Projects were removed from Hivenod; work arrives as Inbox threads". `go test ./internal/mcpserver/` checks the file (names,
    schemas the validator understands, plain vs channel tools); `go test ./internal/hive/` checks
    that every listed tool has a handler and every handler is listed.
  - The texts the channel sends to the model (instructions in `internal/hive/instructions.go`,
    Inbox and info events) are snapshot-tested against `internal/hive/testdata/texts.json`.
    After changing one on purpose: `UPDATE_GO_SURFACE=1 go test ./internal/hive/`, then review the
    diff.
- `e2e/` (`@hive/cli-e2e`) is the black-box suite: it builds this binary once and drives it over
  MCP (stdio) and its commands against the Auth and Firestore emulators and the real rules
  (`pnpm test:rules`). `e2e/test/go.test.ts` compares tool results and the resulting documents
  (ids, times and temp paths masked) with the golden files in `e2e/golden/`, first recorded while
  the TypeScript client and this binary agreed; after an intended change run
  `UPDATE_GOLDEN=1 pnpm test:rules` and review the diff. The channel, agent and
  self-hosting suites sit next to it, and so does the real-Claude smoke (`pnpm smoke:claude`).

Build and test (Go 1.27+):

    cd cli && go vet ./... && go test ./...
    go build -o hivenod ./cmd/hivenod

`spike/` holds the part 1 spike (Firestore as the agent, live listeners, network drops, token
refresh) and its results.
