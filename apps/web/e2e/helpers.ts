import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { pollFor } from './poll';

const rand = () => Math.random().toString(36).slice(2, 8);

export interface Person {
  name: string;
  email: string;
}
export const person = (name: string): Person => ({
  name,
  email: `${name.toLowerCase().replace(/\W+/g, '.')}.${rand()}@example.com`,
});

/**
 * Clicks "Continue with Google" and completes the Auth emulator's fake Google page, whether the app
 * opened it in a popup (desktop) or navigated to it (phones).
 */
export async function signIn(
  page: Page,
  who: Person,
  buttonName = 'Continue with Google',
  { ui = false } = {},
) {
  const button = page.getByRole('button', { name: buttonName });
  // The first page at "/" is the product page: its Sign in link opens the sign-in panel.
  const nav = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' });
  await button.or(nav).first().waitFor();
  if (!(await button.isVisible())) await nav.click();
  if (!ui) {
    // The app's own button, but the Auth emulator is handed the sign-in directly (no fake Google
    // page, no popup or redirect): about 2 s less per test. auth.spec drives the real flows (ui: true).
    await page.evaluate((w) => localStorage.setItem('hive.e2e.signin', JSON.stringify(w)), {
      email: who.email,
      name: who.name,
    });
    await button.click();
    await expect(button).toBeHidden({ timeout: 20_000 });
    await page.evaluate(() => localStorage.removeItem('hive.e2e.signin'));
    return;
  }
  const popupWait = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
  await button.click();
  const popup = await popupWait;
  const target = popup ?? page;
  await target.waitForURL(/emulator\/auth\/handler/);
  await target.locator('#add-account-button').click();
  await target.locator('#email-input').fill(who.email);
  await target.locator('#display-name-input').fill(who.name);
  await target.locator('#sign-in').click();
  if (popup) await popup.waitForEvent('close').catch(() => undefined);
  // Redirect flow (phones): wait until the browser is back on the app, or a following goto() cuts the sign-in short.
  else await page.waitForURL((u) => !/emulator\/auth\/handler/.test(u.href));
}

/** A fresh browser context (own storage) on the same device, so two people can be signed in at once. */
export async function newPerson(browser: Browser) {
  const u = test.info().project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
  });
  return { ctx, page: await ctx.newPage() };
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

/**
 * Waits until the page has settled, instead of sleeping a guessed time before axe or a screenshot:
 * nothing is loading (no aria-busy region), no short CSS animation or transition is running, and no
 * element moved, resized, faded or changed text for 300 ms (three looks 100 ms apart; Motion's
 * JS-driven springs and count-ups do not show up in getAnimations()). Long or endless effects (a toast's
 * countdown bar, the drifting backdrop, a live pulse) are ambient: they and what they move are ignored.
 * `loading: false` skips the aria-busy check (the kit page shows a skeleton on purpose).
 */
export async function settle(page: Page, { loading = true, timeout = 10_000 } = {}) {
  if (loading) await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout });
  await page.evaluate(() => delete (window as { __settle?: [string, number] }).__settle);
  await page.waitForFunction(
    () => {
      const w = window as { __settle?: [string, number] };
      const ambient: Element[] = [];
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running') continue;
        const fx = a.effect as KeyframeEffect | null;
        if (Number(fx?.getComputedTiming().endTime ?? 0) <= 1000) return false; // still animating
        if (fx?.target) ambient.push(fx.target);
      }
      const parts: string[] = [document.body.innerText];
      for (const e of document.querySelectorAll('body *')) {
        if (ambient.some((a) => a.contains(e))) continue;
        const s = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        parts.push(
          `${s.opacity} ${s.transform} ${r.x | 0},${r.y | 0},${r.width | 0},${r.height | 0}`,
        );
      }
      const sig = parts.join('|');
      const same = w.__settle?.[0] === sig ? w.__settle[1] + 1 : 0;
      w.__settle = [sig, same];
      return same >= 3;
    },
    undefined,
    { polling: 100, timeout },
  );
}

export const FIRESTORE_PORT = Number(process.env.E2E_FIRESTORE_PORT ?? 8080);
export const AUTH_PORT = Number(process.env.E2E_AUTH_PORT ?? 9099);
const FIRESTORE = `http://localhost:${FIRESTORE_PORT}/v1/projects/hive-board-43be/databases/(default)/documents`;

