/**
 * What a column claims its expression yields, in one place.
 *
 * Three consumers need that rule and must agree on it: the engine turns each
 * registered `@column` into a function with this signature (`withDtos`,
 * api/dto.ts), the source walkers declare the same function from the options
 * they can read in the syntax (`columnFunctionDeclaration`,
 * analyzer/expression-policy.ts), and `analyzeDto` cross-checks the claim
 * against what it infers the expression really yields (analyzer/analyze-dto.ts).
 * They disagreed once — the walkers dropped the signature for a `collection`
 * column while the engine kept it — which is why the rule lives here rather than
 * three times.
 *
 * Deliberately dependency-free, and typed against the option *presence* rather
 * than `ColumnOptions` itself, so the walkers can call it with what they read out
 * of an AST and the runtime can call it with the real column.
 */

/** The column options this rule reads; `ColumnOptions` and an AST-derived record both satisfy it. */
export interface ColumnTypeClaim {
  /** The declared FHIR type (`ColumnOptions.type`). */
  type?: string | undefined
  /** Present when the column narrows to an `enum` of codes. */
  enum?: unknown
  /** Present when `as` reshapes values outside FHIRPath. */
  as?: unknown
  /** Present when `choices` decodes values outside FHIRPath. */
  choices?: unknown
}

/**
 * The type a column's values carry, or undefined when it claims nothing:
 * `as`/`choices` hand values to JavaScript, so the expression's own result is all
 * that can be said about them, while an `enum` only narrows codes that are
 * Strings either way.
 */
export function columnResultType(column: ColumnTypeClaim): string | undefined {
  if (column.as !== undefined || column.choices !== undefined) {
    return undefined
  }
  return column.type ?? (column.enum !== undefined ? 'System.String' : undefined)
}

/**
 * The analyzer signature a column contributes as a function, or undefined when it
 * claims no type. `collection: true` is the only way a column yields more than
 * one value, so everything else is a singleton.
 */
export function columnSignature(
  column: ColumnTypeClaim & { collection?: boolean }
): { result: { types: string[]; single: boolean } } | undefined {
  const type = columnResultType(column)
  return type === undefined ? undefined : { result: { types: [type], single: column.collection !== true } }
}
