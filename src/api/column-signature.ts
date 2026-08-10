/**
 * Shared column signature rules for DTO registration, source walkers, and
 * `analyzeDto`. This file accepts simple option shapes so it has no runtime or
 * AST dependency.
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
 * Returns the function signature contributed by a column. `hostType` is the DTO
 * type. A source walker may omit it when the class root is not visible.
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
