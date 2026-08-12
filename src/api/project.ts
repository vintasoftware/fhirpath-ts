import { type EvaluationContext, forkVariables } from '../engine/context.ts'
import { evaluateNode } from '../engine/evaluator.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { EmptyFhirpathTypeContext, FhirpathResultForContext, MergeFhirpathTypeContexts } from '../typed/infer.ts'
import { criteriaBoolean } from '../values/collection.ts'
import { toCollection, type TypedValue, unwrap } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import { type Compiler, contextFactory, type EvaluateOptions } from './compile.ts'

/**
 * One `project()` column. A string or `{ path }` returns one optional value.
 * `collection` keeps every value, `default` fills an empty result, and `test`
 * returns one criteria boolean. `as`, `choices`, and `enum` are alternative
 * value conversions. `type` declares a result type for TypeScript and is not
 * checked at runtime. See `docs/api.md#project` for all options.
 */
export type ProjectionColumn = string | ({ path: string } & ColumnOptions) | { test: string }

/** Options shared by plain project columns and DTO `@column` fields. */
export type ColumnOptions = {
  collection?: boolean
  type?: keyof R4TypeOf
  default?: unknown
} & (
  | { as?: 'Date' | ((value: unknown) => unknown); choices?: never; pick?: never; enum?: never }
  | { choices: Readonly<Record<string, unknown>>; as?: never; pick?: never; enum?: never }
  | { choices: readonly { code: string }[]; pick?: string; as?: never; enum?: never }
  | { enum: readonly string[]; as?: never; choices?: never; pick?: never }
)

export type ProjectionColumns = Record<string, ProjectionColumn>

/** Add the environment bindings available while every projection column runs. */
export type ProjectionTypeContext<Context extends object> = MergeFhirpathTypeContexts<
  Context,
  {
    env: {
      rowIndex: { type: 'System.Integer' }
      rowTotal: { type: 'System.Integer' }
    }
  }
>

type ColumnPath<Column> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

/** Infers the values after the selected conversion, or from the path when no conversion is set. */
type ColumnValues<Column, Root extends string, Context extends object> = Column extends {
  as: (value: never) => infer R
}
  ? R[]
  : Column extends { as: 'Date' }
    ? Date[]
    : Column extends { choices: readonly (infer Row extends { code: string })[] }
      ? Column extends { pick: infer Key extends keyof Row }
        ? Row[Key][]
        : Row[]
      : Column extends { choices: infer M extends Readonly<Record<string, unknown>> }
        ? M[keyof M][]
        : Column extends { enum: readonly (infer V extends string)[] }
          ? V[]
          : Column extends { type: infer T extends keyof R4TypeOf }
            ? R4TypeOf[T][]
            : FhirpathResultForContext<ColumnPath<Column>, Root, Context>

/** A column's output type. A default replaces `undefined`; a collection returns every value. */
export type ColumnResult<
  Column extends string | { path: string } | { test: string },
  Root extends string = 'opaque',
  Context extends object = EmptyFhirpathTypeContext,
> = Column extends {
  test: string
}
  ? boolean
  : Column extends { collection: true }
    ? ColumnValues<Column, Root, Context>
    : Column extends { default: infer D }
      ? ColumnValues<Column, Root, Context>[number] | D
      : ColumnValues<Column, Root, Context>[number] | undefined

/** The row shape `project()` produces: each column's type inferred from its expression. */
export type Projection<
  Columns extends ProjectionColumns,
  Root extends string = 'opaque',
  Context extends object = EmptyFhirpathTypeContext,
