import type { PickedFile } from './logic';

/** Reads a picked file: a data: URL for images and PDFs, the text itself for the rest. */
export function readFile(file: File, kind: PickedFile['kind']): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    if (kind === 'image' || kind === 'pdf') r.readAsDataURL(file);
    else r.readAsText(file);
  });
}
