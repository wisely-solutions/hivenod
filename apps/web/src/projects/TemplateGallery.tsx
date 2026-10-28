import { describeProcess, TEMPLATES, type Template } from '@hive/shared';
import { RadioGroup } from 'radix-ui';
import { cn } from '../ui/cn';
import { ProcessStrip } from './ProcessStrip';

/**
 * The templates as a radio group. On phones it is a horizontal snap carousel; from tablet up it is
 * a grid. `value` may be null when nothing is chosen yet (the empty-state hero).
 */
export function TemplateGallery({
  value,
  onValueChange,
  label = 'Project templates',
  bleed = 'sheet',
  columns = 3,
}: {
  value: string | null;
  onValueChange: (t: Template) => void;
  label?: string;
  /** Where the carousel runs edge to edge: inside a sheet (20px padding) or on the page (16px). */
  bleed?: 'sheet' | 'page';
  /** Most columns at desktop. The empty state sits in a narrow column and asks for 1. */
  columns?: 1 | 3;
}) {
  return (
    <RadioGroup.Root
      value={value ?? ''}
      onValueChange={(id) => {
        const t = TEMPLATES.find((x) => x.id === id);
        if (t) onValueChange(t);
      }}
      aria-label={label}
      orientation="horizontal"
      className={cn(
        'flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        bleed === 'sheet' ? '-mx-5 px-5' : '-mx-4 px-4',
        'sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0',
        columns === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-1',
      )}
    >
      {TEMPLATES.map((t) => (
        <RadioGroup.Item
          key={t.id}
          value={t.id}
          className={cn(
            'flex w-[78%] shrink-0 snap-center flex-col gap-3 rounded-card border border-line bg-surface p-3.5 text-left sm:w-auto',
            'transition-[border-color,background-color,transform,box-shadow] duration-120 ease-standard',
            'hov:border-line-strong hov:shadow-e1 act:scale-[0.99] foc:outline-2 foc:outline-offset-2 foc:outline-focus',
            'data-[state=checked]:border-ink data-[state=checked]:bg-canvas',
          )}
        >
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="text-20">
              {t.emoji}
            </span>
            <span className="text-14 font-semibold text-ink">{t.name}</span>
          </span>
          <span className="text-13 text-text-2">{t.blurb}</span>
          <ProcessStrip steps={t.steps} />
          <span className="text-13 text-text-3">{describeProcess(t.steps)}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
