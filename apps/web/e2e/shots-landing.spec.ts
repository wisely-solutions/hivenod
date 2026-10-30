import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminUpdate, fastTimers, freezeClock, NOW, settle, signIn } from './helpers';
import { at, seedInbox, type Seed } from './inboxSeed';

// The real product screenshots on the landing page (items g17GWUkfKRFh4mgn0ciQ, x38DsNLjyh1rBTlkwMr5),
// from a clean demo organization seeded on the emulators (the Inbox e2e seed, inboxSeed.ts): made-up
// people, agents and work, never test or personal data. Shots: Today, a thread with a proposed
// reply, and a decision page (Ship it? with before/after screenshots and a chart).
// Run with `pnpm shots:landing`; it rewrites apps/web/src/landing/shots/*.webp (commit them).
// SHOTS_PREVIEW=<dir> also keeps the full-size PNGs there, to look at before committing.
test.skip(!process.env.SHOTS_LANDING, 'pnpm shots:landing makes the landing screenshots');

const OUT = join(import.meta.dirname, '../src/landing/shots');

/** Encodes a PNG screenshot as WebP at the given widths, in the browser (no image tools needed). */
async function toWebp(browser: Browser, png: Buffer, widths: number[]) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ src, widths }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return widths.map((w) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = Math.round((img.naturalHeight * w) / img.naturalWidth);
          const g = c.getContext('2d')!;
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, c.width, c.height);
          return { w, h: c.height, data: c.toDataURL('image/webp', 0.8).split(',')[1]! };
        });
      },
      { src: `data:image/png;base64,${png.toString('base64')}`, widths },
    );
  } finally {
    await page.close();
  }
}

async function save(browser: Browser, name: string, png: Buffer, widths: number[]) {
  mkdirSync(OUT, { recursive: true });
  const preview = process.env.SHOTS_PREVIEW;
  if (preview) {
    mkdirSync(preview, { recursive: true });
    writeFileSync(join(preview, `${name}.png`), png);
  }
  for (const { w, h, data } of await toWebp(browser, png, widths)) {
    writeFileSync(join(OUT, `${name}-${w}.webp`), Buffer.from(data, 'base64'));
    console.log(`shots: ${name}-${w}.webp ${w}x${h}`);
  }
}

/** A mock screenshot of the Inbox card, before or after the change (the same size). */
async function mock(page: Page, after: boolean): Promise<string> {
  const p = await page.context().newPage();
  await p.setViewportSize({ width: 420, height: 300 });
  await p.setContent(`<!doctype html><html><body style="margin:0;font:18px system-ui;background:#f6f5f2">
    <div style="margin:14px;padding:18px;min-height:220px;border:1px solid #ddd;border-radius:12px;background:#fff">
      <div style="font-size:12px;color:#888;letter-spacing:.08em">INBOX · RELEASES</div>
      <div style="margin-top:8px;font-size:24px;font-weight:600;line-height:1.2">${
        after ? 'Ship release 175 to hivenod.com?' : 'Release 175: Inbox summaries'
      }</div>
      <div style="margin-top:8px;color:#555">${
        after
          ? 'Everything passed: 612 of 612 checks. Desk agent recommends Approve.'
          : 'Release bot: PR #86 is ready: every thread gets a summary and Today…'
      }</div>
      ${
        after
          ? '<div style="margin-top:16px;display:flex;gap:8px"><span style="padding:8px 14px;border-radius:8px;background:#1f6f43;color:#fff">Approve</span><span style="padding:8px 14px;border-radius:8px;border:1px solid #ccc">Not now</span></div>'
          : '<div style="margin-top:16px;color:#888">3 messages · open the thread to read them</div>'
      }
    </div></body></html>`);
  const png = await p.screenshot({ type: 'png' });
  await p.close();
  return `data:image/png;base64,${png.toString('base64')}`;
}

const bar = {
  kind: 'bar',
  title: 'Check time, last 6 releases (min)',
  caption: 'Release 175 ran the checks in 10.8 min, the fastest of the last six.',
  unit: 'min',
  x: ['170', '171', '172', '173', '174', '175'],
  series: [{ name: 'Minutes', values: [14.2, 16.1, 13.4, 12.6, 12.1, 10.8] }],
  highlight: 5,
  better: 'down',
};

/** A reply thread without a calendar: Sam asks for the numbers, the agent drafts and checks. */
async function seedReply(s: Seed) {
  const tid = await s.agent.add(s.uid, {
    source: 'teams',
    from: 'Sam Okafor',
    text: 'Payments review: can you send the numbers?\nCould you send me the Q3 payments numbers before the review?',
    ref: 'numbers',
    id: 'sn1',
    at: at(0, 9),
  });
  await s.agent.file(tid, { subjectId: s.subjects.review });
  await s.agent.propose(
    tid,
    'reply',
    {
      text: 'Hi Sam, the Q3 payments numbers are in the shared folder. Shout if anything looks off.',
    },
    'Sam asked for the Q3 numbers; they are final and Rita has nothing to add.',
    {
      confidence: 'high',
      checks: ['The Q3 numbers: final, in the shared folder', 'Asked Rita by mail: nothing to add'],
    },
  );
  await s.agent.summary(tid, {
    headline: 'Sam wants the Q3 payments numbers before the review',
    ask: 'Send Sam the numbers?',
    answer: 'The numbers are final and in the shared folder.',
    recommendation: { action: 'Send', why: 'Rita has nothing to add' },
    confidence: 'high',
    bullets: [
      { text: 'Sam asked on Teams, before the payments review.' },
      { text: 'Q3 numbers: final, in the shared folder.' },
      { text: 'Rita checked by mail: nothing to add.' },
    ],
    visuals: [],
    noVisualWhy: 'A short reply with no data behind it.',
  });
  return tid;
}

