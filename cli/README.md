# hivenod CLI (Go)

The Hivenod agent CLI as one native binary (item zLwtX2WEEg3mER4CR74g): `connect` (one-click
browser confirm by any member, item EJ2Cxq4k), `pair`, `whoami`,
`logout`, `mcp` (the MCP stdio server for Claude Code), `update`, `version`. It replaces the
TypeScript CLI in `packages/agent` for agents; the web app stays TypeScript.

- Signs in with the agent token (`HIVENOD_TOKEN` or `~/.hivenod/agent.json`, same format as before)
  through Firebase Auth's REST API, and talks to Firestore over gRPC with the agent's ID token on
  every call, so `firestore.rules` decide everything (no service account, no admin access).
- `internal/actions` builds the same write plans as `packages/shared/src/actions.ts`; the contract
  fixture `internal/actions/testdata/contract.json` is generated from the TypeScript actions
  (`scripts/go-contract.test.mjs`); after changing the TypeScript actions run
  `UPDATE_GO_CONTRACT=1 pnpm test:scripts`.
- The MCP surface is Go's own: a tool change is made here only.
  - `internal/mcpserver/surface.json` lists the tools (name, description, input schema) for
    `hivenod mcp` and `hivenod mcp --channel`. Edit it by hand, and add or remove the handler in
    `internal/hive/tools.go` (`ToolRuns`). `go test ./internal/mcpserver/` checks the file (names,
    schemas the validator understands, plain vs channel tools); `go test ./internal/hive/` checks
    that every listed tool has a handler and every handler is listed.
  - The texts the channel sends to the model (instructions in `internal/hive/instructions.go`,
    work, inbox and status events) are snapshot-tested against `internal/hive/testdata/texts.json`.
    After changing one on purpose: `UPDATE_GO_SURFACE=1 go test ./internal/hive/`, then review the
    diff.
- `packages/agent/test/go.integration.test.ts` runs the same MCP scenarios through the TypeScript
  server and this binary on the emulators and compares results and documents (`pnpm test:rules`).

Build and test (Go 1.27+):

    cd cli && go vet ./... && go test ./...
    go build -o hivenod ./cmd/hivenod

`spike/` holds the part 1 spike (Firestore as the agent, live listeners, network drops, token
refresh) and its results.
