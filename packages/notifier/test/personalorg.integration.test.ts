/**
 * `notifier personal-org` (Inbox item fJnu6) against the Firestore emulator: a dry run writes
 * nothing, --apply writes the app's own batch (the person then reads it through the rules as its
 * admin), and a second run finds it and writes nothing.
 */
import { paths } from '@hive/shared';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { doc, getDoc } from 'firebase/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, useEmulator, W } from '../../shared/rules/harness';
import { describePersonalOrg, parsePersonalOrgArgs, personalOrg } from '../src/personalOrg';

useEmulator();

let db: Firestore;
beforeAll(() => {
  db = getFirestore(getApps()[0] ?? initializeApp({ projectId: 'hive-rules-test' }));
});

const ids = () => {
  let n = 0;
  return () => `pid${++n}`;
};

describe('notifier personal-org', () => {
  it('dry run, apply, then nothing on a second run', async () => {
    const dry = await personalOrg(db, { email: 'alice@example.com' }, ids());
    expect(dry).toMatchObject({ status: 'planned', uid: 'alice', workspaceId: 'pid1' });
    expect(describePersonalOrg(dry)).toContain('Dry run');
    expect((await db.doc(paths.workspace('pid1')).get()).exists).toBe(false);

    const made = await personalOrg(db, { email: 'alice@example.com', apply: true }, ids());
    expect(made.status).toBe('created');
    const user = (await db.doc(paths.user('alice')).get()).data()!;
    expect(user.workspaceIds).toEqual([W, 'pid1']);
    expect(user.workspaceId).toBe(W);
    const events = await db.collection(`workspaces/pid1/events`).get();
    expect(events.docs.map((d) => d.data().type)).toEqual(['workspace.created']);
    // Alice reads it through the rules, as its admin, with her member card.
    const alice = as('alice', { workspaceId: 'pid1' });
    const ws = await getDoc(doc(alice.db, paths.workspace('pid1')));
    expect(ws.data()).toMatchObject({ name: 'Personal', memberRoles: { alice: 'admin' } });
    expect((await getDoc(doc(alice.db, paths.member('pid1', 'alice')))).exists()).toBe(true);

    const again = await personalOrg(db, { uid: 'alice', apply: true }, () => 'pidX');
    expect(again).toEqual({
      status: 'exists',
      uid: 'alice',
      workspaceId: 'pid1',
      name: 'Personal',
    });
  });

  it('refuses unknown people and bad arguments', async () => {
    await expect(personalOrg(db, { email: 'nobody@example.com' })).rejects.toThrow(/Nobody/);
    expect(() => parsePersonalOrgArgs([])).toThrow(/exactly one/);
    expect(() => parsePersonalOrgArgs(['--email'])).toThrow(/needs a value/);
    expect(parsePersonalOrgArgs(['--email', 'a@b.c', '--name', 'Home', '--apply'])).toEqual({
      email: 'a@b.c',
      name: 'Home',
      apply: true,
    });
  });
});
