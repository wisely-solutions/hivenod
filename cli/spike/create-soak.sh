#!/usr/bin/env bash
# Quick-create soak on the emulators: N=1000 createItem as a web-SDK human, 0 refusals expected.
#   cli/spike/create-soak.sh   (emulators on ports of its own)
set -eu
cd "$(dirname "$0")/../.."
packages/agent/node_modules/.bin/esbuild cli/spike/create-soak.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=packages/agent/dist/create-soak.mjs --external:firebase --external:zod \
  --log-level=warning
node scripts/emu-exec.mjs "node packages/agent/dist/create-soak.mjs"
