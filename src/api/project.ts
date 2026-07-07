import { FhirPathRuntimeError } from '../errors.ts'
import type { FhirpathResult } from '../typed/infer.ts'
import { cachedCompile, type EvaluateOptions } from './compile.ts'

/** One column of a `project()` call: an expression, or `{ path, collection: true }` to keep all values. */
export type ProjectionColumn = string | { path: string; collection?: boolean }

export type ProjectionColumns = Record<string, ProjectionColumn>

type ColumnPath<Column extends ProjectionColumn> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

type ColumnResult<Column extends ProjectionColumn> = Column extends { collection: true }
  ? FhirpathResult<ColumnPath<Column>>
  : FhirpathResult<ColumnPath<Column>>[number] | undefined

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
