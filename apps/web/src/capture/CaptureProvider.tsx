/**
 * The capture box became New thread (item OE8FmrTaIxFVGcaeGG3N, slice 10: Projects were removed).
 * The phone tab bar's +, the palette's "New thread" and the `c` key open the same New thread
 * dialog from anywhere.
 */
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useShortcut } from '../shell/shortcuts';

const NewThreadDialog = lazy(() =>
  import('../threads/NewThread').then((m) => ({ default: m.NewThreadDialog })),
);

interface Api {
  /** Opens the New thread dialog. */
  open: () => void;
}
const Ctx = createContext<Api | null>(null);

export function useCapture(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCapture needs <CaptureProvider>');
  return v;
}

/** The New thread dialog, if this tree has one. */
export function useOptionalCapture(): Api | null {
  return useContext(Ctx);
}

export function CaptureProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const api = useMemo<Api>(() => ({ open: () => setOpen(true) }), []);
  useShortcut({
    id: 'capture',
    keys: ['c'],
    label: 'New thread',
    group: 'Actions',
    run: () => setOpen(true),
  });
  return (
    <Ctx.Provider value={api}>
      {children}
      {open ? (
        <Suspense fallback={null}>
          <NewThreadDialog open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </Ctx.Provider>
  );
}