/** Writes a document as the emulator's admin (skips rules), to set up states the app cannot make. */
export async function adminPatch(path: string, fields: Record<string, unknown>) {
  const enc = (v: unknown): object =>
    v === null
      ? { nullValue: null }
      : v instanceof Date
        ? { timestampValue: v.toISOString() }
        : { stringValue: String(v) };
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join('&');
  const res = await fetch(`${FIRESTORE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])),
    }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

export function parseInvite(url: string) {
  const m = /\/join\/([^/]+)\/([^/?]+)/.exec(url);
  if (!m) throw new Error(`Not an invite link: ${url}`);
  return { wid: m[1]!, code: m[2]! };
}

/** The theme saved on a person's profile, read straight from the emulator. */
export async function userTheme(email: string): Promise<string | null> {
  const res = await fetch(`${FIRESTORE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'email' },
            op: 'EQUAL',
            value: { stringValue: email },
          },
        },
        limit: 1,
      },
    }),
  });
  const rows = (await res.json()) as Array<{
    document?: { fields: Record<string, Record<string, string>> };
  }>;
  return rows[0]?.document?.fields.theme?.stringValue ?? null;
}

/** Encodes any plain value as a Firestore REST value. */
function encodeValue(v: unknown): object {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  const fields = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, encodeValue(x)]),
  );
  return { mapValue: { fields } };
}

