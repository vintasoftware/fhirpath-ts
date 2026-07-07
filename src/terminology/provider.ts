import type { TypedValue } from '../values/typed-value.ts'

/**
 * A pluggable FHIR terminology service, mirroring the `%terminologies` API from
 * https://hl7.org/fhir/fhirpath.html#txapi. Every method is optional — implement
 * what your deployment needs; calling a missing one is a clear runtime error.
 *
 * `coded` arguments arrive as plain JSON exactly as found in the input resource:
 * a code string, a Coding object, or a CodeableConcept object. `params` is a
 * URL-encoded parameter string, as the spec defines. Return values are plain
 * JSON resources; return `undefined` when the service cannot answer (an unknown
 * value set, code system, or concept map) — the calling function then yields
 * empty, matching the spec's "the terminology service cannot determine" clause.
 *
 * Providers are only consulted through `evaluateAsync()`; the sync `evaluate()`
 * fails with a pointer to it. Results are cached per evaluation (keyed by
 * operation and arguments), so repeated identical requests hit the provider once.
 */
export interface TerminologyProvider {
  /** ValueSet `$expand`. Returns the expanded ValueSet resource. */
  expand?(valueSet: unknown, params?: string): Promise<unknown>
  /** CodeSystem `$lookup`. Returns a Parameters resource describing the concept. */
  lookup?(coded: unknown, params?: string): Promise<unknown>
  /** ValueSet `$validate-code`. Returns a Parameters resource with a boolean `result` parameter. */
  validateVS?(valueSet: unknown, coded: unknown, params?: string): Promise<unknown>
  /** CodeSystem `$validate-code`. Returns a Parameters resource with a boolean `result` parameter. */
  validateCS?(codeSystem: unknown, coded: unknown, params?: string): Promise<unknown>
  /** CodeSystem `$subsumes`. Returns the outcome code: `equivalent` | `subsumes` | `subsumed-by` | `not-subsumed`. */
  subsumes?(system: string, coded1: unknown, coded2: unknown, params?: string): Promise<unknown>
  /** ConceptMap `$translate`. Returns a Parameters resource with the matches. */
  translate?(conceptMap: unknown, coded: unknown, params?: string): Promise<unknown>
}

/**
 * The value bound to `%terminologies` when a provider is configured. It is an
 * opaque marker — the provider itself lives on the evaluation context — that the
 * terminology API functions recognize as their required input.
 */
export const TERMINOLOGY_SERVICE_TYPE = 'TerminologyService'

const TERMINOLOGY_SERVICE_MARKER = Object.freeze({})

export const terminologyServiceValue: TypedValue = Object.freeze({
  type: TERMINOLOGY_SERVICE_TYPE,
  value: TERMINOLOGY_SERVICE_MARKER,
})

/** True when `input` is exactly the `%terminologies` marker. */
export function isTerminologyService(input: TypedValue[]): boolean {
  return input.length === 1 && (input[0] as TypedValue).value === TERMINOLOGY_SERVICE_MARKER
}
