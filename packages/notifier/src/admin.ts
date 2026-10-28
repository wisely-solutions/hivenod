/** Applies an ActionPlan with the Admin SDK (the same plan the app commits with the web SDK). */
import { SERVER_TIME, DELETE_FIELD, type ActionPlan } from '@hive/shared';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export function toAdminValue(v: unknown): unknown {
  if (v === SERVER_TIME) return FieldValue.serverTimestamp();
  if (v === DELETE_FIELD) return FieldValue.delete();
  if (typeof v === 'object' && v !== null) {
    const h = (v as { __hive?: string }).__hive;
    if (h === 'arrayUnion') return FieldValue.arrayUnion(...(v as { values: string[] }).values);
    if (h === 'increment') return FieldValue.increment((v as unknown as { by: number }).by);
    if (Array.isArray(v)) return v.map(toAdminValue);
    if (Object.getPrototypeOf(v) !== Object.prototype) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAdminValue(x)]));
  }
  return v;
}

export async function applyPlanAdmin(db: Firestore, plan: Pick<ActionPlan, 'ops'>): Promise<void> {
  const batch = db.batch();
  for (const op of plan.ops) {
    const ref = db.doc(op.path);
    const data = toAdminValue(op.data ?? {}) as Record<string, unknown>;
    if (op.kind === 'set') batch.set(ref, data);
    else if (op.kind === 'update') batch.update(ref, data);
    else batch.delete(ref);
  }
  await batch.commit();
}
