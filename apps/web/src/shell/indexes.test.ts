import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONTH_RUNS } from './logic';

interface Index {
  collectionGroup: string;
  queryScope: string;
  fields: { fieldPath: string; order?: string }[];
}

const indexes = (
  JSON.parse(
    // Tests run from apps/web (the jsdom environment has no file: URL for this module).
    readFileSync(resolve(process.cwd(), '../../firestore.indexes.json'), 'utf8'),
  ) as { indexes: Index[] }
).indexes;

describe('the shell month-of-runs query', () => {
  // Without a matching index the production listener fails (the emulator never does), and spend
  // then shows only runs other screens happened to cache.
  it('has a composite index with the same field order and direction', () => {
    const dir = MONTH_RUNS.direction === 'desc' ? 'DESCENDING' : 'ASCENDING';
    const match = indexes.find(
      (i) =>
        i.collectionGroup === 'runs' &&
        i.queryScope === 'COLLECTION' &&
        i.fields.length === 2 &&
        i.fields[0]!.fieldPath === MONTH_RUNS.equal &&
        i.fields[1]!.fieldPath === MONTH_RUNS.range &&
        i.fields[1]!.order === dir,
    );
    expect(match).toBeDefined();
  });
});

describe('the bell query (item 3ENs)', () => {
  it('has a composite index: workspaceId, then at newest first', async () => {
    const { BELL_QUERY } = await import('../bell/logic');
    const match = indexes.find(
      (i) =>
        i.collectionGroup === 'notifications' &&
        i.queryScope === 'COLLECTION' &&
        i.fields.length === 2 &&
        i.fields[0]!.fieldPath === BELL_QUERY.equal &&
        i.fields[1]!.fieldPath === BELL_QUERY.range &&
        i.fields[1]!.order === 'DESCENDING',
    );
    expect(match).toBeDefined();
  });
});
