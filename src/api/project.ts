import { type EvaluationContext, forkVariables } from '../engine/context.ts'
import { evaluateNode } from '../engine/evaluator.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathResultIn } from '../typed/infer.ts'
import { booleanSingleton } from '../values/collection.ts'
import { toCollection, type TypedValue, unwrap } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import { type Compiler, contextFactory, type EvaluateOptions } from './compile.ts'

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
 *   `type`/`'Date'`/`default`/`map` where they fit, so columns stay declarative.
 * - `{ path, map }` looks each value up by string key: a hit becomes the
 *   mapped value, a miss becomes empty — so `default` doubles as the fallback
 *   for unexpected codes. The declarative form of `as: v => map[v]`, typed
 *   from the map's values: decode a status code into a display label or tone
 *   without an env-table join. Only own keys match (no prototype hits), and
 *   non-primitive values never match. A column declares `as` or `map`, not both.
 * - `{ path, map, pick }` — `map` also accepts a display table, an array of
 *   rows keyed by their `code` field. The column yields the matching row's
 *   `pick` field (`{ map: STATUS_META, pick: 'tone' }`), typed from the row;
 *   omit `pick` to yield the whole row. The first row wins on a duplicate
 *   code, mirroring the `where(code = …).first()` idiom this replaces. `pick`
 *   is only meaningful with the table form.
 * - `{ path, enum: ['asNeeded', 'continuous'] }` types the column as the union
 *   of the listed strings — the cast-free way to a literal-union column — and
 *   checks it at runtime: a value outside the list becomes empty, so `default`
 *   catches it. The analyzer side stays a plain string.
 * - `{ path, default }` fills an *empty* result with a plain JS value, after
 *   any `as`/`map` coercion — and, unlike an in-expression `| 'fallback'` union,
 *   it also removes `undefined` from the column's type. FHIRPath has no `null`,
 *   so this is also the way a column yields one.
 * - `{ test }` evaluates the expression as a boolean criteria, with the same
 *   spec §4.5 semantics as `FhirPathEngine.test()`: empty → false, a single
 *   boolean → itself. The column is always a `boolean`.
 *
 * `as`, `map`, and `enum` are alternatives — a column declares at most one —
 * and each decides the column's JS type, so a `type` given alongside any of
 * them is ignored.
 */
export type ProjectionColumn = string | ({ path: string } & ColumnOptions) | { test: string }

/**
 * A path column's options besides the path itself; a DTO's column builder
 * (`defineDto`, api/dto.ts) takes the same set. The shaper members make
 * `as`/`map`/`enum` mutually exclusive at the type level, and tie `pick` to
 * the table form of `map`; `planColumn` re-checks both at plan time for
 * callers outside the type system.
 */
export type ColumnOptions = {
  collection?: boolean
  type?: keyof R4TypeOf
  default?: unknown
} & (
  | { as?: 'Date' | ((value: unknown) => unknown); map?: never; pick?: never; enum?: never }
  | { map: Readonly<Record<string, unknown>>; as?: never; pick?: never; enum?: never }
  | { map: readonly { code: string }[]; pick?: string; as?: never; enum?: never }
  | { enum: readonly string[]; as?: never; map?: never; pick?: never }
)

export type ProjectionColumns = Record<string, ProjectionColumn>

type ColumnPath<Column> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

/** `as` wins (function return type, or Date), then `map` (row/`pick` field for tables, value types for Records), then `enum` (union of its strings), then a declared `type`; otherwise inference in the `Root` context. */
type ColumnValues<Column, Root extends string> = Column extends { as: (value: never) => infer R }
  ? R[]
  : Column extends { as: 'Date' }
    ? Date[]
    : Column extends { map: readonly (infer Row extends { code: string })[] }
      ? Column extends { pick: infer Key extends keyof Row }
        ? Row[Key][]
        : Row[]
      : Column extends { map: infer M extends Readonly<Record<string, unknown>> }
        ? M[keyof M][]
        : Column extends { enum: readonly (infer V extends string)[] }
          ? V[]
          : Column extends { type: infer T extends keyof R4TypeOf }
            ? R4TypeOf[T][]
            : FhirpathResultIn<ColumnPath<Column>, Root>

/**
 * A `default` replaces the empty case, so it substitutes for `undefined` in
 * the type. `Root` is the context the path infers against — a DTO's `fhirType`
 * (see `defineDto`), or 'opaque' for a bare `project()` columns record, where
 * every path carries its own root. Constrained by the columns' outer shapes
 * only, so a column builder can apply it to a generic `{ path } & Options`
 * intersection the checker cannot prove is one ProjectionColumn member.
 */
export type ColumnResult<
  Column extends string | { path: string } | { test: string },
  Root extends string = 'opaque',
> = Column extends {
  test: string
}
  ? boolean
  : Column extends { collection: true }
    ? ColumnValues<Column, Root>
    : Column extends { default: infer D }
      ? ColumnValues<Column, Root>[number] | D
      : ColumnValues<Column, Root>[number] | undefined

