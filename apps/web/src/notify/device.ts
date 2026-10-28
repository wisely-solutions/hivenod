import { notifyPath, pushSubSchema, subId } from '@hive/shared';
import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/db';
import { isIos, isStandalone } from '../shell/pwa';

export type PushSupport = 'ok' | 'needs-install' | 'unsupported' | 'denied';

/**
 * Can this browser take Web Push? On iPhone and iPad it only works for an installed app (Home
 * Screen), so a tab in Safari is told to install first.
 */
export function pushSupport(): PushSupport {
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

export function deviceLabel(ua: string = navigator.userAgent): string {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${browser} on ${os}`;
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function thisDeviceEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Asks permission, subscribes this browser with the notifier's public key and saves it. */
export async function enablePush(uid: string, vapidPublicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('permission');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(vapidPublicKey),
    }));
  const json = sub.toJSON();
  const doc1 = pushSubSchema.parse({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    label: deviceLabel(),
    createdAt: Date.now(),
  });
  await setDoc(doc(db, notifyPath.pushSub(uid, subId(doc1.endpoint))), doc1);
}

/** Stops pushing to this browser and forgets it. */
export async function disablePush(uid: string, endpoint: string | null): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const ep = sub?.endpoint ?? endpoint;
  await sub?.unsubscribe().catch(() => undefined);
  if (ep) await deleteDoc(doc(db, notifyPath.pushSub(uid, subId(ep))));
}
