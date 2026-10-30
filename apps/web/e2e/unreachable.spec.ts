import { expect, test, type Page } from '@playwright/test';
import { adminDoc, adminSet, person, signIn, uidOf, workspaceOf, fastTimers } from './helpers';

// Card M0Caulbg: with Firestore unreachable and a cold cache the SDK raises no error, it serves
// empty cached snapshots. Screens must say "Can't reach the server" with Retry, never show an
// empty list or an endless skeleton, and must recover when the server answers.
const FIRESTORE = `**:${process.env.VITE_FIRESTORE_EMULATOR_PORT ?? 8080}/**`;

test('cold cache + unreachable Firestore: every main screen offers Retry, then recovers', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = person('Una Unreachable');
  await fastTimers(page, { undo: false, unreachable: true });
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');

  await blockAndWipeCache(page);

  await page.goto('/');
  const stuck = page.getByTestId('unreachable');
  await expect(stuck).toBeVisible({ timeout: 25_000 });
  await expect(stuck.getByText("Can't reach the server")).toBeVisible();
  await expect(stuck.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByText('Nothing needs you.')).toHaveCount(0);
  // (With nothing cached, even the profile waits on the server: the whole app shows this state,
  // so the shell and its Reconnecting banner are not up yet.)

  // Every main screen shows the same state (a full load each, so each starts cold).
  for (const path of ['/inbox', '/activity', '/agents']) {
    await page.goto(path);
    await expect(page.getByTestId('unreachable')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText('No agents yet')).toHaveCount(0);
  }

  // The server comes back: Retry loads the real data.
  await page.unroute(FIRESTORE);
  await page.getByTestId('unreachable').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('unreachable')).toHaveCount(0, { timeout: 20_000 });
  await page.goto('/agents');
  await expect(page.getByText('No agents yet')).toBeVisible({ timeout: 20_000 });
});

/** Blocks the Firestore host, then empties its local cache (IndexedDB) from a blank page. Auth stays. */
async function blockAndWipeCache(page: Page) {
  await page.route(FIRESTORE, (r) => r.abort());
  await page.route('**/__blank', (r) =>
    r.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('/__blank');
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .filter((d) => d.name?.startsWith('firestore'))
        .map(
          (d) =>
            new Promise<void>((res) => {
              const q = indexedDB.deleteDatabase(d.name!);
              q.onsuccess = q.onerror = q.onblocked = () => res();
            }),
        ),
    );
  });
}

/** Writes the Firestore SDK has queued locally (its IndexedDB 'mutations' store), not yet sent. */
async function pendingMutations(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    let total = 0;
    for (const d of dbs.filter((x) => x.name?.startsWith('firestore'))) {
      total += await new Promise<number>((res) => {
        const open = indexedDB.open(d.name!);
        open.onerror = () => res(0);
        open.onsuccess = () => {
          const idb = open.result;
          if (!idb.objectStoreNames.contains('mutations')) {
            idb.close();
            return res(0);
          }
          const count = idb.transaction('mutations').objectStore('mutations').count();
          count.onsuccess = () => {
            idb.close();
            res(count.result);
          };
          count.onerror = () => {
            idb.close();
            res(0);
          };
        };
      });
    }
    return total;
  });
}

// The data-loss half of card M0Caulbg: a cold cache read "no profile", the app took the person for
// a new user and queued a batch that created a junk organization and rewrote users/{uid} (only
// that organization, theme reset). Nothing may be queued, and the server profile must not change.
test('cold cache + unreachable Firestore: nothing is queued and the profile survives', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = person('Pia Profile');
  await fastTimers(page, { undo: false, unreachable: true });
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);

  // A second organization and a theme: the things the bogus batch would have wiped.
  const w2 = `second${Date.now().toString(36)}`;
  await adminSet(`workspaces/${w2}`, {
    name: 'Second Org',
    ownerUid: uid,
    memberRoles: { [uid]: 'admin' },
    adminUids: [uid],
    createdAt: new Date(),
    lastEventId: 'seed',
  });
  const before = (await adminDoc(`users/${uid}`))!.fields;
  await adminSet(`users/${uid}`, {
    name: before.name!.stringValue,
    email: before.email!.stringValue,
    photoURL: before.photoURL?.stringValue ?? null,
    color: before.color!.stringValue,
    workspaceId: wid,
    workspaceIds: [wid, w2],
    theme: 'dark',
  });
  const server = (await adminDoc(`users/${uid}`))!.fields;

  await blockAndWipeCache(page);
  await page.goto('/');

  // Waiting on the server: the unreachable state, never a fresh organization or empty screens.
  const stuck = page.getByTestId('unreachable');
  await expect(stuck).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText('Nothing needs you.')).toHaveCount(0);
  await expect(page.getByText(/organization$/)).toHaveCount(0);
  expect(await pendingMutations(page)).toBe(0);

  // Retry while still blocked: the button stays, disabled, then comes back.
  await stuck.getByRole('button', { name: 'Retry' }).click();
  const retrying = stuck.getByRole('button', { name: /Retrying/ });
  await expect(retrying).toBeVisible();
  await expect(retrying).toBeDisabled();
  await expect(stuck.getByRole('button', { name: 'Retry' })).toBeEnabled({ timeout: 15_000 });
  expect(await pendingMutations(page)).toBe(0);

  // The server is back: the real organization loads and the profile on the server is untouched.
  await page.unroute(FIRESTORE);
  await stuck.getByRole('button', { name: 'Retry' }).click();
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('unreachable')).toHaveCount(0);
  expect(await pendingMutations(page)).toBe(0);
  expect((await adminDoc(`users/${uid}`))!.fields).toEqual(server);
});
