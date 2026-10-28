export interface QueryShape {
  group: string;
  scope: 'COLLECTION' | 'COLLECTION_GROUP';
  filters: { field: string; op: string }[];
  orders: { field: string; dir: 'asc' | 'desc' }[];
}
export type CheckResult =
  | { ok: true; via: 'none' | 'single-field' | 'composite' }
  | { ok: false; missing: string; suggestion: unknown };
export function plan(q: QueryShape): {
  eq: Map<string, string>;
  orders: { field: string; dir: 'asc' | 'desc' }[];
};
export function check(q: QueryShape, config: unknown): CheckResult;
export function describeQuery(q: QueryShape): string;
