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
 * What a registered column declares as a function. `input` is the type the
 * column was written for, which is the DTO class's `fhirType`. `result` is what
 * its expression returns. A column may declare either, both, or neither. The
 * shape is assignable to `CustomFunctionSignature`.
 */
export interface ColumnFunctionSignature {
  input?: { types: string[] }
  result?: { types: string[]; single: boolean }
}

/**
 * The analyzer signature a column contributes as a function, or undefined when
 * it claims nothing at all. `collection: true` is the only way a column yields
 * more than one value, so everything else is a singleton.
 *
 * `hostType` is the class's `fhirType`. It comes from the DTO rather than from
 * the column options, so it is a separate parameter and `ColumnTypeClaim` stays
 * about the column's own output. A caller that cannot see the class, such as a
 * walker whose DTO extends an imported base, passes nothing, and calls to that
 * column go unchecked. Pass an empty claim to keep the input type while
 * dropping a result the caller cannot read from the source.
 */
export function columnSignature(
  column: ColumnTypeClaim & { collection?: boolean },
  hostType?: string
): ColumnFunctionSignature | undefined {
  const type = columnResultType(column)
  const input = hostType === undefined ? undefined : { types: [hostType] }
  const result = type === undefined ? undefined : { types: [type], single: column.collection !== true }
  if (input === undefined && result === undefined) {
    return undefined
  }
  return { ...(input !== undefined && { input }), ...(result !== undefined && { result }) }
}

/**
 * The signature a `@criteria` contributes. Its expression goes through the
 * criteria rule (see `criteriaBoolean`), so the function returns a single
 * Boolean whatever the expression returns. This is a function rather than a
 * shared constant, so one caller cannot change what the next caller reads.
 */
export function criteriaSignature(hostType?: string): ColumnFunctionSignature {
  return {
    ...(hostType !== undefined && { input: { types: [hostType] } }),
    result: { types: ['System.Boolean'], single: true },
  }
}
