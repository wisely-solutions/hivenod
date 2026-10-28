import {
  DEFAULT_NOTIFY_PREFS,
  notifyPath,
  notifyPrefsSchema,
  randomId,
  subId,
  type NotifyPrefs,
} from '@hive/shared';
import { BellRing, MoonStar, Send, Smartphone, Trash2 } from 'lucide-react';
import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { disablePush, enablePush, pushSupport, thisDeviceEndpoint } from '../notify/device';
import { useNotifyConfig, useNotifyPrefs, usePushSubs, useTelegramLink } from '../notify/data';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Card } from '../ui/card';
import { Input, Toggle } from '../ui/form';
import { Icon } from '../ui/icon';
import { useToast } from '../ui/overlay';
import { isIos, isStandalone } from '../shell/pwa';
import { PageHeader } from './Chrome';

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="mb-3 text-16 font-semibold">
      {children}
    </h2>
  );
}

export function NotificationsPage() {
  const { session } = useReady();
  const uid = session.me.uid;
  const toast = useToast();
  const config = useNotifyConfig();
  const prefsLive = useNotifyPrefs(uid);
  const subs = usePushSubs(uid);
  const tg = useTelegramLink(uid);
  const [here, setHere] = useState<string | null>(null);
  const [busy, setBusy] = useState<'push' | 'telegram' | null>(null);
  const [waitingTelegram, setWaitingTelegram] = useState(false);
  const support = pushSupport();

  useEffect(() => {
    void thisDeviceEndpoint().then(setHere);
  }, [subs]);

  const stored = prefsLive.state === 'ready' ? prefsLive.data : null;
  const prefs: NotifyPrefs = stored ?? {
    ...DEFAULT_NOTIFY_PREFS,
    quiet: { ...DEFAULT_NOTIFY_PREFS.quiet, tz: browserZone() },
  };
  const vapid = config.state === 'ready' ? (config.data?.vapidPublicKey ?? null) : null;
  const bot = config.state === 'ready' ? (config.data?.telegramBot ?? null) : null;
  const linked = tg.state === 'ready' ? tg.data : null;
  const waitingForTelegram = waitingTelegram && !linked;
  const myDevices = subs.state === 'ready' ? subs.data : [];
  const thisOn = !!here && myDevices.some((d) => subId(d.data.endpoint) === subId(here));

  async function save(next: NotifyPrefs) {
    try {
      await setDoc(doc(db, notifyPath.prefs(uid)), notifyPrefsSchema.parse(next));
    } catch {
      toast.push({ message: 'Could not save. Try again.' });
    }
  }

  async function turnOn() {
    if (!vapid) return;
    setBusy('push');
    try {
      await enablePush(uid, vapid);
      setHere(await thisDeviceEndpoint());
      toast.push({ message: 'Notifications are on for this device' });
    } catch (e) {
      toast.push({
        message:
          e instanceof Error && e.message === 'permission'
            ? 'Notifications were not allowed. Change it in your browser settings.'
            : 'Could not turn notifications on here.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function turnOff() {
    setBusy('push');
    try {
      await disablePush(uid, here);
      setHere(null);
    } catch {
      toast.push({ message: 'Could not turn notifications off. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function connectTelegram() {
    if (!bot) return;
    setBusy('telegram');
    try {
      const code = randomId(24);
      await setDoc(doc(db, notifyPath.telegramLink(code)), { uid, createdAt: Date.now() });
      setWaitingTelegram(true);
      window.open(`https://t.me/${bot}?start=${code}`, '_blank', 'noopener');
    } catch {
      toast.push({ message: 'Could not start the Telegram link. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function disconnectTelegram() {
    try {
      await deleteDoc(doc(db, notifyPath.telegram(uid)));
    } catch {
      toast.push({ message: 'Could not disconnect Telegram. Try again.' });
    }
  }

  const row = 'flex items-center gap-3';
  const sender = config.state === 'ready' && config.data === null;

  return (
    <>
      <PageHeader
        title="Notifications"
        section
        subtitle="Hear about approvals and questions even when Hivenod is closed."
      />

      {sender ? (
        <Card tone="gate" className="mb-6 text-14" role="status">
          <p className="font-medium">Sending is not switched on yet.</p>
          <p className="mt-1 text-text-2">
            Your choices are saved, but nothing is sent until the Hivenod notifier is running. Ask
            an admin to start it (docs/NOTIFIER.md).
          </p>
        </Card>
      ) : null}

      <section aria-labelledby="n-push" className="mb-8">
        <SectionTitle id="n-push">This device</SectionTitle>
        <Card className="flex flex-col gap-3">
          <div className={row}>
            <Icon icon={BellRing} size={18} className="text-text-2" />
            <div className="min-w-0 flex-1">
              <p className="text-14 font-medium">Push notifications</p>
              <p className="text-13 text-text-2">
                {thisOn
                  ? 'On for this device.'
                  : support === 'needs-install'
                    ? 'Add Hivenod to your Home Screen first (see below).'
                    : support === 'unsupported'
                      ? 'This browser cannot receive push notifications.'
                      : support === 'denied'
                        ? 'Blocked in your browser settings. Allow notifications for this site, then come back.'
                        : !vapid
                          ? 'Not available until the notifier is running.'
                          : 'Off. Turn it on to get a message on this device.'}
              </p>
            </div>
            {thisOn ? (
              <Button variant="secondary" loading={busy === 'push'} onClick={turnOff}>
                Turn off
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={busy === 'push'}
                disabled={support !== 'ok' || !vapid}
                onClick={turnOn}
              >
                Turn on
              </Button>
            )}
          </div>
          {myDevices.length > 0 ? (
            <ul className="divide-y divide-line border-t border-line" aria-label="Your devices">
              {myDevices.map((d) => (
                <li key={d.id} className="flex min-h-12 items-center gap-3 py-1">
                  <Icon icon={Smartphone} size={16} className="text-text-2" />
                  <span className="min-w-0 flex-1 truncate text-14">{d.data.label}</span>
                  {here && subId(here) === d.id ? <Badge tone="neutral">This device</Badge> : null}
                  <IconButton
                    label={`Remove ${d.data.label}`}
                    onClick={() => void deleteDoc(doc(db, notifyPath.pushSub(uid, d.id)))}
                  >
                    <Icon icon={Trash2} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="n-install" className="mb-8">
        <SectionTitle id="n-install">On iPhone and iPad</SectionTitle>
        <Card className="text-14">
          <p className="text-text-2">
            Apple only delivers push to apps on the Home Screen. Install Hivenod once and turn
            notifications on from there.
          </p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5">
            <li>
              Open Hivenod in <strong>Safari</strong>.
            </li>
            <li>
              Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
            </li>
            <li>Open Hivenod from your Home Screen, not from Safari.</li>
            <li>
              Come back to Me, Notifications and tap <strong>Turn on</strong>.
            </li>
          </ol>
          {isIos() && !isStandalone() ? (
            <p className="mt-3 text-13 font-medium text-gate-text">
              You are in a Safari tab right now, so push is off here until you install it.
            </p>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="n-tg" className="mb-8">
        <SectionTitle id="n-tg">Telegram</SectionTitle>
        <Card className="flex flex-col gap-3">
          <div className={row}>
            <Icon icon={Send} size={18} className="text-text-2" />
            <div className="min-w-0 flex-1">
              <p className="text-14 font-medium">
                {linked
                  ? `Connected${linked.username ? ` as @${linked.username}` : ''}`
                  : 'Telegram'}
              </p>
              <p className="text-13 text-text-2">
                {linked
                  ? 'Messages have Approve and Send back buttons.'
                  : waitingForTelegram
                    ? 'Press Start in Telegram to finish. This page updates by itself.'
                    : bot
                      ? 'Get messages with Approve and Send back buttons.'
                      : 'Not available until the Telegram bot is set up.'}
              </p>
            </div>
            {linked ? (
              <Button variant="secondary" onClick={disconnectTelegram}>
                Disconnect
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={busy === 'telegram'}
                disabled={!bot}
                onClick={connectTelegram}
              >
                Connect Telegram
              </Button>
            )}
          </div>
        </Card>
      </section>

      <section aria-labelledby="n-how" className="mb-8">
        <SectionTitle id="n-how">What you get and when</SectionTitle>
        <Card className="flex flex-col gap-1">
          <Toggle
            label="Push to my devices"
            description="A new approval or question, and gate reminders."
            checked={prefs.push}
            onCheckedChange={(v) => void save({ ...prefs, push: v })}
          />
          <Toggle
            label="Telegram messages"
            description="Only once Telegram is connected."
            checked={prefs.telegram}
            onCheckedChange={(v) => void save({ ...prefs, telegram: v })}
          />
          <div className="border-t border-line pt-2">
            <Toggle
              label="Daily email digest"
              description="Not available yet: sending email needs a paid service, which is waiting for approval."
              checked={false}
              disabled
              onCheckedChange={() => undefined}
            />
          </div>
          <div className="border-t border-line pt-2">
            <div className="flex items-start gap-2">
              <Icon icon={MoonStar} size={18} className="mt-3 text-text-2" />
              <div className="min-w-0 flex-1">
                <Toggle
                  label="Quiet hours"
                  description="Held back until they end. Several held messages become one."
                  checked={prefs.quiet.enabled}
                  onCheckedChange={(v) =>
                    void save({ ...prefs, quiet: { ...prefs.quiet, enabled: v } })
                  }
                />
              </div>
            </div>
            {prefs.quiet.enabled ? (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <Input
                  label="From"
                  type="time"
                  value={prefs.quiet.from}
                  onChange={(e) =>
                    e.target.value &&
                    void save({ ...prefs, quiet: { ...prefs.quiet, from: e.target.value } })
                  }
                />
                <Input
                  label="Until"
                  type="time"
                  value={prefs.quiet.to}
                  onChange={(e) =>
                    e.target.value &&
                    void save({ ...prefs, quiet: { ...prefs.quiet, to: e.target.value } })
                  }
                />
                <p className="col-span-2 text-13 text-text-2">Time zone: {prefs.quiet.tz}</p>
              </div>
            ) : null}
          </div>
        </Card>
        <p className="mt-2 flex items-center gap-2 text-13 text-text-2">
          <Icon icon={BellRing} size={14} />
          Each gate also sends a reminder after the hours set on its step, once.
        </p>
      </section>
    </>
  );
}
