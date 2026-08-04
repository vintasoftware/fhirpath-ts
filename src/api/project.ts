import { normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathResult } from '../typed/infer.ts'
import { booleanSingleton } from '../values/collection.ts'
import { toSubjects } from './bundle.ts'
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

/** Resolve a column's `as` option into its values mapping. */
function coercion(as: 'Date' | ((value: unknown) => unknown) | undefined): (values: unknown[]) => unknown[] {
  if (as === 'Date') {
    return toJsDates
  }
  if (typeof as === 'function') {
    return values => values.map(as)
  }
  return values => values
}

/** A column resolved against one compiler, ready to run once per row. */
type ColumnReader = (input: unknown, options: EvaluateOptions) => unknown

/** Take the column union apart once, at plan time; rows only run the result. */
function planColumn(name: string, column: ProjectionColumn, compile: Compiler): ColumnReader {
  if (typeof column !== 'string' && 'test' in column) {
    const criteria = compile(column.test)
    return (input, options) => booleanSingleton(criteria.evaluateTyped(input, options)) ?? false
  }
  const spec: Extract<ProjectionColumn, { path: string }> = typeof column === 'string' ? { path: column } : column
  const expression = compile(spec.path)
  const applyAs = coercion(spec.as)
  const empty = 'default' in spec ? spec.default : undefined
  return (input, options) => {
    const values = expression.evaluate(input, options)
    if (spec.collection === true) {
      return applyAs(values)
    }
    // The scalar-column rule counts the expression's values, before any `as`
    // coercion drops unparseable ones.
    if (values.length > 1) {
      throw new FhirPathRuntimeError(
        `project(): column '${name}' yielded ${values.length} values; append first() or set collection: true`
      )
    }
    const coerced = applyAs(values)
    return coerced.length > 0 ? coerced[0] : empty
  }
}

/**
 * The rows of `FhirPathEngine.project()`: one per subject of the input (array
 * item, Bundle entry resource, or the single resource itself); options come
 * pre-merged with the engine defaults. Every column evaluates with `%rowIndex` and
 * `%rowTotal` set to the row's position — the caller's `env` is normalized first,
 * so the row numbering wins over a same-named key in either spelling
 * (`rowIndex` or `%rowIndex`).
 */
export function projectRows(
  input: unknown,
  columns: ProjectionColumns,
  options: EvaluateOptions,
  compile: Compiler
): Record<string, unknown>[] {
  const readers = Object.entries(columns).map(([name, column]) => [name, planColumn(name, column, compile)] as const)
  const subjects = toSubjects(input)
  return subjects.map((subject, index) => {
    const rowOptions: EvaluateOptions = {
      ...options,
      env: { ...normalizeEnvKeys(options.env), rowIndex: index, rowTotal: subjects.length },
    }
    const row: Record<string, unknown> = {}
    for (const [name, read] of readers) {
      row[name] = read(subject.value, rowOptions)
    }
    return row
  })
}
