import { useEffect } from 'react';
import { useReady } from '../auth/context';
import { cleanStaleBusy } from '../calendar/cleanup';

/** Once per signed-in session: drops my busy blocks of organizations I am no longer in. */
export function useCleanStaleBusy(): void {
  const { session } = useReady();
  const uid = session.me.uid;
  useEffect(() => {
    const t = setTimeout(() => void cleanStaleBusy(uid).catch(() => undefined), 3000);
    return () => clearTimeout(t);
  }, [uid]);
}
