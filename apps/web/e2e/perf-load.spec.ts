import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  adminSet,
  adminSetAll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

// First-load speed on a throttled phone (card CGPynEQY). Same profile as the UX review:
// 4x slower CPU, Fast-3G-class link (1.6 Mbps down, 150 ms). Run with PERF_DIR set; in CI the
// numbers go in the PR. Cold = a new browser context holding only the sign-in (no HTTP cache,
// no service worker, no Firestore cache); warm = a reload right after.
test.skip(!process.env.PERF_DIR, 'set PERF_DIR to measure');

export const BUDGET = { shellMs: 1000, coldLcpMs: 3500, warmLcpMs: 1500 };

interface Marks {
  shell: number;
  heading: number;
  item: number;
  lcp: number;
  fcp: number;
  kb: number;
  emptyFrames: number;
}

async function observe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __m: Record<string, number> };
    w.__m = { shell: 0, heading: 0, item: 0, lcp: 0, fcp: 0, emptyFrames: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__m.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (e.name === 'first-contentful-paint') w.__m.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    // Frames in which neither the HTML skeleton (#hv-boot) nor anything in React's root is
    // there to see: the screen would be blank (card CGPynEQY, round 3). Counted from the first
    // frame in which the page showed anything.
    w.__m.emptyFrames = 0;
    let shown = false;
    const frame = () => {
      const boot = document.getElementById('hv-boot');
      const bootOn = !!boot && getComputedStyle(boot).display !== 'none';
      const rootOn = !!document.getElementById('root')?.firstElementChild;
      if (bootOn || rootOn) shown = true;
      else if (shown) w.__m.emptyFrames!++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const check = () => {
      const t = performance.now();
      // The shell: the tab bar or sidebar, or the skeleton that stands in for it.
      if (!w.__m.shell && !w.__m.seen && document.querySelector('nav, [data-skeleton]')) {
        // Seen in the DOM; it counts once the browser has actually produced a frame with it.
        w.__m.seen = t;
        requestAnimationFrame(() => setTimeout(() => (w.__m.shell = performance.now()), 0));
      }
      if (!w.__m.heading && /^Hi /.test(document.querySelector('h1')?.textContent ?? ''))
        w.__m.heading = t;
      if (!w.__m.item && /Item number 1/.test(document.body?.innerText ?? '')) w.__m.item = t;
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PERF_CPU ?? 4) });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: process.env.PERF_NET === 'off' ? 0 : 150,
    downloadThroughput: process.env.PERF_NET === 'off' ? -1 : (1.6 * 1024 * 1024) / 8,
    uploadThroughput: process.env.PERF_NET === 'off' ? -1 : (750 * 1024) / 8,
  });
}

async function read(page: Page, shot?: string): Promise<Marks> {
  await expect(page.getByText('Item number 1').first()).toBeVisible({ timeout: 40_000 });
  await page.waitForTimeout(1500);
  if (shot) await page.screenshot({ path: shot });
  const m = await page.evaluate((): Record<string, number> => ({
    ...(window as unknown as { __m: Record<string, number> }).__m,
    bytes: performance
      .getEntriesByType('resource')
      .reduce((n, e) => n + (e as PerformanceResourceTiming).transferSize, 0),
  }));
  const waterfall = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => {
      const r = e as PerformanceResourceTiming;
      return `${Math.round(r.startTime)}-${Math.round(r.responseEnd)} ${Math.round(r.transferSize / 1024)}KB ${r.name.split('/').pop()}`;
    }),
  );
  const marks = await page.evaluate(() =>
    performance.getEntriesByType('mark').map((e) => `${Math.round(e.startTime)} mark ${e.name}`),
  );
  if (process.env.PERF_VERBOSE) console.log([...waterfall, ...marks].join('\n'));
  return {
    shell: Math.round(m.shell ?? 0),
    heading: Math.round(m.heading ?? 0),
    item: Math.round(m.item ?? 0),
    lcp: Math.round(m.lcp ?? 0),
    fcp: Math.round(m.fcp ?? 0),
    kb: Math.round((m.bytes ?? 0) / 1024),
    emptyFrames: m.emptyFrames ?? 0,
  };
}

