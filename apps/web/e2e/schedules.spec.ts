/**
 * Scheduled tasks, slice 6 (design 9.1, 9.3; schedules-desktop.png, schedules-phone.png): the
 * Schedules page and Today's scheduled parts, for a member with six schedules of two agents.
 *   - The page: the week timeline (stored runs with their result, planned runs computed from the
 *     rules), the month view, the list (rule, plan, next and last run), the detail with its next
 *     and past runs; Pause, Resume, Edit, Delete and Run now write through the rules.
 *   - Today: "Coming up" (today and tomorrow), the "can't run" card with Run now / Try later /
 *     Skip (decideRun), and the scheduler-offline banner while the beat is too old.
 * 1440 and 390, light and dark, axe-clean, no sideways scroll.
 *
 * NOW is Mon 15 Jun 2026 12:00 UTC (13:00 in Lisbon); the browser runs in UTC.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  adminSetAll,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  person,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const TZ = 'Europe/Lisbon';
const D = (iso: string) => new Date(iso);
const H = 3_600_000;

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots) await page.screenshot({ path: `${shots}/s6-${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const field = async (path: string, name: string) => (await adminDoc(path))?.fields[name];

interface Seeded {
  wid: string;
  uid: string;
  books: string;
  hive: string;
}

/** A member with agents Books and Hive, six schedules, past runs and one that couldn't run. */
async function seed(
  page: Page,
  beatAgoMs: number | null = 5 * 60_000,
  { freeze = true } = {},
): Promise<Seeded> {
  await fastTimers(page);
  // Try later is checked by the rules against the server's clock: that test runs on real time.
  if (freeze) await freezeClock(page);
  const me = person('Cara Lindqvist');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const agent = (name: string, color: string) => ({
    name,
    color,
    projectIds: '*',
    createdBy: uid,
    createdAt: new Date(NOW - 30 * 24 * H),
    revokedAt: null,
    lastSeenAt: new Date(NOW - 60_000),
    tokenHint: 'abcd',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  const books = `books${Math.random().toString(36).slice(2, 10)}`;
  const hive = `hive${Math.random().toString(36).slice(2, 10)}`;
  const at = new Date(NOW - 60 * 24 * H);
  const sch = (
    agentUid: string,
    title: string,
    what: string,
    rule: Record<string, unknown>,
    steps: Array<{ type: string; fields: Record<string, string> }>,
    state = 'active',
  ) => ({
    memberUid: uid,
    agentUid,
    title,
    what,
    rule: { tz: TZ, ...rule },
    runTitle: `${title} · {period}`,
    steps,
    templateId: null,
    subjectId: null,
    state,
    activeFrom: at,
    proposal: null,
    replaces: null,
    version: 1,
    createdBy: { type: 'human', id: uid },
    createdAt: at,
    updatedAt: at,
    lastEventId: 'seed',
  });
  const run = (
    sid: string,
    agentUid: string,
    key: string,
    period: string,
    due: Date,
    title: string,
    state: string,
    why: { code: string; text: string } | null = null,
  ): [string, Record<string, unknown>] => [
    `workspaces/${wid}/scheduleRuns/${sid}_${key}`,
    {
      memberUid: uid,
      scheduleId: sid,
      agentUid,
      key,
      period,
      dueAt: due,
      title,
      state,
      why,
      threadId: null,
      attempts: 1,
      laterAt: null,
      firedAt: due,
      startedAt: null,
      endedAt: null,
      ask: null,
      decision: null,
      scheduleVersion: 1,
      createdAt: due,
      updatedAt: due,
      lastEventId: 'seed',
    },
  ];
  const approve = (what: string) => ({ type: 'approval', fields: { what } });
  const reply = (text: string) => ({ type: 'reply', fields: { text } });
  const docs: Array<[string, Record<string, unknown>]> = [
    [`workspaces/${wid}/agents/${books}`, agent('Books', '#2F5FD0')],
    [`workspaces/${wid}/agents/${hive}`, agent('Hive', '#7A4FD0')],
    [
      `workspaces/${wid}/schedules/invoices`,
      sch(
        books,
        'Send invoices',
        'Prepare last month’s invoices from the hours log, ask me before sending.',
        { freq: 'monthly', at: '09:00', monthDay: 1 },
        [reply('Invoices for {period} are ready.'), approve('Send the invoices')],
      ),
    ],
    [
      `workspaces/${wid}/schedules/timesheet`,
      sch(
        hive,
        'Timesheet',
        'Fill this week’s timesheet from the calendar and submit it.',
        { freq: 'weekly', at: '16:00', weekdays: [1] },
        [reply('Timesheet for {period} filled.'), approve('Submit it')],
      ),
    ],
    [
      `workspaces/${wid}/schedules/tidy`,
      sch(
        hive,
        'Inbox tidy-up',
        'Archive newsletters and file receipts.',
        { freq: 'daily', at: '08:00', weekdays: [1, 2, 3, 4, 5] },
        [reply('Tidied up.')],
      ),
    ],
    [
      `workspaces/${wid}/schedules/retainer`,
      sch(
        books,
        'Pay supplier retainer',
        'Prepare the monthly retainer payment.',
        { freq: 'monthly', at: '10:00', monthDay: 12 },
        [reply('Retainer ready.'), approve('Pay it')],
      ),
    ],
    [
      `workspaces/${wid}/schedules/domain`,
      sch(
        hive,
        'Renew the domain',
        'Check the renewal price and renew.',
        { freq: 'yearly', at: '09:00', month: 3, monthDay: 2 },
        [reply('Renewal checked.'), approve('Renew')],
      ),
    ],
    [
      `workspaces/${wid}/schedules/newsletter`,
      sch(
        hive,
        'Newsletter draft',
        'Draft the monthly newsletter.',
        { freq: 'monthly', at: '10:00', monthDay: 25 },
        [reply('Draft ready.')],
        'paused',
      ),
    ],
  ];
  docs.push(
    run(
      'invoices',
      books,
      '2026-06',
      'Jun 2026',
      D('2026-06-01T08:00:00Z'),
      'Send invoices · Jun 2026',
      'done',
    ),
    run(
      'tidy',
      hive,
      '2026-06-15',
      '15 Jun 2026',
      D('2026-06-15T07:00:00Z'),
      'Inbox tidy-up · 15 Jun 2026',
      'done',
    ),
    run(
      'tidy',
      hive,
      '2026-06-12',
      '12 Jun 2026',
      D('2026-06-12T07:00:00Z'),
      'Inbox tidy-up · 12 Jun 2026',
      'expired',
    ),
    run(
      'retainer',
      books,
      '2026-06',
      'Jun 2026',
      D('2026-06-12T09:00:00Z'),
      'Pay supplier retainer · Jun 2026',
      'cantRun',
      {
        code: 'failed',
        text: 'Books could not do it: bank sign-in expired',
      },
    ),
  );
  await adminSetAll(docs);
  if (beatAgoMs !== null)
    await adminSet('config/scheduler', {
      beatAt: new Date(NOW - beatAgoMs),
      host: 'e2e',
      version: 'e2e',
    });
  return { wid, uid, books, hive };
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the Schedules page: timeline, list, detail; Pause, Resume, Edit, Run now, Delete', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await seed(page);
    // The sidebar entry under You.
    await page
      .getByRole('navigation', { name: 'You, all organizations' })
      .getByRole('link', { name: 'Schedules' })
      .click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();

    // The run that couldn't happen, loudest first.
    const card = page.locator('[data-cant-run="retainer_2026-06"]');
    await expect(card).toContainText('High · Monthly run didn’t happen');
    await expect(card).toContainText(
      'Pay supplier retainer · Jun 2026 did not run on Fri 12 Jun at 10:00',
    );
    await expect(card).toContainText('bank sign-in expired');

    // The week: stored runs with their result, planned runs from now on.
    const tl = page.getByRole('region', { name: 'Timeline' });
    await expect(tl.locator('[data-timeline-title]')).toHaveText('Week of 15 Jun – 21 Jun 2026');
    const mon = tl.getByRole('region', { name: 'Mon 15 Jun' });
    await expect(mon.getByRole('button', { name: /Inbox tidy-up, 08:00, done/ })).toBeVisible();
    await expect(
      mon.getByRole('button', { name: /Timesheet, 16:00, planned, Hive/ }),
    ).toBeVisible();
    await expect(
      tl
        .getByRole('region', { name: 'Fri 19 Jun' })
        .getByRole('button', { name: /Inbox tidy-up, 08:00, planned/ }),
    ).toBeVisible();
    await expect(tl.getByRole('region', { name: 'Sat 20 Jun' }).getByRole('button')).toHaveCount(0);

    // The list: next run first, paused last.
    const list = page.getByRole('region', { name: 'All schedules' });
    const rows = list.locator('[data-schedule-row]');
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText('Timesheet');
    await expect(rows.first()).toContainText('Weekly · Mon · 16:00');
    await expect(rows.first()).toContainText('Today 16:00');
    await expect(rows.last()).toContainText('Newsletter draft');
    await expect(rows.last()).toContainText('Paused');
    const inv = list.locator('[data-schedule-row="invoices"]');
    await expect(inv).toContainText('Monthly · day 1 · 09:00');
    await expect(inv).toContainText('Wed 1 Jul 09:00');
    await expect(inv.locator('[data-run-state="done"]')).toHaveText('✓ 1 Jun');
    await expect(inv.locator('[data-plan-pills] li')).toHaveCount(2);

    // The detail.
    await inv.getByRole('button', { name: 'Send invoices', exact: true }).click();
    await expect(page).toHaveURL(/s=.*invoices/);
    const det = page.locator('[data-schedule-detail="invoices"]');
    await expect(det.locator('[data-detail-when]')).toContainText('Monthly · day 1 · 09:00');
    await expect(det.locator('[data-detail-next] li')).toHaveCount(3);
    await expect(det.locator('[data-detail-next] li').first()).toContainText('Jul 2026');
    await expect(det.locator('[data-detail-past] li')).toHaveCount(1);
    await look(page, 'page-1440');

    // Month.
    await tl.getByRole('button', { name: 'Month' }).click();
    await expect(tl.locator('[data-timeline-title]')).toHaveText('June 2026');
    await expect(tl.locator('[data-month]')).toBeVisible();
    await tl.getByRole('button', { name: 'Next month' }).click();
    await expect(tl.locator('[data-timeline-title]')).toHaveText('July 2026');
    await tl.getByRole('button', { name: 'Week' }).click();

    // Pause, then resume (the rules check each write).
    const path = `workspaces/${s.wid}/schedules/invoices`;
    await det.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(async () => (await field(path, 'state'))?.stringValue).toBe('paused');
    await expect(det.getByRole('button', { name: 'Resume' })).toBeVisible();
    await det.getByRole('button', { name: 'Resume' }).click();
    await expect.poll(async () => (await field(path, 'state'))?.stringValue).toBe('active');

    // Edit the time.
    await det.getByRole('button', { name: 'Edit' }).click();
    const form = page.locator('[data-schedule-form]');
    await form.getByLabel('Time', { exact: true }).fill('09:30');
    await expect(form.locator('[data-form-sentence]')).toHaveText('Monthly · day 1 · 09:30');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect
      .poll(async () => (await field(path, 'rule'))?.mapValue?.fields?.at?.stringValue)
      .toBe('09:30');
    await expect(det.locator('[data-detail-when]')).toContainText('09:30');

    // Delete (confirmed); its past runs stay.
    await det.getByRole('button', { name: 'Delete' }).click();
    await page.locator('[data-confirm-delete]').click();
    await expect.poll(() => adminDoc(path)).toBeNull();
    await expect(list.locator('[data-schedule-row]')).toHaveCount(5);
    expect(await adminDoc(`workspaces/${s.wid}/scheduleRuns/invoices_2026-06`)).not.toBeNull();

    // Run now, outside the schedule: a thread to its agent.
    await list
      .locator('[data-schedule-row="timesheet"]')
      .getByRole('button', { name: 'Timesheet', exact: true })
      .click();
    await page.locator('[data-detail-run-now]').click();
    await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/`));
    await expect(
      page.getByRole('heading', { name: 'Timesheet · 15 Jun 2026 · run now', level: 1 }),
    ).toBeVisible();
  });

  test('End: confirmed, the schedule stops, stays listed greyed with its history', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await seed(page);
    await page.goto('/schedules');
    const list = page.getByRole('region', { name: 'All schedules' });
    const row = list.locator('[data-schedule-row="tidy"]');
    await row.getByRole('button', { name: 'Inbox tidy-up', exact: true }).click();
    const det = page.locator('[data-schedule-detail="tidy"]');
    // End sits next to Pause; Keep it running leaves everything as it was.
    await expect(det.getByRole('button', { name: 'Pause' })).toBeVisible();
    await look(page, 'end-before-1440');
    await det.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('End “Inbox tidy-up”?');
    await page.getByRole('button', { name: 'Keep it running' }).click();
    expect((await field(`workspaces/${s.wid}/schedules/tidy`, 'state'))?.stringValue).toBe(
      'active',
    );
    await det.getByRole('button', { name: 'End', exact: true }).click();
    await page.locator('[data-confirm-end]').click();
    await expect
      .poll(async () => (await field(`workspaces/${s.wid}/schedules/tidy`, 'state'))?.stringValue)
      .toBe('ended');
    expect((await field(`workspaces/${s.wid}/schedules/tidy`, 'version'))?.integerValue).toBe('2');
    // Still listed (6 rows), last, greyed, with its history; nothing but Delete is left.
    await expect(list.locator('[data-schedule-row]')).toHaveCount(6);
    await expect(list.locator('[data-schedule-row]').last()).toHaveAttribute(
      'data-schedule-state',
      'ended',
    );
    await expect(list.locator('[data-schedule-row="tidy"]')).toContainText('Ended');
    await expect(det).toContainText('Ended: no more runs');
    await expect(det.locator('[data-detail-past] li')).toHaveCount(2);
    await expect(det.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(det.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await expect(det.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(det.getByRole('button', { name: 'Delete' })).toBeVisible();
    await look(page, 'end-after-1440');
    // It no longer shows as coming up, and its runs stay in the store.
    expect(await adminDoc(`workspaces/${s.wid}/scheduleRuns/tidy_2026-06-15`)).not.toBeNull();
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Coming up' })).not.toContainText(
      'Inbox tidy-up',
    );
  });

  test('Today: Coming up, Run now / Try later / Skip, and the scheduler-offline banner', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const s = await seed(page, 2 * H);
    await page.goto('/');
    const coming = page.getByRole('region', { name: 'Coming up' });
    await expect(coming.locator('[data-coming-run]').first()).toContainText(
      'Timesheet · 15 Jun 2026',
    );
    await expect(coming.locator('[data-coming-run]').first()).toContainText('Today 16:00');
    await expect(coming.locator('[data-coming-run]').nth(1)).toContainText('Tomorrow 08:00');
    await expect(coming.getByRole('link', { name: 'All schedules' })).toHaveAttribute(
      'href',
      '/schedules',
    );

    // The beat is 2 hours old: the banner says so.
    // (Other tests write a fresh beat when they start: write the old one again until it shows.)
    const banner = page.locator('[data-scheduler-banner]');
    await expect(async () => {
      await adminSet('config/scheduler', {
        beatAt: new Date(NOW - 2 * H),
        host: 'e2e',
        version: 'e2e',
      });
      await expect(banner).toContainText('Scheduler offline since 10:00', { timeout: 2000 });
    }).toPass({ timeout: 20_000 });

    const card = page.locator('[data-cant-run="retainer_2026-06"]');
    await expect(card).toContainText('If skipped, the next run is Sun 12 Jul 10:00.');
    await look(page, 'today-1440');

    // Run now, then (asked again) Skip.
    const run = `workspaces/${s.wid}/scheduleRuns/retainer_2026-06`;
    await card.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(async () => (await field(run, 'state'))?.stringValue).toBe('runNow');
    await adminSetAll([
      [run, { ...(await rawRun(run)), state: 'cantRun', laterAt: null, decision: null }],
    ]);
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Skip this one' }).click();
    await expect.poll(async () => (await field(run, 'state'))?.stringValue).toBe('skipped');
    await expect(card).toBeHidden();

    // The beat comes back: the banner goes.
    await adminSet('config/scheduler', { beatAt: new Date(NOW), host: 'e2e', version: 'e2e' });
    await expect(banner).toBeHidden();
  });
});

test('Today: Try later, in 1 hour or at a typed time', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the same card on every screen');
  test.setTimeout(120_000);
  const s = await seed(page, 5 * 60_000, { freeze: false });
  await page.goto('/');
  const card = page.locator('[data-cant-run="retainer_2026-06"]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  const run = `workspaces/${s.wid}/scheduleRuns/retainer_2026-06`;
  await card.getByRole('button', { name: 'Try later' }).click();
  await page.locator('[data-later-hour]').click();
  await expect.poll(async () => (await field(run, 'state'))?.stringValue).toBe('later');
  const later = Date.parse(String((await field(run, 'laterAt'))?.timestampValue));
  expect(Math.abs(later - (Date.now() + H))).toBeLessThan(5 * 60_000);
  await expect(card).toBeHidden();

  // Asked again: a typed time that has passed is refused, "tomorrow 10:00" is taken.
  await adminSetAll([
    [run, { ...(await rawRun(run)), state: 'cantRun', laterAt: null, decision: null }],
  ]);
  await card.getByRole('button', { name: 'Try later' }).click();
  const box = page.getByLabel('Pick a time');
  await box.fill('yesterday');
  await page.locator('[data-later-typed]').click();
  await expect(page.getByText('I could not read that time.')).toBeVisible();
  await box.fill('tomorrow 10:00');
  await page.locator('[data-later-typed]').click();
  await expect.poll(async () => (await field(run, 'state'))?.stringValue).toBe('later');
});

/** A run doc as plain values (to write it back with a changed state). */
async function rawRun(path: string): Promise<Record<string, unknown>> {
  const d = await adminDoc(path);
  const out: Record<string, unknown> = {};
  const dec = (v: Record<string, unknown>): unknown => {
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('timestampValue' in v) return new Date(String(v.timestampValue));
    if ('nullValue' in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('mapValue' in v) {
      const f = (v.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
      return Object.fromEntries(Object.entries(f).map(([k, x]) => [k, dec(x)]));
    }
    if ('arrayValue' in v)
      return ((v.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map(dec);
    return null;
  };
  for (const [k, v] of Object.entries(d!.fields)) out[k] = dec(v);
  return out;
}

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the agenda, the cards and the detail as a page; Today on the phone', async ({ page }) => {
    test.setTimeout(150_000);
    await seed(page);
    await page.goto('/schedules');
    await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
    const tl = page.getByRole('region', { name: 'Timeline' });
    await expect(tl.locator('[data-timeline-title]')).toHaveText('Next 7 days');
    await expect(tl.locator('[data-agenda] section').first()).toHaveAccessibleName('Mon 15 Jun');
    await expect(page.locator('[data-cant-run]')).toHaveCount(1);
    const list = page.getByRole('region', { name: 'All schedules' });
    await expect(list.locator('[data-schedule-row]')).toHaveCount(6);
    await look(page, 'page-390');

    await list
      .locator('[data-schedule-row="domain"]')
      .getByRole('button', { name: /^Renew the domain/ })
      .click();
    const det = page.locator('[data-schedule-detail="domain"]');
    await expect(det).toContainText('Yearly · 2 Mar · 09:00');
    await expect(det.locator('[data-detail-next] li').first()).toContainText(
      'Tue 2 Mar 2027 09:00',
    );
    await look(page, 'detail-390');
    await page.getByRole('button', { name: 'Schedules' }).click();
    await expect(list).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Coming up' })).toBeVisible();
    await expect(page.locator('[data-cant-run]')).toHaveCount(1);
    await look(page, 'today-390');
  });
});
