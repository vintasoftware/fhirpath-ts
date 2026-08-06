import { type DtoClass, dtoDefinition } from '../api/dto.ts'
import type { ProjectionColumn } from '../api/project.ts'
import {
  analyzeExpressionDetailed,
  type AnalyzeOptions,
  type AnalyzerDiagnostic,
  type DeclaredVariable,
} from './analyze.ts'
import { valueKindOfTypeName } from './signatures.ts'

/** One `analyzeDto` finding: an analyzer diagnostic plus the class member it came from. */
export interface DtoDiagnostic extends AnalyzerDiagnostic {
  /** The column field name, or `vars.<name>` for a DTO var. */
  member: string
}

/**
 * Statically checks every expression a DTO declares — `@column` paths,
 * `@criteria` expressions, and its `vars` — the check TypeScript cannot do,
 * since it never looks inside the expression strings. Meant for CI: assert
 * `analyzeDto(Dto, options)` is empty next to the class.
 *
 * A column that declares its `type` (or `enum`) is cross-checked against what
 * the analyzer infers the expression yields, which covers the whole language —
 * so an out-of-subset expression, where the field's declared type is all
 * TypeScript has to go on, is still checked here.
 *
 * The DTO's `fhirType` becomes the analyzer's input type (overridable via
 * `options.inputType`). Its `env` names and `%rowIndex`/`%rowTotal` come
 * pre-declared; its `vars` analyze in declaration order, each seeing the
 * earlier ones, and every column sees them all. Anything the DTO does not
 * itself declare travels through `options`: the engine's functions
 * (`functions: engine.defaults.functions`), engine env and per-call env names
 * (`variables`). A pre-bound `TypedValue[]` var has no expression to analyze
 * and is only declared.
 */
export function analyzeDto(dto: DtoClass, options?: AnalyzeOptions): DtoDiagnostic[] {
  const definition = dtoDefinition(dto)
  const inputType = options?.inputType ?? definition.fhirType
  const declared: Record<string, DeclaredVariable> = {
    rowIndex: { types: ['System.Integer'], single: true },
    rowTotal: { types: ['System.Integer'], single: true },
  }
  for (const name of Object.keys(definition.env ?? {})) {
    declared[bare(name)] = {}
  }
  const diagnostics: DtoDiagnostic[] = []
  const analyze = (member: string, expression: string, column?: ProjectionColumn): void => {
    const merged: AnalyzeOptions = {
      ...options,
      ...(inputType !== undefined && { inputType }),
      variables: { ...declared, ...options?.variables },
    }
    const { diagnostics: found, result } = analyzeExpressionDetailed(expression, merged)
    for (const diagnostic of found) {
      diagnostics.push({ member, ...diagnostic })
    }
    const mismatch = column === undefined ? undefined : declaredTypeMismatch(column, result.types, options)
    if (mismatch !== undefined) {
      // The whole expression is the finding's span: the declaration it
      // contradicts lives outside the expression text.
      diagnostics.push({
        member,
        severity: 'error',
        code: 'column-type',
        message: mismatch,
        span: { start: 0, end: expression.length, line: 1, column: 1 },
      })
    }
  }
  for (const [name, value] of Object.entries(definition.vars ?? {})) {
    const source = typeof value === 'string' ? value : sourceOf(value)
    if (source !== undefined) {
      analyze(`vars.${bare(name)}`, source)
    }
    declared[bare(name)] = {}
  }
  for (const [name, spec] of Object.entries(definition.columns)) {
    if (typeof spec !== 'string' && 'test' in spec) {
      analyze(name, spec.test)
      continue
    }
    analyze(name, typeof spec === 'string' ? spec : spec.path, spec)
  }
  return diagnostics
}

/**
 * The type a column claims its expression yields: `type` when it declares one,
 * plain String for an `enum` (the codes are strings before the union narrows
 * them). A column whose `as`/`choices` reshapes values outside FHIRPath claims
 * nothing about the expression, so there is nothing to compare.
 */
function claimedType(column: ProjectionColumn): string | undefined {
  if (typeof column === 'string' || 'test' in column || column.as !== undefined || column.choices !== undefined) {
    return undefined
  }
  return column.type ?? (column.enum !== undefined ? 'System.String' : undefined)
}

/**
 * A declared column `type` that cannot describe what the expression yields.
 * Compared by value kind (Boolean/String/Numeric/Temporal/Quantity/Complex),
 * the same families the analyzer's own operand checks use, so an equivalent
 * spelling — `code` for a String, `System.Decimal` for a `decimal` — is never a
 * finding. Complex types compare by name through the model's hierarchy instead,
 * since every complex type shares one kind. An unknown region (`types:
 * undefined`) claims nothing and is left alone.
 */
function declaredTypeMismatch(
  column: ProjectionColumn,
  yielded: string[] | undefined,
  options: AnalyzeOptions | undefined
): string | undefined {
  const claimed = claimedType(column)
  if (claimed === undefined || yielded === undefined || yielded.length === 0) {
    return undefined
  }
  const canonical = options?.model?.resolveType(claimed) ?? claimed
  const claimedKind = valueKindOfTypeName(canonical)
  const fits = yielded.some(type => {
    if (valueKindOfTypeName(type) !== claimedKind) {
      return false
    }
    if (claimedKind !== 'Complex') {
      return true
    }
    const model = options?.model
    /* v8 ignore next -- without a model the analyzer never reaches a complex FHIR type, so the model-less half cannot be exercised */
    return model === undefined || model.isSubtypeOf(type, canonical) || model.isSubtypeOf(canonical, type)
  })
  return fits ? undefined : `Column declares type '${claimed}', but the expression yields ${yielded.join(' | ')}`
}

const bare = (name: string): string => (name.startsWith('%') ? name.slice(1) : name)

/** A pre-compiled var's source text; a pre-bound TypedValue[] has nothing to analyze. */
function sourceOf(value: object): string | undefined {
  if (Array.isArray(value)) {
    return undefined
  }
  const source = (value as { source?: unknown }).source
  return typeof source === 'string' ? source : undefined
}
