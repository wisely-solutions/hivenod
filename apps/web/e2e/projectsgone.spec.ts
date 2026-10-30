/**
 * Projects were removed from the web app (item OE8FmrTaIxFVGcaeGG3N, slice 10). Old links still
 * land somewhere useful: an item the migration moved to Inbox opens its thread (the thread id is
 * derived from organization, project and item, scripts/migrate-project-lib.mjs), anything else
 * opens Inbox.
 */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminDoc, FIRESTORE_PORT } from './helpers';
import { seedInbox } from './inboxSeed';

const DOCS = `http://localhost:${FIRESTORE_PORT}/v1/projects/hive-board-43be/databases/(default)/documents`;
const migrated = (wid: string, pid: string, iid: string) =>
  `mg${createHash('sha256').update(`${wid}\u0000${pid}\u0000${iid}`).digest('hex').slice(0, 24)}`;

test('an old item link opens the thread it was moved to; other project links open Inbox', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const s = await seedInbox(page, 'Mira Migrated');
  try {
    // A thread the migration made for item "launch" of project "web": a copy of a seeded one.
    const tid = migrated(s.wid, 'web', 'launch');
    const src = await adminDoc(`workspaces/${s.wid}/inboxThreads/${s.threads.review}`);
    const res = await fetch(`${DOCS}/workspaces/${s.wid}/inboxThreads/${tid}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: src!.fields }),
    });
    expect(res.ok, await res.text()).toBe(true);

    await page.goto('/p/web?item=launch');
    await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${tid}$`), { timeout: 20_000 });
    await page.goto('/p/web/i/launch/view/a1');
    await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${tid}$`), { timeout: 20_000 });

    // Not migrated, or no item: Inbox.
    for (const old of ['/p/web?item=other', '/p/web', '/projects', '/items']) {
      await page.goto(old);
      await expect(page).toHaveURL(/\/inbox$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
    }
  } finally {
    await s.stop();
  }
});
