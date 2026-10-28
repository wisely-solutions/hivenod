/**
 * Approve / Send back from Telegram. The person's chat is linked to their uid, the buttons carry a
 * one-time-ish code that points at (org, project, item, uid, gate), and the decision is the same
 * ActionPlan the app builds, applied with the Admin SDK. Admin writes skip the security rules, so
 * every check the rules would make is made here first: the person is a decider of this step, has
 * not voted, and the item still waits at the same arrival.
 */
import {
  ActionError,
  approve,
  gateKey,
  itemSchema,
  MIN_REASON_CHARS,
  paths,
  projectSchema,
  sendBack,
  type Item,
  type Project,
} from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { applyPlanAdmin } from './admin';
import type { ApprovalAction } from './engine';

export type DecideResult = { ok: true; text: string } | { ok: false; text: string };

async function load(db: Firestore, a: ApprovalAction) {
  const [pSnap, iSnap, mSnap] = await Promise.all([
    db.doc(paths.project(a.wid, a.pid)).get(),
    db.doc(paths.item(a.wid, a.pid, a.iid)).get(),
    db.doc(paths.member(a.wid, a.uid)).get(),
  ]);
  const project = pSnap.exists ? projectSchema.safeParse(pSnap.data()) : null;
  const item = iSnap.exists ? itemSchema.safeParse(iSnap.data()) : null;
  if (!project?.success || !item?.success) return null;
  const name = (mSnap.data()?.name as string | undefined) ?? 'Someone';
  return { project: project.data as Project, item: item.data as Item, name };
}

/** The reasons a person may not decide right now, in words for the chat; null when they may. */
export function whyNot(project: Project, item: Item, a: ApprovalAction): string | null {
  const step = project.steps.find((s) => s.id === item.stepId);
  if (item.status !== 'waiting' || !item.gate || step?.kind !== 'human' || !step.gate)
    return 'This item is no longer waiting for a decision.';
  if (gateKey(item) !== a.gateKey) return 'This item has moved on since the message was sent.';
  if (!step.gate.deciderUids.includes(a.uid)) return 'You can no longer decide this one.';
  if (a.uid in item.gate.approvals || a.uid in item.gate.rejections)
    return 'You already decided this one.';
  return null;
}

export async function decide(
  db: Firestore,
  a: ApprovalAction,
  kind: 'approve' | 'sendback',
  reason: string,
  nowMs: number,
): Promise<DecideResult> {
  const s = await load(db, a);
  if (!s) return { ok: false, text: 'I could not find that item any more.' };
  const blocked = whyNot(s.project, s.item, a);
  if (blocked) return { ok: false, text: blocked };
  const ctx = {
    workspaceId: a.wid,
    actor: { type: 'human' as const, id: a.uid, name: s.name },
    via: 'telegram' as const,
  };
  const waitedMs = Math.max(0, nowMs - s.item.updatedAt.toMillis());
  try {
    if (kind === 'approve') {
      const plan = approve(ctx, {
        project: s.project,
        projectId: a.pid,
        itemId: a.iid,
        item: s.item,
        rationale: reason || 'Approved from Telegram',
        waitedMs,
      });
      await applyPlanAdmin(db, plan);
      return {
        ok: true,
        text: plan.advanced
          ? `Approved: ${s.item.title}`
          : `Approved (waiting for the others): ${s.item.title}`,
      };
    }
    const at = s.project.steps.findIndex((x) => x.id === s.item.stepId);
    const back = s.project.steps[at - 1];
    if (!back) return { ok: false, text: 'There is no earlier step to send this back to.' };
    if (reason.trim().length < MIN_REASON_CHARS)
      return { ok: false, text: `Please say why in at least ${MIN_REASON_CHARS} characters.` };
    const plan = sendBack(ctx, {
      project: s.project,
      projectId: a.pid,
      itemId: a.iid,
      item: s.item,
      toStepId: back.id,
      rationale: reason.trim(),
      waitedMs,
    });
    await applyPlanAdmin(db, plan);
    return { ok: true, text: `Sent back to ${back.name}: ${s.item.title}` };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, text: e.message };
    throw e;
  }
}

/** Can this item be sent back at all (a step comes before the gate)? */
export function canSendBack(project: Project, item: Item): boolean {
  return project.steps.findIndex((s) => s.id === item.stepId) > 0;
}
