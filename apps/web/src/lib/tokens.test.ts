import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrast } from './contrast';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) out[m[1]!] = m[2]!;
  return out;
}

const light = { ...block(':root') };
const dark = { ...light, ...block("[data-theme='dark']") };

/** [foreground token, background token, minimum ratio, why] */
const textPairs: Array<[string, string, number, string]> = [
  ['ink', 'surface', 4.5, 'body text on cards'],
  ['ink', 'canvas', 4.5, 'body text on page'],
  ['text-2', 'surface', 4.5, 'secondary text'],
  ['text-2', 'canvas', 4.5, 'secondary text on page'],
  ['text-3', 'surface', 4.5, 'tertiary text'],
  ['text-3', 'canvas', 4.5, 'tertiary text on page'],
  ['text-3', 'surface-2', 4.5, 'tertiary text on raised surface'],
  ['gate-text', 'gate-bg', 4.5, 'amber text on amber background'],
  ['gate-text', 'surface', 4.5, 'amber eyebrow on card'],
  ['gate-text', 'canvas', 4.5, 'amber eyebrow on page'],
  ['agent', 'surface', 4.5, 'agent blue text'],
  ['agent', 'agent-soft', 4.5, 'agent blue on soft'],
  ['agent', 'canvas', 4.5, 'agent blue on page'],
  ['approve-text', 'surface', 4.5, 'approve text'],
  ['approve-text', 'approve-bg', 4.5, 'approve text on tint'],
  ['sendback', 'surface', 4.5, 'send-back text'],
  ['sendback', 'sendback-bg', 4.5, 'send-back text on tint'],
  ['on-solid', 'approve-solid', 4.5, 'approve button label'],
  ['surface', 'ink', 4.5, 'primary button label'],
  ['on-solid', 'agent-1', 4.5, 'agent initial 1'],
  ['on-solid', 'agent-2', 4.5, 'agent initial 2'],
  ['on-solid', 'agent-3', 4.5, 'agent initial 3'],
  ['on-solid', 'agent-4', 4.5, 'agent initial 4'],
  ['on-solid', 'agent-5', 4.5, 'agent initial 5'],
  ['on-solid', 'agent-6', 4.5, 'agent initial 6'],
  ['on-solid', 'agent-7', 4.5, 'agent initial 7'],
  ['on-solid', 'agent-8', 4.5, 'agent initial 8'],
  ['on-gate', 'gate', 4.5, 'gate-amber button label'],
  ['focus', 'surface', 3, 'focus ring (non-text)'],
  ['focus', 'canvas', 3, 'focus ring on page (non-text)'],
  ['line-strong', 'surface', 3, 'input border (non-text)'],
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme contrast', (_name, tokens) => {
  it.each(textPairs)('%s on %s is at least %s:1 (%s)', (fg, bg, min) => {
    const a = tokens[fg];
    const b = tokens[bg];
    expect(a, `token --${fg}`).toBeDefined();
    expect(b, `token --${bg}`).toBeDefined();
    expect(contrast(a!, b!)).toBeGreaterThanOrEqual(min);
  });
});
