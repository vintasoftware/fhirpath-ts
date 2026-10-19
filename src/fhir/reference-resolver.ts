/**
 * Resolves an external reference for `resolve()`: anything the engine cannot
 * find in the input's contained resources or Bundle entries (absolute urls,
 * relative `Type/id` references against a server base — but never `#fragment`
 * references, which are internal by definition). Returns the resource as plain
 * JSON, or `undefined` when the reference cannot be resolved — that reference
 * then yields nothing, like every other unresolvable reference.
 *
 * `reference` arrives unchanged. For a relative reference, `base` is the server
 * base of the resource that holds it, when known: from that resource's Bundle
 * entry `fullUrl`, or else from the absolute reference that fetched it or the
 * Bundle holding it (or the base that one was resolved against). FHIR resolves a relative reference against
 * that base; without one the host chooses.
 *
 * Resolvers are async (they typically fetch), so only `evaluateAsync()` and
 * `evaluateTypedAsync()` accept one (`AsyncEvaluateOptions.resolver`); a sync
 * evaluation given one fails with a pointer to them. Results are cached per
 * evaluation by reference and base, so one reference is fetched at most once
 * no matter how often the expression resolves it.
 */
export type ReferenceResolver = (reference: string, base: string | undefined) => Promise<unknown>
