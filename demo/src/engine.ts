import { Decimal, FhirPathError, type QuantityValue, Temporal } from 'fhirpath-ts'
import { type AnalyzerDiagnostic, analyzeExpression } from 'fhirpath-ts/analyzer'
import { r4, r4Model } from 'fhirpath-ts/r4'

export interface ResultItem {
  /** Local type name the engine assigned this value, e.g. String, Quantity, HumanName. */
  type: string
  text: string
}

export interface RunOutcome {
  diagnostics: AnalyzerDiagnostic[]
  results: ResultItem[] | null
  /** Set when the expression parses but throws while running (e.g. choice-key misuse). */
  runtimeError: string | null
}

/** Statically analyze, then evaluate — the two things this engine does that others defer to runtime. */
export function run(expr: string, inputType: string, resource: unknown): RunOutcome {
  const diagnostics = analyzeExpression(expr, { model: r4Model, inputType })

  let results: ResultItem[] | null = null
  let runtimeError: string | null = null
  try {
    const typed = r4.evaluateTyped(expr, resource)
    results = typed.map(tv => ({ type: localType(tv.type), text: format(tv.value) }))
  } catch (error) {
    runtimeError = error instanceof FhirPathError ? error.message : String(error)
  }

  return { diagnostics, results, runtimeError }
}

function localType(type: string): string {
  const dot = type.lastIndexOf('.')
  return dot === -1 ? type : type.slice(dot + 1)
}

function format(value: unknown): string {
  if (value instanceof Decimal) {
    return value.toString()
  }
  if (value instanceof Temporal) {
    return value.toString()
  }
  if (isQuantity(value)) {
    return `${value.value.toString()} ${value.unit ?? ''}`.trim()
  }
  if (typeof value === 'string') {
    return `'${value}'`
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function isQuantity(value: unknown): value is QuantityValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    (value as { value: unknown }).value instanceof Decimal
  )
}
