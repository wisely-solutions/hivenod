#!/usr/bin/env node
/**
 * Index guard: every Firestore query in apps/web/src and packages/shared/src must be servable by
 * firestore.indexes.json (the emulator never checks; production does). The Go CLI's queries (cli/)
 * are not scanned.
 * Usage: node scripts/check-firestore-indexes.mjs   (exit 1 with file:line and the missing index)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST } from './firestore-index-allowlist.mjs';
import { check, describeQuery } from './firestore-index-rules.mjs';
import { scan } from './firestore-index-scan.mjs';

/**
 * @param {string} root
 * @param {{ config?: any, allowlist?: typeof ALLOWLIST, files?: string[] }} [opts]
 */
export function guard(root, opts = {}) {
  const config =
    opts.config ?? JSON.parse(readFileSync(join(root, 'firestore.indexes.json'), 'utf8'));
  const allowlist = opts.allowlist ?? ALLOWLIST;
  const { queries, unanalysable } = scan(root, { files: opts.files });
  const problems = [];
  const results = [];
  for (const q of queries) {
    let r;
    try {
      r = check(q.shape, config);
    } catch (e) {
      problems.push(
        `${q.file}:${q.line} ${describeQuery(q.shape)}\n  cannot be checked: ${e.message}`,
      );
      continue;
    }
    results.push({ ...q, result: r });
    if (!r.ok) {
      problems.push(
        `${q.file}:${q.line} ${describeQuery(q.shape)}\n  needs ${r.missing}; add to firestore.indexes.json:\n  ${JSON.stringify(r.suggestion)}`,
      );
    }
  }
  const used = new Set();
  for (const u of unanalysable) {
    const i = allowlist.findIndex((a) => a.file === u.file && a.text === u.text);
    if (i >= 0) used.add(i);
    else
      problems.push(
        `${u.file}:${u.line} ${u.text}\n  cannot be analysed statically (${u.reason}); write it with literal where/orderBy arguments inside query(), or add it to scripts/firestore-index-allowlist.mjs with the reason it is safe`,
      );
  }
  allowlist.forEach((a, i) => {
    if (!used.has(i))
      problems.push(`allowlist entry no longer matches any query site: ${a.file} ${a.text}`);
  });
  return { problems, results, unanalysable };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, results, unanalysable } = guard(root);
  for (const r of results)
    console.log(`ok  ${r.file}:${r.line} ${describeQuery(r.shape)} [${r.result.via ?? 'MISSING'}]`);
  for (const u of unanalysable) console.log(`allowlisted  ${u.file}:${u.line} ${u.text}`);
  if (problems.length) {
    console.error(
      `\nFirestore index guard: ${problems.length} problem(s)\n\n${problems.join('\n\n')}`,
    );
    process.exit(1);
  }
  console.log(
    `\nFirestore index guard: ${results.length} queries servable by firestore.indexes.json`,
  );
}
