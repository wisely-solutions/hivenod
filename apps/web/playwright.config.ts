import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

// Parallel worktrees must not fight over one preview port: pick a free one in the main process and
// pass it on through the environment (workers re-read this file and inherit it). E2E_PORT pins it.
if (!process.env.E2E_PORT && !process.env.E2E_BASE_URL) {
  process.env.E2E_PORT = execFileSync(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ],
    { encoding: 'utf8' },
  ).trim();
}
const base = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT}`;

// Playwright's own headless Chromium (as on CI): it needs about a tenth less CPU than branded
// Chrome, which a full run on a shared VM feels. E2E_CHANNEL=chrome runs Google Chrome instead.
const channel = process.env.E2E_CHANNEL || undefined;
const chromium = {
  ...(channel ? { channel } : {}),
  // The Auth emulator's sign-in page pulls Material styles and fonts from the internet (the app
  // itself loads nothing from there); its 'load' then waits on the network. It works without them.
  launchOptions: {
    args: [
      '--host-resolver-rules=MAP unpkg.com ~NOTFOUND, MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND',
    ],
  },
};

// `pnpm e2e:emu` (scripts/e2e-emu.mjs) gives the whole run a time budget; stop a little before it.
const deadline = Number(process.env.E2E_DEADLINE || 0);
// Where the app is built and served from (each `pnpm e2e:emu` run sets its own).
const dist = process.env.E2E_DIST || 'dist';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // One worker per CPU (8 on the VM); E2E_WORKERS overrides it.
  workers: Number(process.env.E2E_WORKERS) || availableParallelism(),
  globalTimeout: deadline ? Math.max(deadline - Date.now(), 1) : 0,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: base, timezoneId: 'UTC', trace: 'on-first-retry' },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Reuses the last build when the sources have not changed (scripts/e2e-build.mjs). The speed
        // check serves the build gzip-compressed, like Firebase Hosting (apps/web/scripts/serve-dist.mjs).
        command:
          `node ../../scripts/e2e-build.mjs ${dist} && ` +
          (process.env.E2E_SERVE_GZIP
            ? `node scripts/serve-dist.mjs ${process.env.E2E_PORT} ${dist}`
            : `pnpm exec vite preview --outDir ${dist} --port ${process.env.E2E_PORT} --strictPort`),
        url: base,
        reuseExistingServer: !process.env.CI && !process.env.E2E_FRESH_SERVER,
        timeout: 120_000,
      },
  // One desktop and one phone. The phone is the smallest width we support (375 px) with an iPhone user
  // agent; Pixel 7 only runs the opt-in perf measurement (PERF_DIR), which wants a mid-range Android.
  // Desktop is listed first: Playwright hands out tests project by project, and the longest
  // desktop tests (unreachable, realtime) should start early rather than trail at the end of a run.
  projects: [
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], ...chromium, viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'iphone-se',
      use: { ...devices['iPhone SE (3rd gen)'], ...chromium, defaultBrowserType: 'chromium' },
      // Specs with nothing phone-specific: desktop-only layouts, and data/network behaviour that
      // does not depend on the screen (live updates, renames, an unreachable server).
      testIgnore: [
        'a11y.spec.ts',
        'board-fill.spec.ts',
        'board-items.spec.ts',
        'realtime.spec.ts',
        'rename.spec.ts',
        'unreachable.spec.ts',
      ],
    },
    ...(process.env.PERF_DIR
      ? [
          {
            name: 'pixel-7',
            testMatch: ['perf.spec.ts', 'perf-load.spec.ts'],
            use: { ...devices['Pixel 7'], ...chromium },
          },
        ]
      : []),
  ],
});
