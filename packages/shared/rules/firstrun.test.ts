/** First-run checklist progress (card tIG1wr4Z): own document only, exact booleans. */
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { firstRunPath } from '../src/firstrun';
import { denied, getEnv, ok, useEmulator, W } from './harness';

useEmulator();

const dbOf = (uid: string | null) =>
  (uid ? getEnv().authenticatedContext(uid) : getEnv().unauthenticatedContext()).firestore();
const state = { dismissed: true, project: true, idea: true, agent: false };

describe('first-run checklist state', () => {
  it('a person saves and reads their own, nobody else can', async () => {
    const p = firstRunPath('alice', W);
    await ok(setDoc(doc(dbOf('alice'), p), state));
    await ok(getDoc(doc(dbOf('alice'), p)));
    await denied(getDoc(doc(dbOf('bob'), p)));
    await denied(setDoc(doc(dbOf('bob'), p), state));
    await denied(getDoc(doc(dbOf(null), p)));
  });
  it('rejects extra, missing or non-boolean fields', async () => {
    const p = firstRunPath('alice', W);
    await denied(setDoc(doc(dbOf('alice'), p), { ...state, admin: true }));
    await denied(setDoc(doc(dbOf('alice'), p), { dismissed: true }));
    await denied(setDoc(doc(dbOf('alice'), p), { ...state, idea: 'yes' }));
  });
  it('cannot be deleted', async () => {
    const p = firstRunPath('alice', W);
    await ok(setDoc(doc(dbOf('alice'), p), state));
    await denied(deleteDoc(doc(dbOf('alice'), p)));
  });
});
