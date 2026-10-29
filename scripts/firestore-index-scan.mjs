/**
 * Finds every Firestore query in the app and shared sources and reduces it to a
 * `QueryShape` (see firestore-index-rules.mjs), using the TypeScript compiler so that field
 * names held in constants (`MONTH_RUNS.equal`) resolve to their literal types.
 *
 * A "query" is any call of the modular SDK's `query()`. Every `where()` / `orderBy()` call that
 * is not a direct argument of an analysed `query()` is reported too, so a query built some
 * other way (spread arrays, helpers) can never slip through silently: it is "unanalysable" and
 * must be in the allowlist with a reason. Go queries in cli/ are found by scanGo() below.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const SOURCE_DIRS = ['apps/web/src', 'packages/shared/src'];
export const GO_SOURCE_DIRS = ['cli'];
const FIRESTORE_MODULES = new Set([
  'firebase/firestore',
  'firebase/firestore/lite',
  '@firebase/firestore',
]);
const CONSTRAINTS = new Set([
  'where',
  'orderBy',
  'limit',
  'limitToLast',
  'startAt',
  'startAfter',
  'endAt',
  'endBefore',
]);
const IGNORED = new Set(['limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore']);

/** Test files and e2e specs run only against the emulator; they are not production queries. */
export const isProductionSource = (p) =>
  /\.(ts|tsx|mts)$/.test(p) && !/\.(test|spec)\.(ts|tsx|mts)$/.test(p) && !p.endsWith('.d.ts');

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (isProductionSource(p)) out.push(p);
  }
  return out;
}

/** Local name -> imported name, for imports from the Firestore SDK in one file. */
function firestoreImports(sf) {
  const names = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!FIRESTORE_MODULES.has(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return names;
}

/**
 * @param {string} root repo root
 * @param {{ files?: string[] }} [opts] absolute file paths (default: every production source)
 * @returns {{ queries: { file: string, line: number, text: string, shape: import('./firestore-index-rules.mjs').QueryShape }[],
 *   unanalysable: { file: string, line: number, text: string, reason: string }[] }}
 */
export function scan(root, opts = {}) {
  const files = opts.files ?? SOURCE_DIRS.flatMap((d) => walk(join(root, d), []));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    resolveJsonModule: true,
  });
  const checker = program.getTypeChecker();
  const queries = [];
  const unanalysable = [];

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const names = firestoreImports(sf);
    if (names.size === 0) continue;
    const rel = relative(root, file);
    const at = (node) => ({
      file: rel,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: node.getText(sf).replace(/\s+/g, ' '),
    });
    const sdk = (call) =>
      ts.isCallExpression(call) && ts.isIdentifier(call.expression)
        ? names.get(call.expression.text)
        : undefined;

    /** A string from a literal, a literal-typed expression or a const initializer. */
    const literal = (expr) => {
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
      if (ts.isCallExpression(expr) && sdk(expr) === 'documentId') return '__name__';
      const t = checker.getTypeAtLocation(expr);
      if (t.isStringLiteral()) return t.value;
      return null;
    };

    /** The collection id at the end of a path argument. */
    const lastSegment = (expr) => {
      if (ts.isTemplateExpression(expr)) {
        const tail = expr.templateSpans[expr.templateSpans.length - 1].literal.text;
        const m = /\/([^/]+)$/.exec(tail);
        return m ? m[1] : null;
      }
      const s = literal(expr);
      return s === null ? null : (s.split('/').pop() ?? null);
    };

    /** Follow a `const x = collection(...)` identifier to its initializer, once. */
    const resolveIdent = (expr) => {
      if (!ts.isIdentifier(expr)) return expr;
      const sym = checker.getSymbolAtLocation(expr);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const flags = ts.getCombinedNodeFlags(decl);
        if (flags & ts.NodeFlags.Const) return decl.initializer;
      }
      return expr;
    };

    /** collection(...) / collectionGroup(...) (optionally .withConverter(...)). */
    const base = (expr0) => {
      let expr = resolveIdent(expr0);
      while (
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === 'withConverter'
      ) {
        expr = resolveIdent(expr.expression.expression);
      }
      if (!ts.isCallExpression(expr))
        return { error: 'the query base is not a collection()/collectionGroup() call' };
      const fn = sdk(expr);
      if (fn === 'collectionGroup') {
        const group = expr.arguments[1] ? literal(expr.arguments[1]) : null;
        if (!group) return { error: 'collectionGroup id is not a literal' };
        return { group, scope: 'COLLECTION_GROUP' };
      }
      if (fn === 'collection') {
        const last = expr.arguments[expr.arguments.length - 1];
        const group = last && expr.arguments.length > 1 ? lastSegment(last) : null;
        if (!group) return { error: 'collection id at the end of the path is not a literal' };
        return { group, scope: 'COLLECTION' };
      }
      return { error: 'the query base is not a collection()/collectionGroup() call' };
    };

    const consumed = new Set();

    const analyse = (call) => {
      const [first, ...rest] = call.arguments;
      if (!first || rest.some((a) => ts.isSpreadElement(a)) || ts.isSpreadElement(first)) {
        return { error: 'spread arguments' };
      }
      const b = base(first);
      if (b.error) return b;
      const shape = { group: b.group, scope: b.scope, filters: [], orders: [] };
      for (const arg of rest) {
        const fn = ts.isCallExpression(arg) ? sdk(arg) : undefined;
        if (!fn || !CONSTRAINTS.has(fn))
          return {
            error: `argument '${arg.getText(sf)}' is not a where/orderBy/limit/cursor call`,
          };
        consumed.add(arg);
        if (IGNORED.has(fn)) continue;
        const field = arg.arguments[0] ? literal(arg.arguments[0]) : null;
        if (field === null) return { error: `${fn}() field is not a literal` };
        if (fn === 'where') {
          const op = arg.arguments[1] ? literal(arg.arguments[1]) : null;
          if (op === null) return { error: 'where() operator is not a literal' };
          shape.filters.push({ field, op });
        } else {
          const dirArg = arg.arguments[1];
          const dir = dirArg ? literal(dirArg) : 'asc';
          if (dir !== 'asc' && dir !== 'desc')
            return { error: 'orderBy() direction is not a literal' };
          shape.orders.push({ field, dir });
        }
      }
      return { shape };
    };

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const fn = sdk(node);
        if (fn === 'query') {
          const r = analyse(node);
          if (r.error) {
            // Its own constraints are covered by this one entry.
            node.arguments.forEach((a) => consumed.add(a));
            unanalysable.push({ ...at(node), reason: r.error });
          } else queries.push({ ...at(node), shape: r.shape });
        } else if ((fn === 'and' || fn === 'or') && !consumed.has(node)) {
          unanalysable.push({ ...at(node), reason: `composite ${fn}() filter (not modelled)` });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // where()/orderBy() calls that no analysed query() consumed.
    const stray = (node) => {
      if (
        ts.isCallExpression(node) &&
        (sdk(node) === 'where' || sdk(node) === 'orderBy') &&
        !consumed.has(node)
      ) {
        unanalysable.push({
          ...at(node),
          reason: `${sdk(node)}() outside a statically analysable query()`,
        });
      }
      ts.forEachChild(node, stray);
    };
    stray(sf);
  }
  return { queries, unanalysable };
}

