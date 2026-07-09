/** Shapes of the generated R4 model data (see scripts/generate-r4-model.ts). */
export interface GeneratedElement {
  /** Element types; several entries for choice elements (`value[x]`). */
  t: string[]
  /** Present (1) when max cardinality is above 1. */
  a?: 1
  /** Present (1) for choice elements: JSON keys carry a type suffix (valueQuantity). */
  c?: 1
  /** Resource names a Reference element may point to (targetProfile); absent when unconstrained. */
  r?: string[]
}

export interface GeneratedType {
  /** Base type local name, absent for the roots (Base, Element). */
  b?: string
  e: Record<string, GeneratedElement>
}
