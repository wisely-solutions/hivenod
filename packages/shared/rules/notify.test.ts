/** Notifications (card rN5Q12W2): who may write choices, devices, links and read the sent marks. */
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { bellPath } from '../src/bell';
import { DEFAULT_NOTIFY_PREFS, notifyPath } from '../src/notify';
import { denied, getEnv, ok, put, useEmulator, W } from './harness';

useEmulator();

const dbOf = (uid: string | null) =>
  (uid ? getEnv().authenticatedContext(uid) : getEnv().unauthenticatedContext()).firestore();
const sub = {
  endpoint: 'https://push.example.com/send/abc',
  keys: { p256dh: 'p', auth: 'a' },
  label: 'Chrome',
  createdAt: 1,
};
const link = { uid: 'alice', createdAt: 1 };

describe('notify choices and devices', () => {
  it('a person saves their own choices, nobody else can read or write them', async () => {
    const p = notifyPath.prefs('alice');
    await ok(setDoc(doc(dbOf('alice'), p), DEFAULT_NOTIFY_PREFS));
    await ok(getDoc(doc(dbOf('alice'), p)));
    await denied(getDoc(doc(dbOf('bob'), p)));
    await denied(setDoc(doc(dbOf('bob'), p), DEFAULT_NOTIFY_PREFS));
  });
  it('rejects choices with extra or missing fields', async () => {
    const p = notifyPath.prefs('alice');
    await denied(setDoc(doc(dbOf('alice'), p), { ...DEFAULT_NOTIFY_PREFS, admin: true }));
    await denied(setDoc(doc(dbOf('alice'), p), { push: true }));
  });
  it('a device subscription is own, https only and exact', async () => {
    const p = notifyPath.pushSub('alice', 's1');
    await ok(setDoc(doc(dbOf('alice'), p), sub));
    await denied(setDoc(doc(dbOf('bob'), p), sub));
    await denied(setDoc(doc(dbOf('alice'), p), { ...sub, endpoint: 'http://x.example/y' }));
    await denied(setDoc(doc(dbOf('alice'), p), { ...sub, extra: 1 }));
    await ok(deleteDoc(doc(dbOf('alice'), p)));
  });
  it('the linked chat is read and unlinked by its owner, never written by a client', async () => {
    const p = notifyPath.telegram('alice');
    const chat = { chatId: 1, username: null, linkedAt: 1 };
    await denied(setDoc(doc(dbOf('alice'), p), chat));
    await put({ [p]: chat });
    await ok(getDoc(doc(dbOf('alice'), p)));
    await denied(getDoc(doc(dbOf('bob'), p)));
    await denied(deleteDoc(doc(dbOf('bob'), p)));
    await ok(deleteDoc(doc(dbOf('alice'), p)));
  });
});

describe('telegram link codes, public settings and sent marks', () => {
  const code = 'abcdefghijklmnopqrstuv';
  it('a person creates a link code for themselves only, and cannot read it back', async () => {
    const p = notifyPath.telegramLink(code);
    await ok(setDoc(doc(dbOf('alice'), p), link));
    await denied(getDoc(doc(dbOf('alice'), p)));
    await denied(setDoc(doc(dbOf('bob'), notifyPath.telegramLink('x'.repeat(20))), link));
    await denied(setDoc(doc(dbOf('alice'), notifyPath.telegramLink('short')), link));
    await denied(setDoc(doc(dbOf(null), p), link));
  });
  it('signed-in people read the public settings, nobody writes them', async () => {
    await put({ [notifyPath.config]: { vapidPublicKey: 'k', telegramBot: 'hive_bot' } });
    await ok(getDoc(doc(dbOf('alice'), notifyPath.config)));
    await denied(getDoc(doc(dbOf(null), notifyPath.config)));
    await denied(
      setDoc(doc(dbOf('alice'), notifyPath.config), { vapidPublicKey: 'x', telegramBot: null }),
    );
  });
  it('members read the sent marks of their organization, nobody writes them', async () => {
    const p = notifyPath.notified(W, 'g-i1');
    await put({
      [p]: {
        itemId: 'i1',
        projectId: 'p1',
        gateKey: 'review:0',
        sent: [],
        remindedAt: null,
        at: 1,
      },
    });
    await ok(getDoc(doc(dbOf('alice'), p)));
    await denied(getDoc(doc(dbOf('eve'), p)));
    await denied(setDoc(doc(dbOf('alice'), p), { itemId: 'i1' }));
  });
});

describe('the bell (item 3ENs)', () => {
  const entry = {
    kind: 'gate',
    workspaceId: W,
    projectId: 'p1',
    itemId: 'i1',
    projectName: 'Hive',
    itemTitle: 'Connect wizard',
    stepName: 'Accept',
    actorName: '',
    text: '',
    at: 1,
    readAt: null,
  };
  const p = bellPath.entry('alice', 'g-i1-accept_0');
  const agentDb = (u: string) =>
    getEnv().authenticatedContext(u, { email: 'agent-x@agents.hive-board.app' }).firestore();

  it('only its owner reads the history, never another person or an agent', async () => {
    await put({ [p]: entry, [bellPath.entry('agentA', 'g-i1-x')]: entry });
    await ok(getDoc(doc(dbOf('alice'), p)));
    await ok(getDocs(collection(dbOf('alice'), bellPath.list('alice'))));
    await denied(getDoc(doc(dbOf('bob'), p)));
    await denied(getDocs(collection(dbOf('bob'), bellPath.list('alice'))));
    await denied(getDoc(doc(dbOf(null), p)));
    await denied(getDoc(doc(agentDb('agentA'), bellPath.entry('agentA', 'g-i1-x'))));
    await denied(getDoc(doc(agentDb('agentA'), p)));
  });
  it('nobody writes entries from a client', async () => {
    await denied(setDoc(doc(dbOf('alice'), p), entry));
    await denied(setDoc(doc(dbOf('bob'), p), entry));
    await put({ [p]: entry });
    await denied(deleteDoc(doc(dbOf('alice'), p)));
    await denied(updateDoc(doc(dbOf('alice'), p), { itemTitle: 'changed' }));
    await denied(updateDoc(doc(dbOf('alice'), p), { readAt: 5, kind: 'question' }));
  });
  it('the owner marks an entry read once; nobody else can', async () => {
    await put({ [p]: entry });
    await denied(updateDoc(doc(dbOf('bob'), p), { readAt: 5 }));
    await denied(updateDoc(doc(agentDb('alice'), p), { readAt: 5 }));
    await denied(updateDoc(doc(dbOf('alice'), p), { readAt: 'now' }));
    await ok(updateDoc(doc(dbOf('alice'), p), { readAt: 5 }));
    await denied(updateDoc(doc(dbOf('alice'), p), { readAt: null }));
    await denied(updateDoc(doc(dbOf('alice'), p), { readAt: 9 }));
  });
});