/** Production Go sources: no tests, no fixtures. Paths relative to `root`. */
export const isGoProductionSource = (p) =>
  p.endsWith('.go') && !p.endsWith('_test.go') && !/(^|\/)(testdata|vendor|node_modules)\//.test(p);

function goFiles(root) {
  return GO_SOURCE_DIRS.flatMap((d) => {
    try {
      return readdirSync(join(root, d), { recursive: true })
        .map((f) => join(d, String(f)).split('\\').join('/'))
        .filter(isGoProductionSource);
    } catch {
      return [];
    }
  }).sort();
}

/**
 * Go queries (`Collection(..).Where(..).OrderBy(..)`), found by scripts/go-query-scan (go/ast,
 * standard library only, no network). Same result shape as scan(); a query the scanner cannot
 * reduce to literals comes back as unanalysable.
 * @param {string} root repo root
 * @param {{ goFiles?: string[] }} [opts] files relative to root (default: every production .go under cli/)
 */
export function scanGo(root, opts = {}) {
  const files = opts.goFiles ?? goFiles(root);
  if (files.length === 0) return { queries: [], unanalysable: [] };
  const tool = join(dirname(fileURLToPath(import.meta.url)), 'go-query-scan', 'main.go');
  const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:/usr/local/go/bin` };
  let raw;
  try {
    raw = execFileSync('go', ['run', tool, root, ...files], {
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(
      `the Go query scanner failed (is the Go toolchain installed?): ${e.stderr || e.message}`,
      { cause: e },
    );
  }
  const queries = [];
  const unanalysable = [];
  for (const q of JSON.parse(raw)) {
    if (q.error) unanalysable.push({ file: q.file, line: q.line, text: q.text, reason: q.error });
    else
      queries.push({
        file: q.file,
        line: q.line,
        text: q.text,
        shape: { group: q.group, scope: q.scope, filters: q.filters, orders: q.orders },
      });
  }
  return { queries, unanalysable };
}
