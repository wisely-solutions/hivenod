import { Avatar } from '../ui/avatar';
import { cn } from '../ui/cn';

const sizes = { sm: 'size-6 text-12', md: 'size-8 text-13', lg: 'size-11 text-16' } as const;

/** Profile colour tokens are `c1`..`c8`; they map onto the eight palette colours. */
export function colorVar(color: string): string {
  const n = Number(/^c([1-8])$/.exec(color)?.[1] ?? 0);
  return n ? `var(--agent-${n})` : 'var(--text-2)';
}

/** A person (the name is always shown beside it, so the avatar itself is decorative): their Google photo when there is one, otherwise their initial on their colour. */
export function PersonAvatar({
  name,
  photoURL,
  color,
  size = 'md',
  className,
}: {
  name: string;
  photoURL?: string | null;
  color: string;
  size?: keyof typeof sizes;
  className?: string;
}) {
  if (photoURL)
    return <Avatar name={name} photoUrl={photoURL} size={size} className={className} decorative />;
  return (
    <span
      aria-hidden
      data-initial={name.trim().charAt(0).toUpperCase() || '?'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-on-solid ring-2 ring-surface before:content-[attr(data-initial)]',
        sizes[size],
        className,
      )}
      style={{ backgroundColor: colorVar(color) }}
    />
  );
}
