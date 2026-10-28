/**
 * `notifier personal-org` (Inbox item fJnu6): creates a person's "Personal" organization with the
 * service account, writing exactly the batch the app writes when they create an organization
 * (packages/shared/src/personalOrg.ts). Nothing is written without `--apply`; it refuses when the
 * person already owns an organization with that name. Run it only with the person's OK.
 *
 *   notifier personal-org --email <their sign-in email> [--name Personal] [--apply]
 *   notifier personal-org --uid <their user id> [--name Personal] [--apply]
 */
import {
  existingPersonalOrg,
  PERSONAL_ORG_NAME,
  personalOrgPlan,
  randomId,
  type OrgSummary,
} from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { applyPlanAdmin } from './admin';

export interface PersonalOrgArgs {
  email?: string;
  uid?: string;
  name?: string;
  apply?: boolean;
}

export type PersonalOrgResult =
  | { status: 'exists'; uid: string; workspaceId: string; name: string }
  | {
      status: 'planned' | 'created';
      uid: string;
      workspaceId: string;
      name: string;
      writes: string[];
    };

/** Parses `--email x --uid y --name z --apply`. */
export function parsePersonalOrgArgs(argv: readonly string[]): PersonalOrgArgs {
  const out: PersonalOrgArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--email') out.email = next();
    else if (a === '--uid') out.uid = next();
    else if (a === '--name') out.name = next();
    else if (a === '--apply') out.apply = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!out.email === !out.uid) throw new Error('Give exactly one of --email or --uid');
  return out;
}

export async function personalOrg(
  db: Firestore,
  args: PersonalOrgArgs,
  newId: () => string = randomId,
): Promise<PersonalOrgResult> {
  let uid = args.uid;
  if (!uid) {
    const found = await db.collection('users').where('email', '==', args.email).limit(2).get();
    if (found.size !== 1)
      throw new Error(
        found.size ? 'More than one person has that email: use --uid' : 'Nobody has that email',
      );
    uid = found.docs[0]!.id;
  }
  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.data();
  if (!user) throw new Error(`No Hivenod profile for ${uid}: they sign in once first`);
  const name = (args.name ?? PERSONAL_ORG_NAME).trim();

  const ids: string[] = Array.isArray(user.workspaceIds) ? user.workspaceIds : [];
  const orgs: OrgSummary[] = [];
  for (const id of ids) {
    const w = (await db.doc(`workspaces/${id}`).get()).data();
    if (w) orgs.push({ id, name: String(w.name ?? ''), ownerUid: String(w.ownerUid ?? '') });
  }
  const have = existingPersonalOrg(orgs, uid, name);
  if (have) return { status: 'exists', uid, workspaceId: have.id, name: have.name };

  const workspaceId = newId();
  const plan = personalOrgPlan(
    { workspaceId, actor: { type: 'human', id: uid, name: String(user.name ?? '') }, newId },
    {
      name,
      profile: {
        name: String(user.name ?? ''),
        email: String(user.email ?? ''),
        photoURL: (user.photoURL as string | null) ?? null,
        color: String(user.color ?? ''),
      },
    },
  );
  const writes = plan.ops.map((o) => `${o.kind} ${o.path}`);
  if (!args.apply) return { status: 'planned', uid, workspaceId, name, writes };
  await applyPlanAdmin(db, plan);
  return { status: 'created', uid, workspaceId, name, writes };
}

/** One line per fact, no personal data beyond ids. */
export function describePersonalOrg(r: PersonalOrgResult): string {
  if (r.status === 'exists')
    return `${r.uid} already owns "${r.name}" (${r.workspaceId}). Nothing written.`;
  const head =
    r.status === 'planned'
      ? `Would create "${r.name}" (${r.workspaceId}) for ${r.uid}. Dry run: add --apply to write.`
      : `Created "${r.name}" (${r.workspaceId}) for ${r.uid}. It is in their switcher.`;
  return [head, ...r.writes.map((w) => `  ${w}`)].join('\n');
}