/** Creates or replaces a whole document as the emulator's admin (skips rules). */
export async function adminSet(path: string, data: Record<string, unknown>) {
  const res = await fetch(`${FIRESTORE}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: (encodeValue(data) as { mapValue: { fields: object } }).mapValue.fields,
    }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

/** Sets some fields of a document (any values: lists, maps, dates) as the emulator's admin. */
export async function adminUpdate(path: string, data: Record<string, unknown>) {
  const mask = Object.keys(data)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join('&');
  const res = await fetch(`${FIRESTORE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: (encodeValue(data) as { mapValue: { fields: object } }).mapValue.fields,
    }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

/** Creates or replaces many whole documents in one atomic commit, as the emulator's admin. */
export async function adminSetAll(docs: Array<[string, Record<string, unknown>]>) {
  const res = await fetch(`${FIRESTORE}:commit`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({
      writes: docs.map(([path, data]) => ({
        update: {
          name: `projects/hive-board-43be/databases/(default)/documents/${path}`,
          fields: (encodeValue(data) as { mapValue: { fields: object } }).mapValue.fields,
        },
      })),
    }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

type UserDoc = { name: string; fields: Record<string, Record<string, string>> };

/**
 * The users/{uid} document of the person who signed in with this email, found with a single indexed
 * query. (Listing every user got slow late in a full run, which made sign-in polls time out.)
 */
async function userByEmail(email: string): Promise<UserDoc | undefined> {
  const res = await fetch(`${FIRESTORE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'email' },
            op: 'EQUAL',
            value: { stringValue: email },
          },
        },
        limit: 1,
      },
    }),
  });
  const rows = (await res.json()) as Array<{ document?: UserDoc }>;
  return rows[0]?.document;
}

/** The workspace id of the person who signed in with this email. */
export async function workspaceOf(email: string): Promise<string> {
  return pollFor(
    async () => (await userByEmail(email))?.fields.workspaceId?.stringValue,
    'No workspace for that email yet',
  );
}

/** A valid minimal project document (agent step then a human gate). */
export function projectFields(name: string, ownerUid: string, memberUids: string[] = [ownerUid]) {
  return {
    name,
    emoji: '📝',
    color: 'c1',
    budgetEur: 20, // like an older project: a stored budget is kept and ignored
    templateId: 'content',
    steps: [
      { id: 'draft', name: 'Draft', kind: 'agent', description: 'Write it' },
      {
        id: 'review',
        name: 'Review',
        kind: 'human',
        description: 'Decide',
        gate: {
          deciderUids: [ownerUid],
          groupIds: [],
          rule: 'any',
          n: 1,
          mustInclude: [],
          rejectPolicy: 'one',
          remindAfterHours: 24,
        },
      },
    ],
    stepIndex: { draft: 0, review: 1 },
    memberUids,
    createdBy: ownerUid,
    createdAt: new Date(),
    archivedAt: null,
    lastEventId: 'seed',
  };
}

/** A document as the emulator stores it (raw REST shape), or null when it does not exist. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawDoc = { fields: Record<string, Record<string, any>> };
export async function adminDoc(path: string): Promise<RawDoc | null> {
  const res = await fetch(`${FIRESTORE}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (res.status === 404) return null;
  expect(res.ok).toBe(true);
  return (await res.json()) as RawDoc;
}

/** The Auth uid of the person who signed in with this email (their users/{uid} document id). */
export async function uidOf(email: string): Promise<string> {
  const mine = await pollFor(() => userByEmail(email), 'No user for that email yet');
  return mine.name.split('/').pop()!;
}

/** The newest email code the Auth emulator "sent" to an address (verify or reset). */
export async function oobCode(email: string, type: 'VERIFY_EMAIL' | 'PASSWORD_RESET') {
  const res = await fetch(
    `http://localhost:${AUTH_PORT}/emulator/v1/projects/hive-board-43be/oobCodes`,
  );
  const { oobCodes } = (await res.json()) as {
    oobCodes: { email: string; requestType: string; oobCode: string }[];
  };
  const hit = oobCodes.filter((c) => c.email === email && c.requestType === type).at(-1);
  if (!hit) throw new Error(`No ${type} code for ${email}`);
  return hit.oobCode;
}

/** The link the emulator "emailed" (with its continueUrl), for the newest code of this kind. */
export async function oobLink(email: string, type: 'VERIFY_EMAIL' | 'PASSWORD_RESET') {
  const res = await fetch(
    `http://localhost:${AUTH_PORT}/emulator/v1/projects/hive-board-43be/oobCodes`,
  );
  const { oobCodes } = (await res.json()) as {
    oobCodes: { email: string; requestType: string; oobLink: string }[];
  };
  const hit = oobCodes.filter((c) => c.email === email && c.requestType === type).at(-1);
  if (!hit) throw new Error(`No ${type} link for ${email}`);
  return new URL(hit.oobLink).searchParams.get('continueUrl');
}

/** Undo window used by specs that opt in (the app honours it only in emulator builds). */
export const UNDO_MS = 2000;
/** Long enough for a decision made now to have been written: the window plus the write. */
export const UNDO_WAIT = UNDO_MS + 700;

/**
 * Shortens the app's test-only timings for this page (every later load): the Undo window to
 * UNDO_MS and "Can't reach the server" to 3 s. Production builds ignore it (src/lib/undoWindow.ts).
 * Call it before the first goto. Not for specs that check the real 5 s / 8 s.
 */
export async function fastTimers(page: Page, { undo = true, unreachable = false } = {}) {
  await page.addInitScript(
    ([u, r]) => {
      try {
        if (u) localStorage.setItem('hive.e2e.undoMs', String(u));
        if (r) localStorage.setItem('hive.e2e.unreachableMs', String(r));
      } catch {
        /* a blank page without storage */
      }
    },
    [undo ? UNDO_MS : 0, unreachable ? 3000 : 0] as const,
  );
}

/**
 * A fixed "now" for specs whose seeded times feed day-bound labels ("Today", "since 14:05",
 * "tokens today"). Real-time seeds ("now minus 40 min") fall on yesterday in the first hour after
 * midnight and the app then correctly prints another label. Use NOW / agoMs / ago for every seed and
 * call freezeClock(page) before the first goto, so the page and the seeds agree on the time.
 * Default: midday UTC. E2E_FAKE_NOW=<ISO time> picks another (`pnpm e2e:midnight` uses 00:05 UTC).
 * Offsets up to 65 min are squeezed to fit between the start of the UTC day and now, so "today"
 * seeds stay today (their order is kept); longer ones may fall on earlier days. The browser runs in
 * UTC (playwright.config.ts) so labels do not depend on the host zone. Emulator server timestamps
 * are not frozen: seed explicit times where a label depends on them.
 */
export const NOW = process.env.E2E_FAKE_NOW
  ? new Date(process.env.E2E_FAKE_NOW).getTime()
  : Date.UTC(2026, 5, 15, 12, 0, 0);
const MINUTE = 60_000;
const SINCE_MIDNIGHT_MIN = (NOW % (24 * 60 * MINUTE)) / MINUTE;
export const agoMs = (minutes: number) =>
  NOW -
  minutes * MINUTE * (minutes <= 65 ? Math.min(1, Math.max(SINCE_MIDNIGHT_MIN - 1, 0.5) / 65) : 1);
export const ago = (minutes: number) => new Date(agoMs(minutes));
/** The page clock starts at NOW and keeps running, so timers and animations still work. */
export async function freezeClock(target: Page | BrowserContext) {
  await target.clock.install({ time: NOW });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phoneWidth = (page: Page) => (page.viewportSize()?.width ?? 1440) < 640;

/**
 * The organization on screen (item icVly): the switcher in the sidebar on desktop, the fifth tab
 * (its mark and name) on a phone.
 */
export async function expectCurrentOrg(page: Page, name: string, { not = false } = {}) {
  const loc = phoneWidth(page)
    ? page.locator('[data-org-tab]')
    : page.getByRole('button', { name: /, switch organization$/ }).first();
  const want = phoneWidth(page)
    ? new RegExp(`^${escapeRe(name)}, organization`)
    : new RegExp(`^${escapeRe(name)}, switch organization$`);
  if (not) await expect(loc).not.toHaveAccessibleName(want);
  else await expect(loc).toHaveAccessibleName(want);
}

/** Opens the organization switcher: from the sidebar, or on a phone from the organization tab. */
export async function openSwitcher(page: Page) {
  if (phoneWidth(page)) {
    await page.locator('[data-org-tab]').click();
    await expect(page).toHaveURL(/\/org$/);
  }
  await page
    .getByRole('button', { name: /, switch organization$/ })
    .first()
    .click();
}
