import { FhirPathRuntimeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathResult } from '../typed/infer.ts'
import { cachedCompile, type EvaluateOptions } from './compile.ts'

/**
 * One column of a `project()` call: an expression, or an object form with
 * `collection: true` to keep all values and/or `type` to declare the column's
 * FHIR type (mirroring SQL-on-FHIR ViewDefinition `column.type`) when the
 * expression is outside the inference subset. A declared `type` is a
 * compile-time assertion only — it is not checked at runtime.
 */
export type ProjectionColumn = string | { path: string; collection?: boolean; type?: keyof R4TypeOf }

export type ProjectionColumns = Record<string, ProjectionColumn>

type ColumnPath<Column extends ProjectionColumn> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

/** A declared `type` wins; otherwise the type is inferred from the expression. */
type ColumnValues<Column extends ProjectionColumn> = Column extends { type: infer T extends keyof R4TypeOf }
  ? R4TypeOf[T][]
  : FhirpathResult<ColumnPath<Column>>

type ColumnResult<Column extends ProjectionColumn> = Column extends { collection: true }
  ? ColumnValues<Column>
  : ColumnValues<Column>[number] | undefined

/** The row shape `project()` produces: each column's type inferred from its expression. */
export type Projection<Columns extends ProjectionColumns> = {
  -readonly [K in keyof Columns]: ColumnResult<Columns[K]>
}

/** One row of `FhirPathEngine.project()`; options come pre-merged with the engine defaults. */
export function projectOne(
  input: unknown,
  columns: ProjectionColumns,
  options: EvaluateOptions
): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [name, column] of Object.entries(columns)) {
    const path = typeof column === 'string' ? column : column.path
    const collection = typeof column !== 'string' && column.collection === true
    const values = cachedCompile(path).evaluate(input, options)
    if (collection) {
      row[name] = values
    } else if (values.length > 1) {
      throw new FhirPathRuntimeError(
        `project(): column '${name}' yielded ${values.length} values; append first() or set collection: true`
      )
    } else {
      row[name] = values[0]
    }
  }
  return row
}
