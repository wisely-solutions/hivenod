import { evaluateGate, isSuggestion, type Item, type Project, type Step } from '@hive/shared';

export interface FindingRow {
  id: string;
  data: Item;
}

/** Suggestions (untriaged findings) agents raised about this item, oldest first. */
export function findingsOf(items: readonly FindingRow[], itemId: string): FindingRow[] {
  return items
    .filter((r) => isSuggestion(r.data) && r.data.parentItemId === itemId)
    .sort((a, b) => a.data.order - b.data.order);
}

export interface ApprovalRow {
  uid: string;
  /** Approved, or still waiting. */
  state: 'approved' | 'waiting';
  required: boolean;
  quote: string;
}

/** Who approved (with their words), who is still needed, and who is optional. */
export function approvalRows(step: Step | undefined, item: Pick<Item, 'gate'>): ApprovalRow[] {
  const gate = step?.gate;
  if (!step || !gate) return [];
  const approvals = item.gate?.approvals ?? {};
  const evaluation = evaluateGate(step, approvals, item.gate?.rejections ?? {});
  const required = new Set([
    ...(gate.rule === 'all' || gate.rule === 'specific' ? gate.deciderUids : gate.mustInclude),
    ...evaluation.missing,
  ]);
  const uids = [...new Set([...Object.keys(approvals), ...gate.deciderUids])];
  return uids
    .map((uid): ApprovalRow => {
      const a = approvals[uid] as { rationale?: string } | undefined;
      return {
        uid,
        state: a ? 'approved' : 'waiting',
        required: required.has(uid),
        quote: a?.rationale ?? '',
      };
    })
    .sort((x, y) => Number(y.state === 'approved') - Number(x.state === 'approved'));
}

/** A data: URL to a blob: URL, so browsers open big PDFs and images without URL length limits. */
export function dataUrlToBlobUrl(dataUrl: string): string | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const raw = m[2] ? atob(m[3]!) : decodeURIComponent(m[3]!);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: m[1] }));
  } catch {
    return null;
  }
}

export function stepOf(project: Project, item: Pick<Item, 'stepId'>): Step | undefined {
  return project.steps.find((s) => s.id === item.stepId);
}

/** The best name a human gives to a link: its host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 5;
export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

/** Text (Markdown source) as a small readable HTML page, escaped, for the sandboxed new-tab frame. */
export function textPage(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;padding:16px;font:15px/1.6 system-ui,sans-serif;max-width:46rem"><pre style="white-space:pre-wrap;word-break:break-word;font:inherit;margin:0">${esc}</pre></body>`;
}
