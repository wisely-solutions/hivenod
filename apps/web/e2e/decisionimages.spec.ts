/**
 * Image visuals at a decision (item OE8FmrTaIxFVGcaeGG3N, slice 4; design 5 "Images", criteria
 * 8 and 8b): the Build step attached before/after screenshots and the agent's summary shows them
 * as an image pair next to a check-time chart. At Ship it? the top card, the bullets, the pair and
 * the chart are visible without unfolding; the pair sits side by side at 1440 and stacked at 390;
 * Compare lays one over the other; a click opens the image full size; the files are in Everything.
 * Light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  settle,
} from './helpers';
import { at, seedInbox, type Seed } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(400);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A mock screenshot of the Inbox card, before or after the change (the same size). */
async function screenshot(page: Page, after: boolean): Promise<string> {
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

const oPath = (s: Seed, oid: string) => `workspaces/${s.wid}/inboxOutcomes/${oid}`;
const done = (s: Seed, text: string) => ({
  state: 'done',
  result: { text, permalink: null, itemId: null, error: null, by: s.agent.aid, at: new Date(NOW) },
});

/** A release thread waiting at Ship it?, with before/after screenshots attached at Build. */
async function seedShots(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const tid = await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Release bot',
    text: 'Release 175: Inbox summaries\nPR #86 is ready: the Inbox card shows the summary.',
    ref: 'rel175img',
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
  await adminUpdate(oPath(s, stepIds[0]!), done(s, 'PR #86 open, checks green.'));
  await adminUpdate(`workspaces/${s.wid}/inboxPlans/${planId}`, { state: 'active', cursor: 1 });
  const before = await s.agent.attach(tid, {
    kind: 'image',
    name: 'inbox-card-before.png',
    content: await screenshot(page, false),
  });
  const after = await s.agent.attach(tid, {
    kind: 'image',
    name: 'inbox-card-after.png',
    content: await screenshot(page, true),
  });
  const report = await s.agent.attach(tid, {
    kind: 'html',
    name: 'check-report.html',
    content: '<h1>Checks</h1><p>612 of 612 passed.</p>',
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
    { [before]: 'image', [after]: 'image', [report]: 'html' },
  );
  return { s, tid, before, after };
}

const top = (page: Page) => page.getByRole('region', { name: 'Decision' });
const CAP = 'The card now asks the question and shows Approve and Not now.';

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('Ship it? with a before/after pair and a chart, visible without unfolding', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { s, tid } = await seedShots(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const t = top(page);
      await expect(t.getByRole('heading', { level: 2 })).toHaveText(
        'Ship release 175 to hivenod.com?',
        { timeout: 20_000 },
      );
      const pair = page.locator('[data-visual="image_pair"]');
      const b4 = pair.getByAltText(`Before: ${CAP}`);
      const af = pair.getByAltText(`After: ${CAP}`);
      await expect(b4).toBeVisible();
      await expect(af).toBeVisible();
      await expect(page.locator('[data-visual="bar"]')).toBeVisible();
      // Visible without unfolding: top card, bullets, pair and chart in the first screen.
      for (const l of [t, page.getByRole('list', { name: 'Summary' }), pair])
        await expect(l).toBeInViewport();
      await expect(page.locator('[data-visual="bar"]')).toBeInViewport();
      // Side by side.
      const [bb, ab] = [(await b4.boundingBox())!, (await af.boundingBox())!];
      expect(Math.abs(bb.y - ab.y)).toBeLessThan(4);
      expect(ab.x).toBeGreaterThan(bb.x + bb.width - 1);
      await look(page, 'slice4-approval-1440');

      // Compare: the same size, so one over the other with a slider.
      await pair.getByRole('button', { name: 'Compare' }).click();
      await expect(pair.locator('[data-compare]')).toBeVisible();
      await pair.getByRole('slider').fill('20');
      await pair.getByRole('button', { name: 'Compare' }).click();

      // Full size in the viewer.
      await pair.getByRole('button', { name: /Open .*After full size/ }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('img', { name: 'inbox-card-after.png' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();

      // Everything lists the files: images inline, the HTML report opens sandboxed.
      await page.getByRole('button', { name: /^Everything/ }).click();
      const files = page.locator('[data-thread-files]');
      await expect(files).toContainText('Files from Desk agent');
      await expect(files.getByRole('img', { name: 'inbox-card-before.png' })).toBeVisible();
      await files.getByRole('button', { name: /check-report\.html/ }).click();
      await expect(page.getByRole('dialog').locator('iframe[sandbox]')).toHaveCount(1);
    } finally {
      await s.stop();
    }
  });

  test('an image the thread does not have is not shown', async ({ page }) => {
    test.setTimeout(120_000);
    const { s, tid, before } = await seedShots(page);
    try {
      // What a broken agent could leave (the rules refuse it; written as admin here).
      await adminUpdate(`workspaces/${s.wid}/inboxSummaries/${tid}`, {
        visuals: [
          {
            kind: 'image_pair',
            title: 'Other',
            caption: 'Another thread',
            before,
            after: 'itother_x1',
            labels: null,
          },
        ],
      });
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const pair = page.locator('[data-visual="image_pair"]');
      await expect(pair.locator('[data-image-missing]')).toHaveText(
        'The after image isn’t available on this thread.',
        { timeout: 20_000 },
      );
      await expect(pair.locator('img')).toHaveCount(1);
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the pair stacks; before above after', async ({ page }) => {
    test.setTimeout(180_000);
    const { s, tid } = await seedShots(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const pair = page.locator('[data-visual="image_pair"]');
      const b4 = pair.getByAltText(`Before: ${CAP}`);
      const af = pair.getByAltText(`After: ${CAP}`);
      await expect(af).toBeVisible({ timeout: 20_000 });
      expect((await af.boundingBox())!.y).toBeGreaterThan((await b4.boundingBox())!.y + 40);
      await look(page, 'slice4-approval-390');
    } finally {
      await s.stop();
    }
  });
});
