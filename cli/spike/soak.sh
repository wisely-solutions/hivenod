#!/usr/bin/env bash
# Spike soak (criteria c, d): a throwaway world, (a) checks, then a long Go listener session behind
# a forwarder that drops the network on a schedule, then the report and the cleanup.
#   cli/spike/soak.sh <emu|prod> <dir> <spike-bin> <flaky-bin> [seconds=7200] [listen-port]
# Run detached: nohup cli/spike/soak.sh prod /tmp/x ... > /tmp/x.log 2>&1 &
set -u
target=$1 dir=$2 spike=$3 flaky=$4 secs=${5:-7200} port=${6:-18443}
cd "$(dirname "$0")/../.."
mkdir -p "$dir"
# Bundled next to the agent package so firebase resolves from its node_modules (dist/ is ignored).
packages/agent/node_modules/.bin/esbuild cli/spike/driver.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=packages/agent/dist/spike-driver.mjs --external:firebase --external:zod \
  --log-level=warning || exit 1
drv="node packages/agent/dist/spike-driver.mjs"
if [ "$target" = emu ]; then upstream=127.0.0.1:8180; else upstream=firestore.googleapis.com:443; fi
"$flaky" -listen 127.0.0.1:$port -target $upstream -first 10m -every 25m -down 90s > "$dir/flaky.jsonl" &
fpid=$!
trap 'kill $fpid 2>/dev/null' EXIT
$drv setup --target "$target" --dir "$dir" &&
  $drv check-a --dir "$dir" --spike "$spike" &&
  $drv run --dir "$dir" --spike "$spike" --duration "$secs" --interval 120 --dial 127.0.0.1:$port
echo "soak exit $?"
$drv cleanup --dir "$dir"
echo "SOAK DONE $(date -u +%FT%TZ)"