/**
 * PERF_ORG=<n>: a lived-in organization like the tester's (card CGPynEQY round 2): n more
 * projects, each with open items waiting on this person, an unanswered question and a month of
 * agent runs with summaries, plus three agents. Their items are newer than "Item number 1", so
 * Blog's items stay first in Needs you (oldest first).
 */
async function seedOrg(wid: string, uid: string, n: number) {
  const base = `workspaces/${wid}`;
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  const docs: Array<[string, Record<string, unknown>]> = [];
  for (const a of ['scout', 'writer', 'checker'])
    docs.push([
      `${base}/agents/${a}`,
      {
        name: a[0]!.toUpperCase() + a.slice(1),
        color: 'c2',
        projectIds: '*',
        createdBy: uid,
        createdAt: ago(60 * 24 * 20),
        revokedAt: null,
        lastSeenAt: ago(5),
        tokenHint: 'abcd',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    ]);
  const long =
    'Looked at the brief, checked the sources it links to, drafted the piece and left notes on the parts that need a human call. ';
  for (let p = 0; p < n; p++) {
    const pid = `org${p}`;
    docs.push([`${base}/projects/${pid}`, projectFields(`Project ${p}`, uid)]);
    for (let i = 0; i < 6; i++)
      docs.push([
        `${base}/projects/${pid}/items/t${i}`,
        {
          title: `Task ${p}.${i} that is waiting for a decision`,
          type: 'task',
          stepId: i < 4 ? 'review' : 'draft',
          status: i < 4 ? 'waiting' : 'working',
          summary: long,
          source: { kind: 'manual', label: 'Test' },
          createdBy: { type: 'agent', id: 'scout' },
          parentItemId: null,
          sourceRunId: null,
          claim: null,
          progress: null,
          gate: i < 4 ? { stepId: 'review', approvals: {}, rejections: {} } : null,
          triage: null,
          sendBackCount: 0,
          costEur: 0.4,
          order: i,
          updatedAt: ago(10 + p * 6 + i),
          lastEventId: 'seed',
        },
      ]);
    docs.push([
      `${base}/projects/${pid}/items/t0/messages/q1`,
      {
        workspaceId: wid,
        projectId: pid,
        itemId: 't0',
        by: { type: 'agent', id: 'scout', name: 'Scout' },
        kind: 'question',
        text: 'Which of the two headlines should I keep?',
        at: ago(30),
        answered: false,
        replyTo: null,
        lastEventId: 'seed',
      },
    ]);
    for (let r = 0; r < 30; r++)
      docs.push([
        `${base}/runs/${pid}-r${r}`,
        {
          agentUid: ['scout', 'writer', 'checker'][r % 3],
          projectId: pid,
          itemId: `t${r % 6}`,
          stepId: 'draft',
          startedAt: ago(60 * 24 * Math.min(25, r * 0.3) + 50),
          heartbeatAt: ago(60 * 24 * Math.min(25, r * 0.3) + 40),
          heartbeatEventAt: ago(60 * 24 * Math.min(25, r * 0.3) + 40),
          endedAt: ago(60 * 24 * Math.min(25, r * 0.3) + 40),
          status: 'done',
          costEur: 0.12,
          tokensIn: 120000,
          tokensOut: 4000,
          model: 'claude-sonnet',
          summary: long + long + long,
          lastEventId: 'seed',
        },
      ]);
  }
  for (let i = 0; i < docs.length; i += 200) await adminSetAll(docs.slice(i, i + 200));
}

test('first load on a throttled phone', async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'pixel-7', 'the mid-range Android profile');
  test.setTimeout(240_000);
  const dir = process.env.PERF_DIR!;
  mkdirSync(dir, { recursive: true });
  const owner = person('Marta');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = 'perf1';
  await adminSet(`workspaces/${wid}/projects/${pid}`, projectFields('Blog', uid));
  for (let i = 1; i <= 6; i++) {
    await adminSet(`workspaces/${wid}/projects/${pid}/items/i${i}`, {
      title: `Item number ${i}`,
      type: 'idea',
      stepId: 'review',
      status: 'waiting',
      summary: 'A summary that is long enough to take two lines on a phone screen.',
      source: { kind: 'manual', label: 'Test' },
      createdBy: { type: 'human', id: uid },
      parentItemId: null,
      sourceRunId: null,
      claim: null,
      progress: null,
      gate: { stepId: 'review', approvals: {}, rejections: {} },
      triage: null,
      sendBackCount: 0,
      costEur: 0.1,
      order: i,
      updatedAt: new Date(Date.now() - i * 3_600_000),
      lastEventId: 'seed',
    });
  }
  if (process.env.PERF_ORG) await seedOrg(wid, uid, Number(process.env.PERF_ORG) || 10);
  await expect(page.getByText('Item number 1').first()).toBeVisible({ timeout: 20_000 });

  // Only the sign-in survives into the cold context: copy the Auth record, nothing else.
  const rec = await page.evaluate(
    () =>
      new Promise<{ fbase_key: string; value: unknown }[]>((res, rej) => {
        const req = indexedDB.open('firebaseLocalStorageDb', 1);
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          const all = req.result
            .transaction('firebaseLocalStorage')
            .objectStore('firebaseLocalStorage')
            .getAll();
          all.onsuccess = () => res(all.result);
        };
      }),
  );
  const u = info.project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    baseURL: info.project.use.baseURL,
  });
  const seedPage = await ctx.newPage();
  await seedPage.goto('/favicon.svg');
  await seedPage.evaluate(
    (records) =>
      new Promise<void>((res, rej) => {
        localStorage.setItem('hive-auth', '1');
        const req = indexedDB.open('firebaseLocalStorageDb', 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('firebaseLocalStorage', 'readwrite');
          for (const r of records) tx.objectStore('firebaseLocalStorage').put(r);
          tx.oncomplete = () => {
            req.result.close();
            res();
          };
        };
      }),
    rec,
  );
  await seedPage.close();
  const cold = await ctx.newPage();
  await observe(cold);
  await throttle(cold);
  await cold.goto('/');
  const coldMarks = await read(cold, `${dir}/cold.png`);

  // A second visit: the service worker (registered a few seconds after load) has the app.
  await cold.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await cold.reload();
  const warmMarks = await read(cold, `${dir}/warm.png`);
  await ctx.close();

  writeFileSync(
    `${dir}/load.json`,
    JSON.stringify(
      {
        profile: 'Pixel 7, CPU 4x slower, 1.6 Mbps / 150 ms (local production build)',
        cold: coldMarks,
        warm: warmMarks,
        budget: BUDGET,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ cold: coldMarks, warm: warmMarks }));
  // Always on, not only when enforcing: the HTML skeleton hands over to the app's own without
  // a blank frame, cold and warm.
  expect(coldMarks.emptyFrames, 'blank frames between the HTML skeleton and the app (cold)').toBe(
    0,
  );
  expect(warmMarks.emptyFrames, 'blank frames between the HTML skeleton and the app (warm)').toBe(
    0,
  );
  if (process.env.PERF_ENFORCE) {
    expect(coldMarks.shell, 'shell paint (cold)').toBeLessThan(BUDGET.shellMs);
    expect(coldMarks.lcp, 'LCP cold').toBeLessThan(BUDGET.coldLcpMs);
    expect(warmMarks.lcp, 'LCP warm').toBeLessThan(BUDGET.warmLcpMs);
  }
});
