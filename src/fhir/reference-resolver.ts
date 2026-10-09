/**
 * Resolves an external reference for `resolve()`: anything the engine cannot
 * find in the input's contained resources or Bundle entries (absolute urls,
 * relative `Type/id` references against a server base — but never `#fragment`
 * references, which are internal by definition). Returns the resource as plain
 * JSON, or `undefined` when the reference cannot be resolved — that reference
 * then yields nothing, like every other unresolvable reference.
 *
 * Resolvers are async (they typically fetch), so they are only consulted through
 * `evaluateAsync()`; the sync `evaluate()` fails with a pointer to it. Results
 * are cached per evaluation, so one reference is fetched at most once no matter
 * how often the expression resolves it.
 */
export type ReferenceResolver = (reference: string) => Promise<unknown>
