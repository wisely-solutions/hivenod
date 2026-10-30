// Node resolve hook for scripts that load packages/shared/src/*.ts directly (Node 22 strips the
// types itself): the shared sources import each other without an extension ('./actions'), which
// only bundlers resolve. This retries such a relative import with `.ts`. Registered by
// scripts/migrate-project-to-threads.mjs; vitest needs none.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier))
      return next(`${specifier}.ts`, context);
    throw e;
  }
}
