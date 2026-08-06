import { type DtoClass, dtoDefinition } from '../api/dto.ts'
import { analyzeExpression, type AnalyzeOptions, type AnalyzerDiagnostic, type DeclaredVariable } from './analyze.ts'

/** One `analyzeDto` finding: an analyzer diagnostic plus the class member it came from. */
export interface DtoDiagnostic extends AnalyzerDiagnostic {
  /** The column field name, or `vars.<name>` for a class var. */
  member: string
}

/**
 * Statically checks every expression a DTO declares — column paths, `test`
 * criteria, and its `vars` — the check TypeScript cannot do, since it never
 * looks inside the expression strings. Meant for CI: assert
 * `analyzeDto(Dto, options)` is empty next to the definition.
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
  const analyze = (member: string, expression: string): void => {
    const merged: AnalyzeOptions = {
      ...options,
      ...(inputType !== undefined && { inputType }),
      variables: { ...declared, ...options?.variables },
    }
    for (const diagnostic of analyzeExpression(expression, merged)) {
      diagnostics.push({ member, ...diagnostic })
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
    analyze(name, typeof spec === 'string' ? spec : 'test' in spec ? spec.test : spec.path)
  }
  return diagnostics
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
