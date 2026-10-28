/**
 * The HTML skeleton (index.html, #hv-boot) is an overlay next to React's root. It stays until the
 * app has painted its own first frame (its skeleton or content), so there is never an empty
 * frame between the two (card CGPynEQY, round 3). Called from the root component's first effect:
 * two animation frames later the app's frame is on screen, and the overlay is removed.
 */
export function releaseBoot(): void {
  const el = document.getElementById('hv-boot');
  if (!el) return;
  const done = () => {
    el.remove();
    performance.mark?.('hive:boot-released'); // read by the perf check (e2e/perf-load.spec.ts)
  };
  if (document.visibilityState === 'hidden') return done();
  requestAnimationFrame(() => requestAnimationFrame(done));
}
