/**
 * One step of a plan, spelled out (plan view): who does it, every field of its type with its
 * label from the outcomes registry, what it produces, its state, and the open questions
 * highlighted (a line starting "Open:" or ending "?", see openQuestionLines). Read-only: the
 * plan panel adds the step's actions below it, the plan page shows it as it is.
 */
import { outcomeType, type PlanStepView } from '@hive/shared';
import { Pill } from '../ui/badge';
import { Markdown } from '../ui/markdown';
import { cn } from '../ui/cn';
import { openQuestionLines, PILL, producesOf, STEP_UI_TEXT, when, whoOf } from './plan';

/** A field's text as blocks: each open-question line alone, the lines between them as Markdown. */
function textBlocks(value: string): { text: string; open: boolean }[] {
  const out: { text: string; open: boolean }[] = [];
  for (const l of openQuestionLines(value)) {
    const last = out[out.length - 1];
    if (!l.open && last && !last.open) last.text += `\n${l.text}`;
    else out.push({ text: l.text, open: l.open });
  }
  return out;
}

export function StepSpec({
  type,
  fields,
  ui,
  className,
}: {
  type: string;
  fields: Readonly<Record<string, unknown>>;
  /** The step's state: shown as a pill when given (the plan page; the panel's row has its own). */
  ui?: PlanStepView['ui'];
  className?: string;
}) {
  const t = outcomeType(type);
  const produces = producesOf(type);
  return (
    <div data-step-spec={type} className={cn('flex flex-col gap-2.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span data-spec-who="" className="text-13 font-medium text-text-2">
          {whoOf(type)}
        </span>
        {ui ? <Pill tone={PILL[ui]}>{STEP_UI_TEXT[ui]}</Pill> : null}
      </div>
      {Object.entries(t?.fields ?? {}).map(([name, f]) => {
        const v = fields[name];
        const empty = v === undefined || v === '' || v === false;
        return (
          <div key={name} data-field={name}>
            <div className="text-13 font-medium text-text-2">{f.label}</div>
            {empty ? (
              <div className="text-14 text-text-3">{f.required ? 'Not set' : '—'}</div>
            ) : f.kind === 'boolean' ? (
              <div className="text-14 text-ink">Yes</div>
            ) : f.kind === 'datetime' && typeof v === 'string' ? (
              <div className="text-14 text-ink">{when(v)}</div>
            ) : (
              <div className="text-14 text-ink [overflow-wrap:anywhere]">
                {textBlocks(String(v)).map((blk, i) =>
                  blk.open ? (
                    <p
                      key={i}
                      data-open-question=""
                      className="my-0.5 rounded-btn border border-gate/60 bg-gate-bg px-2 py-1 text-gate-text"
                    >
                      {blk.text}
                    </p>
                  ) : (
                    <Markdown key={i} source={blk.text} />
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
      {produces ? (
        <p data-spec-produces="" className="text-13 text-text-2">
          <span className="font-medium">Produces:</span> {produces}
        </p>
      ) : null}
    </div>
  );
}
