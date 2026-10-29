import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { guard } from './check-firestore-indexes.mjs';
import { check, describeQuery, plan } from './firestore-index-rules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const idx = (collectionGroup, fields, queryScope = 'COLLECTION') => ({
  collectionGroup,
  queryScope,
  fields: fields.map(([fieldPath, o]) =>
    o === 'CONTAINS' ? { fieldPath, arrayConfig: o } : { fieldPath, order: o },
  ),
});
const q = (group, filters = [], orders = [], scope = 'COLLECTION') => ({
  group,
  scope,
  filters: filters.map(([field, op]) => ({ field, op })),
  orders: orders.map(([field, dir]) => ({ field, dir })),
});
const RUNS_DESC = {
  indexes: [
    idx('runs', [
      ['projectId', 'ASCENDING'],
      ['startedAt', 'DESCENDING'],
    ]),
  ],
};

describe('Firestore index rules', () => {
  it('a range filter without orderBy needs an ASCENDING index (the release-42 bug)', () => {
    const r = check(
      q('runs', [
        ['projectId', '=='],
        ['startedAt', '>='],
      ]),
      RUNS_DESC,
    );
    expect(r.ok).toBe(false);
    expect(r.suggestion.fields).toEqual([
      { fieldPath: 'projectId', order: 'ASCENDING' },
      { fieldPath: 'startedAt', order: 'ASCENDING' },
    ]);
    expect(
      check(
        q(
          'runs',
          [
            ['projectId', '=='],
            ['startedAt', '>='],
          ],
          [['startedAt', 'desc']],
        ),
        RUNS_DESC,
      ),
    ).toEqual({
      ok: true,
      via: 'composite',
    });
  });

  it('serves equality-only and one-field queries from automatic single-field indexes', () => {
    const none = { indexes: [] };
    expect(
      check(
        q('runs', [
          ['projectId', '=='],
          ['itemId', '=='],
          ['status', 'in'],
        ]),
        none,
      ).via,
    ).toBe('single-field');
    expect(check(q('runs', [['startedAt', '>=']], [['startedAt', 'desc']]), none).via).toBe(
      'single-field',
    );
    expect(check(q('projects', [['memberUids', 'array-contains']]), none).via).toBe('single-field');
    expect(check(q('runs'), none).via).toBe('none');
  });

  it('needs a composite index when equality and order fields differ', () => {
    expect(check(q('events', [['projectId', '==']], [['at', 'desc']]), { indexes: [] }).ok).toBe(
      false,
    );
    expect(
      check(
        q(
          'events',
          [],
          [
            ['projectId', 'asc'],
            ['at', 'desc'],
          ],
        ),
        { indexes: [] },
      ).ok,
    ).toBe(false);
  });

  it('matches equality fields in any order but order fields exactly', () => {
    const cfg = {
      indexes: [
        idx('e', [
          ['b', 'ASCENDING'],
          ['a', 'DESCENDING'],
          ['at', 'DESCENDING'],
        ]),
      ],
    };
    expect(
      check(
        q(
          'e',
          [
            ['a', '=='],
            ['b', '=='],
          ],
          [['at', 'desc']],
        ),
        cfg,
      ).ok,
    ).toBe(true);
    expect(
      check(
        q(
          'e',
          [
            ['a', '=='],
            ['b', '=='],
          ],
          [['at', 'asc']],
        ),
        cfg,
      ).ok,
    ).toBe(false);
    expect(check(q('e', [['a', '==']], [['at', 'desc']]), cfg).ok).toBe(false);
  });

  it('collection-group queries need collection-group scope, even for one equality filter', () => {
    const coll = {
      indexes: [
        idx('decisions', [
          ['workspaceId', 'ASCENDING'],
          ['at', 'DESCENDING'],
        ]),
      ],
    };
    const cgQuery = q('decisions', [['workspaceId', '==']], [['at', 'desc']], 'COLLECTION_GROUP');
    expect(check(cgQuery, coll).ok).toBe(false);
    const cg = {
      indexes: [
        idx(
          'decisions',
          [
            ['workspaceId', 'ASCENDING'],
            ['at', 'DESCENDING'],
          ],
          'COLLECTION_GROUP',
        ),
      ],
    };
    expect(check(cgQuery, cg).ok).toBe(true);
    const single = check(q('decisions', [['workspaceId', '==']], [], 'COLLECTION_GROUP'), cg);
    expect(single.ok).toBe(false);
    expect(single.missing).toContain(
      'COLLECTION_GROUP single-field index on decisions.workspaceId',
    );
    const override = {
      indexes: [],
      fieldOverrides: [
        {
          collectionGroup: 'decisions',
          fieldPath: 'workspaceId',
          indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' }],
        },
      ],
    };
    expect(
      check(q('decisions', [['workspaceId', '==']], [], 'COLLECTION_GROUP'), override).ok,
    ).toBe(true);
  });

  it('a fieldOverride that drops a single-field index removes the automatic one', () => {
    const cfg = {
      indexes: [],
      fieldOverrides: [{ collectionGroup: 'runs', fieldPath: 'log', indexes: [] }],
    };
    expect(check(q('runs', [['log', '==']]), cfg).ok).toBe(false);
  });

  it('array-contains combined with an order needs an arrayConfig CONTAINS field', () => {
    const query = q('projects', [['memberUids', 'array-contains']], [['name', 'asc']]);
    const wrong = {
      indexes: [
        idx('projects', [
          ['memberUids', 'ASCENDING'],
          ['name', 'ASCENDING'],
        ]),
      ],
    };
    expect(check(query, wrong).ok).toBe(false);
    const right = {
      indexes: [
        idx('projects', [
          ['memberUids', 'CONTAINS'],
          ['name', 'ASCENDING'],
        ]),
      ],
    };
    expect(check(query, right).ok).toBe(true);
    expect(() =>
      plan(
        q('p', [
          ['a', 'array-contains'],
          ['b', 'array-contains-any'],
        ]),
      ),
    ).toThrow(/at most one/);
  });

  it('orders inequality fields after the explicit orders, in field order, in the last direction', () => {
    expect(
      plan(
        q(
          'r',
          [
            ['z', '>'],
            ['b', '<'],
            ['a', '!='],
          ],
          [['b', 'desc']],
        ),
      ).orders,
    ).toEqual([
      { field: 'b', dir: 'desc' },
      { field: 'a', dir: 'desc' },
      { field: 'z', dir: 'desc' },
    ]);
  });
});

