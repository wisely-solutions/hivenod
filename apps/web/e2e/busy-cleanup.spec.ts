/**
 * Inbox item 40jle: a member's leftover busy blocks of organizations they are no longer in
 * (removed by an admin, or gone) are cleared when they open the app; blocks of an organization
 * they remain in survive. Nothing changes on screen.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  person,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const block = (wid: string, start: number) => ({
  workspaceId: wid,
  start: new Date(Date.now() + start * 3_600_000),
  end: new Date(Date.now() + (start + 1) * 3_600_000),
  deleted: false,
  updatedAt: new Date(),
  lastEventId: 'seed',
});

test('leftover busy blocks of organizations I am not in are cleared on open', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const me = person('Una Leftover');
  await page.goto('/');
  await signIn(page, me);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const removedFrom = `removed${tag}`;
  const gone = `gone${tag}`;
  // An organization an admin removed me from.
  await adminSet(`workspaces/${removedFrom}`, {
    name: 'Former Client',
    ownerUid: 'zoe',
    memberRoles: { zoe: 'admin' },
    adminUids: ['zoe'],
    createdAt: new Date(),
    lastEventId: 'seed',
  });
  const stale = [`users/${uid}/busy/${removedFrom}_a`, `users/${uid}/busy/${gone}_a`];
  const live = `users/${uid}/busy/${wid}_a`;
  await adminSet(stale[0]!, block(removedFrom, 2));
  await adminSet(stale[1]!, block(gone, 4));
  await adminSet(live, block(wid, 6));

  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(stale[0]!)) === null, { timeout: 30_000 })
    .toBe(true);
  expect(await adminDoc(stale[1]!)).toBeNull();
  expect(await adminDoc(live)).not.toBeNull();

  await expectNoHorizontalScroll(page);
  await settle(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  }
  void info;
});
