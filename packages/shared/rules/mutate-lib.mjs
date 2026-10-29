/** A mutation is [name, [[find, replace], ...]]. Throws a clear error on any other shape. */
export function assertWellFormed(mutations) {
  const problems = [];
  mutations.forEach((m, i) => {
    const label = `entry #${i + 1}${Array.isArray(m) && typeof m[0] === 'string' ? ` "${m[0]}"` : ''}`;
    if (!Array.isArray(m) || m.length !== 2) {
      problems.push(
        `${label}: expected [name, edits] (2 items), got ${Array.isArray(m) ? m.length : typeof m} (a missing "]," between entries?)`,
      );
      return;
    }
    const [name, edits] = m;
    if (typeof name !== 'string' || !name)
      problems.push(`${label}: the name must be a non-empty string`);
    else if (!Array.isArray(edits) || edits.length === 0)
      problems.push(`${label}: edits must be a non-empty array`);
    else if (
      !edits.every(
        (e) => Array.isArray(e) && e.length === 2 && e.every((x) => typeof x === 'string'),
      )
    )
      problems.push(`${label}: every edit must be [find, replace] strings`);
  });
  if (problems.length)
    throw new Error(`Malformed mutations in mutate.mjs:\n  ${problems.join('\n  ')}`);
}

/** Every mutation edit carries this tag, so a leftover in a tracked file is detectable. */
export const MUTATED_TAG = '/*MUTATED*/';

/** Applies the edits to the rules text; each replacement is followed by the MUTATED tag. */
export function applyEdits(source, edits) {
  return edits.reduce((src, [find, rep]) => src.split(find).join(rep + MUTATED_TAG), source);
}

/** True when the text carries a mutation leftover. */
export const hasMutationLeftover = (source) => source.includes(MUTATED_TAG);
