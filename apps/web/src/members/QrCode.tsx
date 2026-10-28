import { useEffect, useState } from 'react';

/** QR code as plain SVG (no innerHTML). The library loads only when someone opens the invite. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [grid, setGrid] = useState<boolean[][] | null>(null);
  useEffect(() => {
    let live = true;
    import('qrcode-generator').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      const rows = Array.from({ length: n }, (_, r) =>
        Array.from({ length: n }, (_, c) => qr.isDark(r, c)),
      );
      if (live) setGrid(rows);
    });
    return () => {
      live = false;
    };
  }, [value]);

  const n = grid?.length ?? 29;
  const path = grid
    ? grid
        .flatMap((row, r) => row.map((on, c) => (on ? `M${c + 2} ${r + 2}h1v1h-1z` : '')))
        .join('')
    : '';
  // Always dark on white: scanners need the contrast whatever the theme is.
  return (
    <svg
      viewBox={`0 0 ${n + 4} ${n + 4}`}
      role="img"
      aria-label={label}
      className="size-44 rounded-card bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#15171b" />
    </svg>
  );
}
