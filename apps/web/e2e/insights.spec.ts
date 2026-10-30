import { expect, test } from '@playwright/test';

import { person, signIn } from './helpers';

// The item-decision insights went with Projects (slice 10); Decision insights on threads:
// threadactivity.spec.ts.
test('insights: empty period', async ({ page }) => {
  await page.goto('/');
  const owner = person('Vazio');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await page.goto('/insights');
  await expect(page.getByText('No decisions yet in this period')).toBeVisible();
});
