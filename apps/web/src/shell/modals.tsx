import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Button } from '../ui/button';

export interface ModalSpec {
  title: string;
  description?: string;
  body?: ReactNode;
  /** Replaces the default "Close" footer. */
  footer?: (close: () => void) => ReactNode;
}

interface Api {
  open: (spec: ModalSpec) => void;
  close: () => void;
}
const Ctx = createContext<Api | null>(null);

export function useModal(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error('useModal needs <ModalProvider>');
  return v;
}

/** The one global dialog (desktop) / bottom sheet (phone) that any screen can open. */
export function ModalProvider({ children }: { children: ReactNode }) {
  // Kept after closing so the exit animation still has its content.
  const [spec, setSpec] = useState<ModalSpec | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const api = useMemo<Api>(
    () => ({
      open: (s) => {
        setSpec(s);
        setOpen(true);
      },
      close,
    }),
    [close],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <ResponsiveModal
        open={open}
        onOpenChange={setOpen}
        title={spec?.title ?? ''}
        description={spec?.description}
        footer={
          spec?.footer ? (
            spec.footer(close)
          ) : (
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          )
        }
      >
        {spec?.body}
      </ResponsiveModal>
    </Ctx.Provider>
  );
}
