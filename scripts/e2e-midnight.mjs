#!/usr/bin/env node
// Usage: node scripts/e2e-midnight.mjs [playwright args...]   (what `pnpm e2e:midnight` runs)
// Guard for specs whose labels depend on the time of day (bell, parked, agentsettings, activity):
// runs them with the page clock and the seeds at 00:05 (not activity), 12:00 and 23:55 UTC (E2E_FAKE_NOW, see
// apps/web/e2e/helpers.ts), so a failure that would only show in the first minutes after midnight
// shows up now. Extra arguments (e.g. --project desktop-1440) go to Playwright.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const specs = ['bell.spec.ts', 'parked.spec.ts', 'agentsettings.spec.ts', 'activity.spec.ts'];
// activity.spec seeds 40-60 minute windows that must stay inside "today" and keep their real age
// (stalled-run thresholds), so it cannot run at 00:05; the others squeeze their seeds (helpers.ts).
const runs = [
  ['2026-06-15T00:05:00Z', specs.filter((s) => s !== 'activity.spec.ts')],
  ['2026-06-15T12:00:00Z', specs],
  ['2026-06-15T23:55:00Z', specs],
];

let failed = false;
for (const [t, list] of runs) {
  console.log(`\ne2e:midnight: clock at ${t}`);
  const r = spawnSync(
    process.execPath,
    [join(root, 'scripts/e2e-emu.mjs'), ...list, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, E2E_FAKE_NOW: t } },
  );
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