/** The row shape `project()` produces: each column's type inferred from its expression. */
export type Projection<Columns extends ProjectionColumns, Root extends string = 'opaque'> = {
  -readonly [K in keyof Columns]: ColumnResult<Columns[K], Root>
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

/** The string key a `map` looks up: primitives via String(), anything else never matches. */
function mapKey(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined
}

/** The `map` lookup over a plain Record: own keys only; a miss becomes empty. */
function recordLookup(map: Readonly<Record<string, unknown>>): (values: unknown[]) => unknown[] {
  return values =>
    values.flatMap(value => {
      const key = mapKey(value)
      return key !== undefined && Object.hasOwn(map, key) ? [map[key]] : []
    })
}

/**
 * The `map` lookup over a display table: rows keyed by `code` (first row wins,
 * like the `where(code = …).first()` idiom this replaces), yielding the `pick`
 * field or the whole row. A miss — no row, or a row without the field — becomes empty.
 */
function tableLookup(rows: readonly { code: string }[], pick: string | undefined): (values: unknown[]) => unknown[] {
  const byCode = new Map<string, { code: string }>()
  for (const row of rows) {
    if (!byCode.has(row.code)) {
      byCode.set(row.code, row)
    }
  }
  return values =>
    values.flatMap(value => {
      const key = mapKey(value)
      const row = key === undefined ? undefined : byCode.get(key)
      if (row === undefined) {
        return []
      }
      if (pick === undefined) {
        return [row]
      }
      const field = (row as Record<string, unknown>)[pick]
      return field === undefined ? [] : [field]
    })
}

/** The `enum` check: values outside the listed strings become empty. */
function enumLookup(allowed: readonly string[]): (values: unknown[]) => unknown[] {
  const members = new Set<unknown>(allowed)
  return values => values.filter(value => members.has(value))
}

/** The table form of `map`; Array.isArray alone cannot exclude the Record form for the checker. */
function isTable(
  map: Readonly<Record<string, unknown>> | readonly { code: string }[]
): map is readonly { code: string }[] {
  return Array.isArray(map)
}

/** Resolve a column's `as`/`map`/`enum` option into its values mapping. */
function coercion(spec: Extract<ProjectionColumn, { path: string }>): (values: unknown[]) => unknown[] {
  if (spec.map !== undefined) {
    return isTable(spec.map) ? tableLookup(spec.map, spec.pick) : recordLookup(spec.map)
  }
  if (spec.enum !== undefined) {
    return enumLookup(spec.enum)
  }
  if (spec.as === 'Date') {
    return toJsDates
  }
  if (typeof spec.as === 'function') {
    const as = spec.as
    return values => values.map(as)
  }
  return values => values
}

/**
 * ColumnOptions makes these combinations unrepresentable for TypeScript
 * callers, but untyped callers reach project() too (the demo playground
 * executes editor code transpile-only), so misuse fails loudly at plan time
 * instead of one shaper silently winning.
 */
function assertShaperOptions(name: string, spec: Extract<ProjectionColumn, { path: string }>): void {
  const shapers = [spec.as, spec.map, spec.enum].filter(option => option !== undefined).length
  if (shapers > 1) {
    throw new FhirPathRuntimeError(`project(): column '${name}' declares more than one of 'as', 'map', 'enum'; use one`)
  }
  if (spec.pick !== undefined && !Array.isArray(spec.map)) {
    throw new FhirPathRuntimeError(
      `project(): column '${name}' has 'pick' without a table 'map' (an array of { code, … } rows)`
    )
  }
  if (spec.pick !== undefined && Array.isArray(spec.map) && spec.map.length > 0) {
    const pick = spec.pick
    // A field no row carries is a typo, not a sparse table — fail at plan time.
    if (!spec.map.some(row => Object.hasOwn(row as object, pick))) {
      throw new FhirPathRuntimeError(`project(): column '${name}' picks '${pick}', which no row of its table has`)
    }
  }
}

/**
 * A column resolved against one compiler, ready to run once per row-context.
 * Each read forks the context's variables, so one column's defineVariable()
 * never leaks into the next.
 */
type ColumnReader = (root: TypedValue[], context: EvaluationContext) => unknown

/** Take the column union apart once, at plan time; rows only run the result. */
function planColumn(name: string, column: ProjectionColumn, compile: Compiler): ColumnReader {
  if (typeof column !== 'string' && 'test' in column) {
    const criteria = compile(column.test)
    return (root, context) => booleanSingleton(evaluateNode(criteria.ast, forkVariables(context), root)) ?? false
  }
  const spec: Extract<ProjectionColumn, { path: string }> = typeof column === 'string' ? { path: column } : column
  assertShaperOptions(name, spec)
  const expression = compile(spec.path)
  const applyAs = coercion(spec)
  const empty = 'default' in spec ? spec.default : undefined
  return (root, context) => {
    const values = evaluateNode(expression.ast, forkVariables(context), root).map(unwrap)
    if (spec.collection === true) {
      return applyAs(values)
    }
    // The scalar-column rule counts the expression's values, before any `as`
    // coercion or `map` miss drops them.
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
 * pre-merged with the engine defaults. Each row evaluates in one shared
 * context: `%rowIndex` and `%rowTotal` are set to the row's position — the
 * caller's `env` is normalized first, so the row numbering wins over a
 * same-named key in either spelling (`rowIndex` or `%rowIndex`) — and `vars`
 * bind once, with the row as focus and the row numbering in scope, so every
 * column reads the same typed bindings.
 */
export function projectRows(
  input: unknown,
  columns: ProjectionColumns,
  options: EvaluateOptions,
  compile: Compiler
): Record<string, unknown>[] {
  const readers = Object.entries(columns).map(([name, column]) => [name, planColumn(name, column, compile)] as const)
  const makeContext = contextFactory(options)
  const subjects = toSubjects(input)
  return subjects.map((subject, index) => {
    const root = toCollection(subject.value)
    const context = makeContext(root, { rowIndex: index, rowTotal: subjects.length })
    const row: Record<string, unknown> = {}
    for (const [name, read] of readers) {
      row[name] = read(root, context)
    }
    return row
  })
}