describe('Firestore query scan', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'idxguard-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const fixture = (name, src) => {
    const p = join(tmp, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
    return p;
  };

  it('names file:line and the missing index for the release-42 query', () => {
    const file = fixture(
      'a/feed.ts',
      `import { collection, query, where, Timestamp } from 'firebase/firestore';
declare const db: any;
const RUNS = { equal: 'projectId', range: 'startedAt' } as const;
export const runs = (wid: string, pid: string, since: Date) =>
  query(
    collection(db, \`workspaces/\${wid}/runs\`),
    where(RUNS.equal, '==', pid),
    where(RUNS.range, '>=', Timestamp.fromDate(since)),
  );
`,
    );
    const { problems } = guard(tmp, { files: [file], config: RUNS_DESC, allowlist: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a/feed.ts:5');
    expect(problems[0]).toContain("collection 'runs' where(projectId ==) where(startedAt >=)");
    expect(problems[0]).toContain(
      'composite index on runs (projectId ASCENDING, startedAt ASCENDING)',
    );
  });

  it('reads collection groups, converters, const bases and ignores limit/cursors', () => {
    const file = fixture(
      'b/q.ts',
      `import { collection, collectionGroup as cg, limit, orderBy, query, where } from 'firebase/firestore';
declare const db: any; declare const conv: any;
const base = collection(db, 'workspaces', 'w', 'events').withConverter(conv);
export const a = query(base, where('projectId', '==', 'p'), orderBy('at', 'desc'), limit(5));
export const b = query(cg(db, 'decisions'), where('workspaceId', '==', 'w'), orderBy('at', 'desc'));
`,
    );
    const { results, problems } = guard(tmp, {
      files: [file],
      config: { indexes: [] },
      allowlist: [],
    });
    expect(results.map((r) => [r.shape.group, r.shape.scope])).toEqual([
      ['events', 'COLLECTION'],
      ['decisions', 'COLLECTION_GROUP'],
    ]);
    expect(problems).toHaveLength(2);
  });

  it('reports dynamic queries as unanalysable unless allowlisted, and stale allowlist entries', () => {
    const file = fixture(
      'c/dyn.ts',
      `import { collection, orderBy, query, where } from 'firebase/firestore';
declare const db: any; declare const fs: [string, '==', unknown][];
export const q = query(collection(db, 'events'), ...fs.map(([f, op, v]) => where(f, op, v)));
export const r = query(collection(db, 'events'), orderBy(fs[0]![0]));
`,
    );
    const { problems } = guard(tmp, {
      files: [file],
      config: { indexes: [] },
      allowlist: [{ file: 'c/dyn.ts', text: 'gone()', reason: 'x' }],
    });
    expect(problems.join('\n')).toMatch(/c\/dyn\.ts:3 query\(collection\(db, 'events'\), \.\.\.fs/);
    expect(problems.join('\n')).toMatch(
      /c\/dyn\.ts:3 where\(f, op, v\)\n.*outside a statically analysable query/,
    );
    expect(problems.join('\n')).toMatch(/c\/dyn\.ts:4 .*\n.*orderBy\(\) field is not a literal/);
    expect(problems.join('\n')).toContain(
      'allowlist entry no longer matches any query site: c/dyn.ts gone()',
    );
  });
});

describe('Go queries', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'idxguard-go-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const goFixture = (name, src) => {
    const abs = join(tmp, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, src);
    return name;
  };
  const GO = (chain) => `package x

func f() {
	_ = db.Collection("workspaces/" + w + "/runs")${chain}.Documents(ctx)
}
`;
  const withIndex = {
    indexes: [
      idx('runs', [
        ['a', 'ASCENDING'],
        ['b', 'ASCENDING'],
      ]),
    ],
  };

  it('fails a Go query that needs a composite index the config lacks, passes it with the index', () => {
    const file = goFixture('g/q.go', GO('.Where("a", "==", x).Where("b", ">", y)'));
    const bad = guard(tmp, { goFiles: [file], config: { indexes: [] }, allowlist: [] });
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toContain('g/q.go:4');
    expect(bad.problems[0]).toContain("collection 'runs' where(a ==) where(b >)");
    expect(bad.problems[0]).toContain('composite index on runs (a ASCENDING, b ASCENDING)');
    const good = guard(tmp, { goFiles: [file], config: withIndex, allowlist: [] });
    expect(good.problems).toEqual([]);
    expect(good.results).toHaveLength(1);
  });

  it('reads orderBy, consts and path builders; skips unfiltered reads', () => {
    const file = goFixture(
      'g/o.go',
      `package x

import "cloud.google.com/go/firestore"

const status = "status"

func f() {
	_ = db.Collection(base + "/runs").Where(status, "==", 1).OrderBy("at", firestore.Desc).Limit(3)
	_ = db.Collection(actions.CalendarPaths.Busy(u)).Where("end", ">", t)
	_ = db.Collection("runs").Documents(ctx)
}
`,
    );
    const r = guard(tmp, { goFiles: [file], config: { indexes: [] }, allowlist: [] });
    expect(r.results.map((x) => describeQuery(x.shape))).toEqual([
      "collection 'runs' where(status ==) orderBy(at desc)",
      "collection 'busy' where(end >)",
    ]);
    expect(r.problems).toHaveLength(1);
  });

  it('reports non-literal Go queries as unanalysable unless allowlisted, and stale entries', () => {
    const file = goFixture('g/d.go', GO('.Where(field, op, v)'));
    const text = 'db.Collection("workspaces/"+w+"/runs").Where(field, op, v)';
    const open = guard(tmp, { goFiles: [file], config: { indexes: [] }, allowlist: [] });
    expect(open.problems.join('\n')).toMatch(/g\/d\.go:4 .*\n.*not a literal/);
    const ok = guard(tmp, {
      goFiles: [file],
      config: { indexes: [] },
      allowlist: [{ file, text, reason: 'x' }],
    });
    expect(ok.problems).toEqual([]);
    const stale = guard(tmp, {
      goFiles: [file],
      config: { indexes: [] },
      allowlist: [
        { file, text, reason: 'x' },
        { file, text: 'gone()', reason: 'x' },
      ],
    });
    expect(stale.problems.join('\n')).toContain('allowlist entry no longer matches');
  });
});

describe('the repository', () => {
  it('every Firestore query in apps/web and packages/shared has its index', () => {
    const { problems, results } = guard(root);
    expect(problems, problems.join('\n\n')).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  });

  it('scans the Go CLI queries (14, with the live plans and running steps of item qwFAW, the re-check watch of item bmNoI, the instruct watch of item w6O2K and the summaries watch of item OE8Fm) and finds calendar (memberUid, end) in firestore.indexes.json', () => {
    const { problems, results, unanalysable } = guard(root);
    expect(problems).toEqual([]);
    const go = results.filter((r) => r.file.startsWith('cli/'));
    expect(go).toHaveLength(14);
    const cal = go.find((r) => r.shape.group === 'calendar');
    expect(cal?.result.via).toBe('composite');
    expect(unanalysable.filter((u) => u.file.startsWith('cli/'))).toHaveLength(1);
  });
});
