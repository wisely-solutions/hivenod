import { expect, type Page } from '@playwright/test';
import { adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

export async function login(page: Page) {
  const owner = person('João');
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
  return { wid, uid };
}

export async function seedSteps(
  page: Page,
  { wid, uid }: { wid: string; uid: string },
  n: number,
  extraFirst: string[] = [],
  empty: number[] = [],
) {
  const pid = `fill${rand()}`;
  const base = projectFields('Wide', uid);
  const human = base.steps[1]!;
  const steps = Array.from({ length: n }, (_, i) =>
    // first step agent (suggestions lane), then human/agent alternating, last one human
    i % 2 === 1 || i === n - 1
      ? { ...human, id: `s${i}`, name: `Step ${i + 1}` }
      : { id: `s${i}`, name: `Step ${i + 1}`, kind: 'agent', description: 'Work' },
  );
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps,
    stepIndex: Object.fromEntries(steps.map((s, i) => [s.id, i])),
  });
  const mk = (id: string, title: string, stepId: string, order: number) =>
    adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, {
      title,
      type: 'idea',
      stepId,
      status: 'queued',
      summary: 'A seeded summary.',
      source: { kind: 'manual', label: 'Test' },
      createdBy: { type: 'human', id: uid },
      parentItemId: null,
      sourceRunId: null,
      claim: null,
      progress: null,
      gate: null,
      triage: null,
      sendBackCount: 0,
      costEur: 0,
      order,
      updatedAt: new Date(),
      lastEventId: 'seed',
    });
  for (const [i, s] of steps.entries())
    if (!empty.includes(i)) await mk(`i${i}`, `Item ${i + 1}`, s.id, 1);
  for (const [k, title] of extraFirst.entries()) await mk(`x${k}`, title, 's0', k + 2);
  return pid;
}
