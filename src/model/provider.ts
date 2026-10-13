/** Type and cardinality of one element of a class, from the model's ModelInfo. */
export interface ElementInfo {
  /** Canonical type name(s); more than one for choice elements like `Observation.value[x]`. */
  types: string[]
  isCollection: boolean
  /** True for `[x]` elements, whose JSON keys carry a type suffix (`valueQuantity`). */
  isChoice: boolean
  /**
   * Resource type names a Reference-typed element may point to, from
   * `Reference.targetProfile` — what resolve() statically yields. Absent when
   * the element is not a reference or the reference is unconstrained.
   */
  referenceTargets?: string[]
  /** True when the element's minimum cardinality is at least 1. Instance selectors warn when one is missing. */
  isRequired?: boolean
}

/**
 * The spec's ModelInfo concept ("Types and Reflection", "Model Information"): everything the engine and the static
 * analyzer need to know about a data model. The core never assumes FHIR; the R4
 * model package implements this from generated StructureDefinition data.
 */
export interface ModelProvider {
  /** Namespace prefix for the model's types, e.g. `FHIR`. */
  namespace: string
  /** Resolve an unqualified type name to its canonical name, or undefined if unknown. */
  resolveType(name: string): string | undefined
  /** Look up an element on a type, resolving choice elements by their stem name. */
  getElement(type: string, element: string): ElementInfo | undefined
  /** True when `type` equals or derives from `base` (both canonical). */
  isSubtypeOf(type: string, base: string): boolean
  /**
   * All element names of a type, own and inherited, in declaration order.
   * Undefined when the type is unknown to the model — navigation then falls back
   * to raw JSON reads instead of strict unknown-element errors.
   */
  listElements?(type: string): string[] | undefined
  /**
   * The regular expression a primitive type's value matches whole, as FHIR's
   * `regex` extension gives it, or undefined. Instance selectors check the
   * primitives they build against it.
   */
  valuePattern?(type: string): string | undefined
}
