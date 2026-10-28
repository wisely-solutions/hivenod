import { useEffect, useRef } from 'react';

/** The static host page (public/viewer-frame.html). Same origin as the app, but the report never is. */
export const FRAME_URL = '/viewer-frame.html';

/**
 * Agent-made HTML, run safely. The report lives in a sandboxed frame page that has its own script
 * policy (SPEC 9.6), so inline scripts work without loosening the app's policy. The iframe has no
 * allow-same-origin, so the report gets an opaque origin: no app data, cookies, storage, parent or
 * top-level navigation. The document is handed over with postMessage once the frame says it is ready.
 */
export function SandboxedHtml({
  html,
  title,
  className,
}: {
  html: string;
  title: string;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ html, title });
  useEffect(() => {
    latest.current = { html, title };
    send();
  }, [html, title]);

  function send() {
    ref.current?.contentWindow?.postMessage({ hive: 'doc', ...latest.current }, '*');
  }

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      if ((e.data as { hive?: string } | null)?.hive === 'ready') send();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={ref}
      title={title}
      src={FRAME_URL}
      sandbox="allow-scripts allow-popups"
      referrerPolicy="no-referrer"
      onLoad={send}
      className={className}
    />
  );
}

/** Opens the report in a new tab, still inside the sandboxed frame page (never as a same-origin document). */
export function openHtmlInNewTab(html: string, title: string): void {
  const win = window.open(FRAME_URL, '_blank');
  if (!win) return;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win || (e.data as { hive?: string } | null)?.hive !== 'ready') return;
    win.postMessage({ hive: 'doc', html, title }, '*');
    window.removeEventListener('message', onMessage);
  };
  window.addEventListener('message', onMessage);
  setTimeout(() => window.removeEventListener('message', onMessage), 30_000);
}
