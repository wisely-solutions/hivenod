/**
 * The sign-in backdrop: slim folded agent columns with a few amber gates, drifting slowly.
 * Decorative only. Motion is transform and opacity, and it stops under reduced motion.
 */
const STRIPS = [
  { h: 62, gate: false, d: 11, o: 0 },
  { h: 78, gate: false, d: 9, o: -3 },
  { h: 54, gate: true, d: 13, o: -6 },
  { h: 86, gate: false, d: 10, o: -2 },
  { h: 70, gate: false, d: 12, o: -8 },
  { h: 58, gate: true, d: 9, o: -4 },
  { h: 82, gate: false, d: 14, o: -1 },
  { h: 66, gate: false, d: 10, o: -7 },
  { h: 74, gate: false, d: 12, o: -5 },
  { h: 60, gate: true, d: 11, o: -9 },
  { h: 80, gate: false, d: 9, o: -2 },
  { h: 68, gate: false, d: 13, o: -6 },
];

export function FoldedBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="fold-mask absolute inset-x-0 top-0 flex h-full items-end justify-center gap-3 px-3 pb-0 sm:gap-4">
        {STRIPS.map((s, i) => (
          <div
            key={i}
            className="fold-strip flex w-12 shrink-0 flex-col items-center gap-2 rounded-card border px-1.5 pt-3 sm:w-14"
            style={{
              height: `${s.h}%`,
              animationDuration: `${s.d}s`,
              animationDelay: `${s.o}s`,
              background: s.gate ? 'var(--gate-bg)' : 'var(--agent-soft)',
              borderColor: s.gate ? 'var(--gate)' : 'var(--line)',
              opacity: s.gate ? 0.9 : 0.75,
            }}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ background: s.gate ? 'var(--gate)' : 'var(--agent)' }}
            />
            {[0, 1, 2].map((n) => (
              <span
                key={n}
                className="h-6 w-full rounded-[5px]"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  opacity: 1 - n * 0.25,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
