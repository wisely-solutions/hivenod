
/** A data: URL to a blob: URL, so browsers open big PDFs and images without URL length limits. */
export function dataUrlToBlobUrl(dataUrl: string): string | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const raw = m[2] ? atob(m[3]!) : decodeURIComponent(m[3]!);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: m[1] }));
  } catch {
    return null;
  }
}

/** The best name a human gives to a link: its host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

