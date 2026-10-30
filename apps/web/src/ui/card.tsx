import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Card({
  className,
  tone = 'plain',
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: 'plain' | 'gate' | 'agent' }) {
  return (
    <div
      className={cn(
        'rounded-card border p-4 shadow-e1',
        tone === 'gate' && 'border-gate/60 bg-gate-bg',
        tone === 'agent' && 'border-line bg-agent-soft',
        tone === 'plain' && 'border-line bg-surface',
        className,
      )}
      {...rest}
    />
  );
}
