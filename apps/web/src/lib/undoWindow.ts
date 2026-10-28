/**
 * Test-only shortening of waits. Production always gets `normal`: only a build made for the
 * emulators (VITE_USE_EMULATOR=1, which the production build never sets, so the whole branch is
 * removed from it) honours `localStorage['hive.e2e.<name>']`, which an e2e spec sets with
 * `fastTimers` in e2e/helpers.ts. Specs that do not set it keep the real timings.
 */
export function e2eMs(name: 'undoMs' | 'unreachableMs', normal: number): number {
  if (import.meta.env.VITE_USE_EMULATOR === '1') {
    try {
      const v = Number(localStorage.getItem(`hive.e2e.${name}`));
      if (v > 0) return v;
    } catch {
      /* no storage: the real timing */
    }
  }
  return normal;
}

/** The Undo window, in ms. */
export const undoWindowMs = (normal: number) => e2eMs('undoMs', normal);
