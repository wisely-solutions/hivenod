import { cn } from './cn';

/** Eight agent colours. Index wraps, so any agent id maps to one. */
export const AGENT_COLORS = 8;

export function agentColorIndex(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % AGENT_COLORS) + 1;
}

const sizes = { sm: 'size-6 text-12', md: 'size-8 text-13', lg: 'size-11 text-16' } as const;
type Size = keyof typeof sizes;

export function Avatar({
  name,
  photoUrl,
  size = 'md',
  className,
  decorative,
}: {
  name: string;
  photoUrl?: string;
  size?: Size;
  className?: string;
  /** The name is visible next to the avatar, so screen readers skip it. */
  decorative?: boolean;
}) {
  const initial = name.trim().charAt(0).toUpperCase();
  return photoUrl ? (
    <img
      src={photoUrl}
      alt={decorative ? '' : name}
      className={cn(
        'shrink-0 rounded-full object-cover ring-2 ring-surface',
        sizes[size],
        className,
      )}
    />
  ) : (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-text-2 font-semibold text-surface ring-2 ring-surface',
        sizes[size],
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** Agent avatar: initial on one of eight colours. A heartbeat ring pulses while its run is alive. */
export function AgentAvatar({
  name,
  color = 1,
  live,
  size = 'md',
  className,
}: {
  name: string;
  color?: number;
  live?: boolean;
  size?: Size;
  className?: string;
}) {
  const idx = ((color - 1) % AGENT_COLORS) + 1;
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {live ? (
        <span
          aria-hidden
          className="absolute inset-0 animate-heartbeat rounded-full motion-reduce:hidden"
          style={{ backgroundColor: `var(--agent-${idx})` }}
        />
      ) : null}
      <span
        role="img"
        aria-label={live ? `${name}, working now` : name}
        className={cn(
          'relative inline-flex items-center justify-center rounded-full font-semibold text-on-solid ring-2 ring-surface',
          sizes[size],
        )}
        style={{ backgroundColor: `var(--agent-${idx})` }}
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
      {live ? (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-approve ring-2 ring-surface"
        />
      ) : null}
    </span>
  );
}

export interface StackPerson {
  name: string;
  photoUrl?: string;
  agentColor?: number;
  live?: boolean;
}

export function AvatarStack({
  people,
  max = 4,
  size = 'sm',
}: {
  people: StackPerson[];
  max?: number;
  size?: Size;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div
      role="group"
      aria-label={people.map((p) => p.name).join(', ')}
      className="inline-flex items-center"
    >
      {shown.map((p, i) => (
        <span key={p.name} className={cn(i > 0 && '-ml-2')}>
          {p.agentColor ? (
            <AgentAvatar name={p.name} color={p.agentColor} live={p.live} size={size} />
          ) : (
            <Avatar name={p.name} photoUrl={p.photoUrl} size={size} />
          )}
        </span>
      ))}
      {extra > 0 ? (
        <span
          className={cn(
            '-ml-2 inline-flex items-center justify-center rounded-full bg-canvas font-medium text-text-2 ring-2 ring-surface',
            sizes[size],
          )}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
