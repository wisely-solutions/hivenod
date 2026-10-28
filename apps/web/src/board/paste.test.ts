import { describe, expect, it, vi } from 'vitest';
import { takePastedFiles } from './ItemEdit';

const ev = (files: File[]) =>
  ({ clipboardData: { files }, preventDefault: vi.fn() }) as never as Parameters<
    typeof takePastedFiles
  >[0];

describe('takePastedFiles', () => {
  it('takes pasted files and stops the default', () => {
    const add = vi.fn();
    const e = ev([new File(['x'], 'a.png', { type: 'image/png' })]);
    expect(takePastedFiles(e, add)).toBe(true);
    expect(add).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it('leaves a plain-text paste alone', () => {
    const add = vi.fn();
    const e = ev([]);
    expect(takePastedFiles(e, add)).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
