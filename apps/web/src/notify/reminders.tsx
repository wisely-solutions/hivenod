import type { Notified } from '@hive/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { useReminders } from './data';

const Ctx = createContext<ReadonlyMap<string, Notified>>(new Map());

/** One listener for what the notifier sent, shared by Needs you and the board. */
export function RemindersProvider({ children }: { children: ReactNode }) {
  const { session } = useReady();
  const map = useReminders(session.workspaceId);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}

export function useReminderMap(): ReadonlyMap<string, Notified> {
  return useContext(Ctx);
}
