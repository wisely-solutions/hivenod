import type { LucideIcon } from 'lucide-react';
import { keepOpenOnToast } from './overlay';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './icon';

/** One action of a small menu. */
export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  tone?: 'default' | 'danger';
  onSelect: () => void;
}

const CONTENT =
  'z-50 min-w-44 max-w-[calc(100vw-24px)] rounded-card border border-line bg-surface p-1 shadow-e3 outline-hidden';
const ITEM =
  'flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-btn px-3 text-14 text-ink outline-hidden data-[highlighted]:bg-agent-soft sm:min-h-9';

function itemClass(a: MenuAction) {
  return cn(ITEM, a.tone === 'danger' && 'text-sendback');
}

/**
 * A "..." menu: the trigger is the button you pass. Arrow keys move, Enter picks, Escape closes
 * and gives focus back to the trigger (Radix menu semantics: role menu / menuitem).
 */
export function ActionMenu({
  trigger,
  label,
  actions,
}: {
  trigger: ReactNode;
  label: string;
  actions: readonly MenuAction[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label={label}
          onInteractOutside={keepOpenOnToast}
          align="end"
          sideOffset={4}
          collisionPadding={12}
          className={CONTENT}
        >
          {actions.map((a) => (
            <DropdownMenu.Item key={a.id} className={itemClass(a)} onSelect={() => a.onSelect()}>
              {a.icon ? <Icon icon={a.icon} size={16} /> : null}
              {a.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The same actions on right-click and, on a touch screen, a long press of the wrapped element
 * (Radix starts it after ~700 ms and cancels it when the finger moves, so scrolling and
 * dragging are not affected).
 */
export function LongPressMenu({
  children,
  label,
  actions,
  className,
}: {
  children: ReactNode;
  label: string;
  actions: readonly MenuAction[];
  className?: string;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className={className}>{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content aria-label={label} collisionPadding={12} className={CONTENT}>
          {actions.map((a) => (
            <ContextMenu.Item key={a.id} className={itemClass(a)} onSelect={() => a.onSelect()}>
              {a.icon ? <Icon icon={a.icon} size={16} /> : null}
              {a.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