/** A release thread waiting at Ship it?, with before/after screenshots attached at Build. */
async function seedDecision(page: Page, s: Seed) {
  const tid = await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Release bot',
    text: 'Release 175: Inbox summaries\nPR #86 is ready: the Inbox card shows the summary.',
    ref: 'rel175',
    id: 'gi1',
    at: at(0, 8),
  });
  await s.agent.file(tid, { newName: 'Releases', area: 'Hivenod' });
  const { planId, stepIds } = await s.agent.plan(
    tid,
    [
      { type: 'reply', fields: { text: 'Build: PR #86.' } },
      { type: 'approval', fields: { what: 'Ship it?', detail: '612 of 612 checks passed.' } },
      { type: 'approval', fields: { what: 'Accept on live' } },
    ],
    'Build, then ask before shipping.',
  );
  await adminUpdate(`workspaces/${s.wid}/inboxOutcomes/${stepIds[0]!}`, {
    state: 'done',
    result: {
      text: 'PR #86 open, checks green.',
      permalink: null,
      itemId: null,
      error: null,
      by: s.agent.aid,
      at: new Date(NOW),
    },
  });
  await adminUpdate(`workspaces/${s.wid}/inboxPlans/${planId}`, { state: 'active', cursor: 1 });
  const before = await s.agent.attach(tid, {
    kind: 'image',
    name: 'inbox-card-before.png',
    content: await mock(page, false),
  });
  const after = await s.agent.attach(tid, {
    kind: 'image',
    name: 'inbox-card-after.png',
    content: await mock(page, true),
  });
  await s.agent.summary(
    tid,
    {
      headline: 'Release 175: the Inbox card shows the summary',
      ask: 'Ship release 175 to hivenod.com?',
      answer: 'Everything passed: 612 of 612 checks, one screen changed.',
      recommendation: { action: 'Approve', why: 'rollback takes 1 min if needed' },
      confidence: 'high',
      bullets: [
        { text: 'The Inbox card leads with the ask and the recommendation.' },
        { text: 'Checks: 612 of 612 passed.' },
        { text: 'Check time down to 10.8 min.' },
      ],
      visuals: [
        {
          kind: 'image_pair',
          title: 'Inbox card, before and after',
          caption: 'The card now asks the question and shows Approve and Not now.',
          before,
          after,
        },
        bar,
      ],
    },
    { [before]: 'image', [after]: 'image' },
  );
  return tid;
}

test('landing screenshots of Inbox and Plans: Today, a thread and a decision page', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'one run makes every shot');
  test.setTimeout(150_000);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  await ctx.addInitScript(() => localStorage.setItem('hive-theme', 'dark'));
  const page = await ctx.newPage();
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  try {
    // Bookings and calendars are gone: the demo reply just agrees on Tuesday.
    await adminUpdate(`workspaces/${s.wid}/inboxOutcomes/${s.outcomes.book}`, {
      fields: { text: 'Tuesday works for us. See you then.' },
    });
    // Desktop: Today, the brief, the ranked decisions and the first decision card.
    await page.goto('/');
    await expect(page.locator('[data-decision-card]')).toBeVisible({ timeout: 20_000 });
    await settle(page);
    await page.waitForTimeout(400);
    await save(
      browser,
      'today',
      await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }),
      [930, 1860],
    );

    // Desktop: a thread with a proposed reply and what the agent checked (without the sidebar:
    // the shot sits in a narrower frame on the landing page).
    const reply = await seedReply(s);
    await page.goto(`/inbox/${s.wid}/t/${reply}`);
    await expect(
      page.getByText(/Q3 payments numbers are in the shared folder/).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    await settle(page);
    await page.waitForTimeout(400);
    await save(
      browser,
      'thread',
      await page.screenshot({ clip: { x: 276, y: 30, width: 1112, height: 840 } }),
      [640, 1280],
    );

    // Desktop: the decision page at Ship it?, with the plan, before/after and a chart.
    const dec = await seedDecision(page, s);
    await page.goto(`/inbox/${s.wid}/t/${dec}`);
    await expect(page.locator('[data-visual="image_pair"]')).toBeVisible({ timeout: 20_000 });
    await settle(page);
    await page.waitForTimeout(400);
    await save(
      browser,
      'decision',
      await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }),
      [930, 1860],
    );

    // Phone: Today at 390.
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
    });
    await phone.addInitScript(() => localStorage.setItem('hive-theme', 'dark'));
    const p2 = await phone.newPage();
    await freezeClock(p2);
    await p2.goto('/');
    await signIn(p2, s.me);
    await expect(p2.locator('[data-decision-card]')).toBeVisible({ timeout: 20_000 });
    await settle(p2);
    await p2.waitForTimeout(400);
    await save(browser, 'today-phone', await p2.screenshot(), [250, 500]);
    await p2.goto(`/inbox/${s.wid}/t/${dec}`);
    await expect(p2.locator('[data-visual="image_pair"]')).toBeVisible({ timeout: 20_000 });
    await settle(p2);
    await p2.waitForTimeout(400);
    await save(browser, 'decision-phone', await p2.screenshot(), [250, 500]);
    await phone.close();
  } finally {
    await s.stop();
    await ctx.close();
  }
});