> = {
  -readonly [K in keyof Columns]: ColumnResult<Columns[K], Root, Context>
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

/** The string key `choices` looks up: primitives via String(), anything else never matches. */
function mapKey(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined
}

/** The `choices` lookup over a plain Record: own keys only; a miss becomes empty. */
function recordLookup(choices: Readonly<Record<string, unknown>>): (values: unknown[]) => unknown[] {
  return values =>
    values.flatMap(value => {
      const key = mapKey(value)
      return key !== undefined && Object.hasOwn(choices, key) ? [choices[key]] : []
    })
}

/** Looks up display rows by `code`. The first row wins; a missing row or field returns empty. */
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

/** The table form of `choices`; Array.isArray alone cannot exclude the Record form for the checker. */
function isTable(
  choices: Readonly<Record<string, unknown>> | readonly { code: string }[]
): choices is readonly { code: string }[] {
  return Array.isArray(choices)
}

/** Resolve a column's `as`/`choices`/`enum` option into its values mapping. */
function coercion(spec: Extract<ProjectionColumn, { path: string }>): (values: unknown[]) => unknown[] {
  if (spec.choices !== undefined) {
    return isTable(spec.choices) ? tableLookup(spec.choices, spec.pick) : recordLookup(spec.choices)
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

/** Checks conversion options for JavaScript callers and transpile-only code. */
function assertShaperOptions(name: string, spec: Extract<ProjectionColumn, { path: string }>): void {
  const shapers = [spec.as, spec.choices, spec.enum].filter(option => option !== undefined).length
  if (shapers > 1) {
    throw new FhirPathRuntimeError(
      `project(): column '${name}' declares more than one of 'as', 'choices', 'enum'; use one`
    )
  }
  if (spec.pick !== undefined && !Array.isArray(spec.choices)) {
    throw new FhirPathRuntimeError(
      `project(): column '${name}' has 'pick' without a table 'choices' (an array of { code, … } rows)`
    )
  }
  if (spec.pick !== undefined && Array.isArray(spec.choices) && spec.choices.length > 0) {
    const pick = spec.pick
    // A field no row carries is a typo, not a sparse table — fail at plan time.
    if (!spec.choices.some(row => Object.hasOwn(row as object, pick))) {
      throw new FhirPathRuntimeError(`project(): column '${name}' picks '${pick}', which no row of its table has`)
    }
  }
}

/**
 * A column resolved against one compiler, ready to run once per row-context.
 * Each read forks the context's variables, so one column's defineVariable()
 * never leaks into the next. `at` locates the row for an error message.
 */
type ColumnReader = (root: TypedValue[], context: EvaluationContext, at: RowPosition) => unknown

/** Where a row sits in the batch, for the errors that need to point at one of many. */
interface RowPosition {
  index: number
  total: number
}

/**
 * Which row an error came from, when there is more than one to choose between.
 * A single-resource projection has no position worth reporting, so it says
 * nothing rather than "row 0".
 */
function inRow({ index, total }: RowPosition): string {
  return total > 1 ? ` in row ${index}` : ''
}

/** Take the column union apart once, at plan time; rows only run the result. */
function planColumn(name: string, column: ProjectionColumn, compile: Compiler): ColumnReader {
  if (typeof column !== 'string' && 'test' in column) {
    const criteria = compile(column.test)
    return (root, context) => criteriaBoolean(evaluateNode(criteria.ast, forkVariables(context), root))
  }
  const spec: Extract<ProjectionColumn, { path: string }> = typeof column === 'string' ? { path: column } : column
  assertShaperOptions(name, spec)
  const expression = compile(spec.path)
  const applyAs = coercion(spec)
  const empty = 'default' in spec ? spec.default : undefined
  return (root, context, at) => {
    const values = evaluateNode(expression.ast, forkVariables(context), root).map(unwrap)
    if (spec.collection === true) {
      return applyAs(values)
    }
    // The scalar-column rule counts the expression's values, before any `as`
    // coercion or `choices` miss drops them. One row of a batch can be the only
    // one that breaks it, so the message says which — `%rowIndex` numbering,
    // the same the columns see.
    if (values.length > 1) {
      throw new FhirPathRuntimeError(
        `project(): column '${name}' yielded ${values.length} values${inRow(at)}; append first() or set collection: true`
      )
    }
    const coerced = applyAs(values)
    return coerced.length > 0 ? coerced[0] : empty
  }
}

/**
 * Projects one row per input subject. Each row gets one shared context, so
 * variables bind once and every column reads the same values. Runtime
 * `%rowIndex` and `%rowTotal` replace matching environment entries.
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
    const at: RowPosition = { index, total: subjects.length }
    const context = makeContext(root, { rowIndex: index, rowTotal: subjects.length })
    const row: Record<string, unknown> = {}
    for (const [name, read] of readers) {
      row[name] = read(root, context, at)
    }
    return row
  })
}
