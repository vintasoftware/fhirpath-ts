/** The subset of a FHIR Bundle the engine needs in order to unwrap it. */
export interface BundleLike {
  resourceType: 'Bundle'
  entry?: { resource?: unknown }[]
}

export function isBundle(value: unknown): value is BundleLike {
  return typeof value === 'object' && value !== null && (value as { resourceType?: unknown }).resourceType === 'Bundle'
}

/** One unit of work for the per-resource engine methods (`filter`, `project`, `checkConstraints`). */
export interface Subject {
  value: unknown
  /** Position in the input array or in `Bundle.entry`; absent for a single resource. */
  index?: number
}

/**
 * The per-resource view of an engine input: array items, a Bundle's entry
 * resources (original entry positions kept, entries without a resource
 * skipped), or the value itself.
 */
export function toSubjects(input: unknown): Subject[] {
  if (Array.isArray(input)) {
    return input.map((value, index) => ({ value, index }))
  }
  if (isBundle(input)) {
    return (Array.isArray(input.entry) ? input.entry : [])
      .map((entry, index) => ({ value: entry.resource, index }))
      .filter(subject => subject.value != null)
  }
  return [{ value: input }]
}
