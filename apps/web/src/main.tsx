import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { getAuthHint } from './auth/hint';
import './styles.css';
import { watchThemeColor } from './theme';
import { releaseBoot } from './lib/boot';

// Without View Transitions, route changes fall back to a CSS cross-fade (see styles.css).
if (typeof document.startViewTransition !== 'function') document.documentElement.dataset.noVt = '';

// A transition that is superseded by a newer one rejects its promises ("Transition was skipped");
// that is harmless, so they are caught instead of surfacing as uncaught page errors.
if (typeof document.startViewTransition === 'function') {
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = ((arg?: unknown) => {
    const vt = start(arg as never);
    for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p.catch(() => undefined);
    return vt;
  }) as typeof document.startViewTransition;
}

watchThemeColor();

// Someone who looks signed in: start Firebase Auth now. Restoring the session takes a round trip
// to Google (it checks the account), and the first screen's data waits for it. Imported here it
// starts as soon as this script runs, not after the larger Firestore code has arrived too. Then
// the first screen's listeners start as soon as Firestore is here, without waiting for the
// screens' code (lib/prewarm.ts, card CGPynEQY). The sign-in page loads neither.
if (getAuthHint() && !/^\/(kit|join)(\/|$)/.test(window.location.pathname)) {
  void import('./lib/app');
  void import('./lib/prewarm').then((m) => m.prewarm()).catch(() => undefined);
}

// The service worker precaches every chunk of the app (about 1.5 MB). Started at load it would
// compete with the first screen's own requests on a slow phone, so it starts a few seconds
// after load, when the browser is idle (card CGPynEQY).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const register = () =>
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  const later = () =>
    setTimeout(() => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(register, { timeout: 5000 });
      else register();
    }, 4000);
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// Safety net: the HTML skeleton never outstays a broken start.
setTimeout(releaseBoot, 20_000);
