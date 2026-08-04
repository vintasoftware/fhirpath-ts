import { FhirPathRuntimeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathResult } from '../typed/infer.ts'
import type { Compiler, EvaluateOptions } from './compile.ts'

/**
 * One column of a `project()` call: an expression, or an object form with
 * `collection: true` to keep all values and/or `type` to declare the column's
 * FHIR type (mirroring SQL-on-FHIR ViewDefinition `column.type`) when the
 * expression is outside the inference subset. A declared `type` is a
 * compile-time assertion only — it is not checked at runtime.
 *
 * `as: 'Date'` coerces the column's values to JS `Date`s: FHIR date/dateTime/
 * instant strings parse per ISO 8601, so a partial date becomes the UTC start
 * of its period (`2026-01` → Jan 1 midnight UTC). A value that is not a
 * parseable date — a time, a non-string — coerces to empty, matching the
 * `toX()` conversion-function contract. `as` decides the column's JS type, so
 * a `type` given alongside it is ignored.
 */
export type ProjectionColumn = string | { path: string; collection?: boolean; type?: keyof R4TypeOf; as?: 'Date' }

export type ProjectionColumns = Record<string, ProjectionColumn>

type ColumnPath<Column extends ProjectionColumn> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

/** `as: 'Date'` wins, then a declared `type`; otherwise the type is inferred from the expression. */
type ColumnValues<Column extends ProjectionColumn> = Column extends { as: 'Date' }
  ? Date[]
  : Column extends { type: infer T extends keyof R4TypeOf }
    ? R4TypeOf[T][]
    : FhirpathResult<ColumnPath<Column>>

type ColumnResult<Column extends ProjectionColumn> = Column extends { collection: true }
  ? ColumnValues<Column>
  : ColumnValues<Column>[number] | undefined

/** The row shape `project()` produces: each column's type inferred from its expression. */
export type Projection<Columns extends ProjectionColumns> = {
  -readonly [K in keyof Columns]: ColumnResult<Columns[K]>
}

/** The `as: 'Date'` coercion; a value that is not a parseable date string becomes empty. */
function toJsDates(values: unknown[]): Date[] {
  return values.flatMap(value => {
    if (typeof value !== 'string') {
      return []
    }
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? [] : [date]
  })
}

/**
 * One row of `FhirPathEngine.project()`; options come pre-merged with the engine
 * defaults. Every column evaluates with `%index` and `%total` set to the row's
 * position — these override same-named keys in the caller's `env`, so the row
 * numbering cannot be spoofed.
 */
export function projectOne(
  input: unknown,
  columns: ProjectionColumns,
  options: EvaluateOptions,
  compile: Compiler,
  position: { index: number; total: number } = { index: 0, total: 1 }
): Record<string, unknown> {
  const rowOptions: EvaluateOptions = {
    ...options,
    env: { ...options.env, index: position.index, total: position.total },
  }
  const row: Record<string, unknown> = {}
  for (const [name, column] of Object.entries(columns)) {
    const path = typeof column === 'string' ? column : column.path
    const collection = typeof column !== 'string' && column.collection === true
    const asDate = typeof column !== 'string' && column.as === 'Date'
    const values = compile(path).evaluate(input, rowOptions)
    // The scalar-column rule counts the expression's values, before any `as`
    // coercion drops unparseable ones.
    if (!collection && values.length > 1) {
      throw new FhirPathRuntimeError(
        `project(): column '${name}' yielded ${values.length} values; append first() or set collection: true`
      )
    }
    const coerced = asDate ? toJsDates(values) : values
    row[name] = collection ? coerced : coerced[0]
  }
  return row
}
