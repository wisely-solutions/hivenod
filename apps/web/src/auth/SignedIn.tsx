import type { ReactNode } from 'react';
import { Gate } from '../pages/Gate';
import { ToastProvider, TooltipProvider } from '../ui/overlay';
import SessionCore from './SessionCore';

/** Everything for signed-in people, loaded as one lazy piece (Firebase, overlays, toasts). */
export default function SignedIn({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ToastProvider>
        <SessionCore>
          <Gate>{children}</Gate>
        </SessionCore>
      </ToastProvider>
    </TooltipProvider>
  );
}
