/** Shapes of the generated R4 model data (see scripts/generate-r4-model.ts). */
export interface GeneratedElement {
  /** Element types; several entries for choice elements (`value[x]`). */
  t: string[]
  /** Present (1) when max cardinality is above 1. */
  a?: 1
}

export interface GeneratedType {
  /** Base type local name, absent for the roots (Base, Element). */
  b?: string
  e: Record<string, GeneratedElement>
}
