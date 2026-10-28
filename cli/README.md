# hivenod CLI (Go)

The Hivenod agent CLI as one native binary (item zLwtX2WEEg3mER4CR74g): `pair`, `whoami`,
`logout`, `mcp` (the MCP stdio server for Claude Code), `update`, `version`. It replaces the
TypeScript CLI in `packages/agent` for agents; the web app stays TypeScript.

- Signs in with the agent token (`HIVENOD_TOKEN` or `~/.hivenod/agent.json`, same format as before)
  through Firebase Auth's REST API, and talks to Firestore over gRPC with the agent's ID token on
  every call, so `firestore.rules` decide everything (no service account, no admin access).
- `internal/actions` builds the same write plans as `packages/shared/src/actions.ts`; the contract
  fixture `internal/actions/testdata/contract.json` is generated from the TypeScript actions
  (`scripts/go-contract.test.mjs`). The MCP tool list (`internal/mcpserver/surface.json`) is
  generated from the TypeScript server (`scripts/go-mcp-surface.test.mjs`). After changing either
  side: `UPDATE_GO_CONTRACT=1 pnpm test:scripts`.
- `packages/agent/test/go.integration.test.ts` runs the same MCP scenarios through the TypeScript
  server and this binary on the emulators and compares results and documents (`pnpm test:rules`).

Build and test (Go 1.27+):

    cd cli && go vet ./... && go test ./...
    go build -o hivenod ./cmd/hivenod

`spike/` holds the part 1 spike (Firestore as the agent, live listeners, network drops, token
refresh) and its results.
