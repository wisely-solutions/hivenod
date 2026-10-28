#!/usr/bin/env bash
# Quick-create soak on the emulators: N=1000 createItem as a web-SDK human, 0 refusals expected.
#   cli/spike/create-soak.sh   (takes the emulator lock)
set -eu
cd "$(dirname "$0")/../.."
packages/agent/node_modules/.bin/esbuild cli/spike/create-soak.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=packages/agent/dist/create-soak.mjs --external:firebase --external:zod \
  --log-level=warning
node scripts/with-lock.mjs firebase emulators:exec --only firestore,auth "node packages/agent/dist/create-soak.mjs"
