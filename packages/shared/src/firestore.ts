/**
 * Firebase adapter for the shared model: commits ActionPlans as one batched write and provides
 * Zod-validated converters. Kept out of the main entry so importing types and schemas never
 * pulls the Firestore SDK into a bundle. Import from '@hive/shared/firestore'.
 */
import {
  arrayUnion,
  deleteField,
  doc,
  increment,
  serverTimestamp,
  writeBatch,
  type DocumentData,
  type Firestore,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
} from 'firebase/firestore';
import type { z } from 'zod';
import {
  DELETE_FIELD,
  SERVER_TIME,
  type ActionPlan,
  type ArrayUnion,
  type Increment,
  type WriteOp,
} from './actions';
import {
  agentSchema,
  attachmentSchema,
  decisionSchema,
  stepProposalSchema,
  eventSchema,
  groupSchema,
  inviteSchema,
  itemSchema,
  logLineSchema,
  memberProfileSchema,
  messageSchema,
  projectSchema,
  runSchema,
  userSchema,
  workspaceSchema,
} from './schema';

function isArrayUnion(v: unknown): v is ArrayUnion {
  return typeof v === 'object' && v !== null && (v as ArrayUnion).__hive === 'arrayUnion';
}

function isIncrement(v: unknown): v is Increment {
  return typeof v === 'object' && v !== null && (v as Increment).__hive === 'increment';
}

/** Replaces SERVER_TIME / DELETE_FIELD placeholders with Firestore sentinels, recursively. */
export function toFirestoreValue(v: unknown): unknown {
  if (v === SERVER_TIME) return serverTimestamp();
  if (v === DELETE_FIELD) return deleteField();
  if (isArrayUnion(v)) return arrayUnion(...v.values);
  if (isIncrement(v)) return increment(v.by);
  if (Array.isArray(v)) return v.map(toFirestoreValue);
  if (v instanceof Date || v === null || typeof v !== 'object') return v;
  if (Object.getPrototypeOf(v) !== Object.prototype) return v; // Timestamp, GeoPoint, …
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFirestoreValue(x)]));
}

/** Adds one op to a batch. */
function addOp(batch: ReturnType<typeof writeBatch>, db: Firestore, op: WriteOp) {
  const ref = doc(db, op.path);
  const data = toFirestoreValue(op.data ?? {}) as DocumentData;
  if (op.kind === 'set') batch.set(ref, data);
  else if (op.kind === 'update') batch.update(ref, data);
  else batch.delete(ref);
}

/** Commits a plan (domain change + its event) atomically. */
export async function applyPlan(db: Firestore, plan: Pick<ActionPlan, 'ops'>): Promise<void> {
  const batch = writeBatch(db);
  for (const op of plan.ops) addOp(batch, db, op);
  await batch.commit();
}

/** A converter that validates documents with a Zod schema when read. */
export function converter<S extends z.ZodType>(
  schema: S,
): FirestoreDataConverter<z.infer<S>, DocumentData> {
  return {
    toFirestore: (value) => value as DocumentData,
    fromFirestore: (snap: QueryDocumentSnapshot, options?: SnapshotOptions) =>
      schema.parse(snap.data({ serverTimestamps: 'estimate', ...options })),
  };
}

export const converters = {
  user: converter(userSchema),
  workspace: converter(workspaceSchema),
  invite: converter(inviteSchema),
  group: converter(groupSchema),
  member: converter(memberProfileSchema),
  agent: converter(agentSchema),
  project: converter(projectSchema),
  item: converter(itemSchema),
  attachment: converter(attachmentSchema),
  message: converter(messageSchema),
  decision: converter(decisionSchema),
  stepProposal: converter(stepProposalSchema),
  run: converter(runSchema),
  logLine: converter(logLineSchema),
  event: converter(eventSchema),
};
