import {
  notifiedSchema,
  notifyConfigSchema,
  notifyPath,
  notifyPrefsSchema,
  pushSubSchema,
  telegramLinkSchema,
  type Notified,
} from '@hive/shared';
import { useMemo } from 'react';
import { useLiveCollection, useLiveDoc } from '../lib/live';

/** The public settings the notifier publishes. `null`: it never ran (nothing can be sent yet). */
export function useNotifyConfig() {
  return useLiveDoc(notifyPath.config, notifyConfigSchema);
}

export function useNotifyPrefs(uid: string) {
  return useLiveDoc(notifyPath.prefs(uid), notifyPrefsSchema);
}

export function usePushSubs(uid: string) {
  return useLiveCollection(notifyPath.pushSubs(uid), pushSubSchema);
}

export function useTelegramLink(uid: string) {
  return useLiveDoc(notifyPath.telegram(uid), telegramLinkSchema);
}

/** What the notifier sent per waiting gate, by item id ("reminder sent"). Empty until it loads. */
export function useReminders(wid: string): ReadonlyMap<string, Notified> {
  const live = useLiveCollection(`workspaces/${wid}/notified`, notifiedSchema);
  return useMemo(
    () =>
      new Map(
        live.state === 'ready'
          ? live.data.filter((r) => r.id.startsWith('g-')).map((r) => [r.data.itemId, r.data])
          : [],
      ),
    [live],
  );
}
