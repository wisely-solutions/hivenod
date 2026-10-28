import type { LucideIcon } from 'lucide-react';

export const ICON_STROKE = 1.75;

/** The one icon wrapper: Lucide, 1.75 stroke, decorative unless a label is given. */
export function Icon({
  icon: Glyph,
  size = 16,
  label,
  className,
}: {
  icon: LucideIcon;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <Glyph
      size={size}
      strokeWidth={ICON_STROKE}
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}
