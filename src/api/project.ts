import { FhirPathRuntimeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathResult } from '../typed/infer.ts'
import { booleanSingleton } from '../values/collection.ts'
import type { Compiler, EvaluateOptions } from './compile.ts'

/**
 * One column of a `project()` call. The plain-string form is an expression whose
 * scalar value (first of at most one) becomes the column. The object forms:
 *
 * - `{ path, collection: true }` keeps all values instead of the scalar rule.
 * - `{ path, type }` declares the column's FHIR type (mirroring SQL-on-FHIR
 *   ViewDefinition `column.type`) when the expression is outside the inference
 *   subset. A compile-time assertion only — it is not checked at runtime.
 * - `{ path, as: 'Date' }` coerces values to JS `Date`s: FHIR date/dateTime/
 *   instant strings parse per ISO 8601, so a partial date becomes the UTC start
 *   of its period (`2026-01` → Jan 1 midnight UTC). A value that is not a
 *   parseable date — a time, a non-string — coerces to empty, matching the
 *   `toX()` conversion-function contract.
 * - `{ path, as: fn }` maps each value through `fn`; the column's type is the
 *   function's return type. The escape hatch for display-ready shaping — prefer
 *   `type`/`'Date'`/`default` where they fit, so columns stay declarative.
 * - `{ path, default }` fills an *empty* result with a plain JS value, after
 *   any `as` coercion — and, unlike an in-expression `| 'fallback'` union, it
 *   also removes `undefined` from the column's type. FHIRPath has no `null`,
 *   so this is also the way a column yields one.
 * - `{ test }` evaluates the expression as a boolean criteria, with the same
 *   spec §4.5 semantics as `FhirPathEngine.test()`: empty → false, a single
 *   boolean → itself. The column is always a `boolean`.
 *
 * `as` decides the column's JS type, so a `type` given alongside it is ignored.
 */
export type ProjectionColumn =
  | string
  | {
      path: string
      collection?: boolean
      type?: keyof R4TypeOf
      as?: 'Date' | ((value: unknown) => unknown)
      default?: unknown
    }
  | { test: string }

export type ProjectionColumns = Record<string, ProjectionColumn>

type ColumnPath<Column extends ProjectionColumn> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

/** `as` wins (function return type, or Date), then a declared `type`; otherwise inference. */
type ColumnValues<Column extends ProjectionColumn> = Column extends { as: (value: never) => infer R }
  ? R[]
  : Column extends { as: 'Date' }
    ? Date[]
    : Column extends { type: infer T extends keyof R4TypeOf }
      ? R4TypeOf[T][]
      : FhirpathResult<ColumnPath<Column>>

/** A `default` replaces the empty case, so it substitutes for `undefined` in the type. */
type ColumnResult<Column extends ProjectionColumn> = Column extends { test: string }
  ? boolean
  : Column extends { collection: true }
    ? ColumnValues<Column>
    : Column extends { default: infer D }
      ? ColumnValues<Column>[number] | D
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

function coerce(values: unknown[], as: 'Date' | ((value: unknown) => unknown) | undefined): unknown[] {
  if (as === 'Date') {
    return toJsDates(values)
  }
  if (typeof as === 'function') {
    return values.map(as)
  }
  return values
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
    if (typeof column !== 'string' && 'test' in column) {
      row[name] = booleanSingleton(compile(column.test).evaluateTyped(input, rowOptions)) ?? false
      continue
    }
    const path = typeof column === 'string' ? column : column.path
    const collection = typeof column !== 'string' && column.collection === true
    const values = compile(path).evaluate(input, rowOptions)
    // The scalar-column rule counts the expression's values, before any `as`
    // coercion drops unparseable ones.
    if (!collection && values.length > 1) {
      throw new FhirPathRuntimeError(
        `project(): column '${name}' yielded ${values.length} values; append first() or set collection: true`
      )
    }
    const coerced = coerce(values, typeof column === 'string' ? undefined : column.as)
    if (collection) {
      row[name] = coerced
    } else if (coerced.length > 0) {
      row[name] = coerced[0]
    } else {
      row[name] = typeof column !== 'string' && 'default' in column ? column.default : undefined
    }
  }
  return row
}
