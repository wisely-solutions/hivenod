import { useSyncExternalStore, type ComponentProps } from 'react';
import { Dialog, Sheet } from '../ui/overlay';

const QUERY = '(max-width: 639px)';
function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** A bottom sheet on phones, a dialog everywhere else (SPEC section 8). */
export function ResponsiveModal(props: ComponentProps<typeof Dialog>) {
  const phone = useIsPhone();
  return phone ? <Sheet {...props} /> : <Dialog {...props} />;
}
