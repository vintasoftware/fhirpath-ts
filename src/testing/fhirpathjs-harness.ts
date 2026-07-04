import { readFileSync } from 'node:fs'
import { QUIRK_FAMILIES, type QuirkFamily, SKIPPED_MODELS } from '../../test-data/fhirpathjs/quirk-manifest.ts'
import { compile } from '../api/compile.ts'
import { evaluate } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { compareTemporal } from '../values/temporal-compare.ts'
import { type QuantityValue, SYSTEM_QUANTITY, type TypedValue } from '../values/typed-value.ts'
import { testDataPath } from './test-data.ts'

/** One flattened YAML test from the fhirpath.js / fhirpath-py corpora. */
export interface CorpusTest {
  desc?: string
  expression: string | string[] | object
  result?: unknown[]
  /** Some YAML rows write `error: [true]` as a list. */
  error?: boolean | boolean[]
  inputfile?: string
  model?: string
  context?: string
  variables?: Record<string, unknown>
  disable?: boolean
  inheritedDisable?: boolean
  groupPath?: string[]
}

export interface CorpusFile {
  subject: unknown
  tests: CorpusTest[]
}

export function loadCorpus(name: 'cases' | 'cases-py-extras'): Record<string, CorpusFile> {
  return JSON.parse(readFileSync(testDataPath(`fhirpathjs/${name}.json`), 'utf8')) as Record<string, CorpusFile>
}

const resourceCache = new Map<string, unknown>()

function loadResource(name: string): unknown {
  if (!resourceCache.has(name)) {
    resourceCache.set(name, JSON.parse(readFileSync(testDataPath(`fhirpathjs/resources/${name}`), 'utf8')))
  }
  return structuredClone(resourceCache.get(name))
}

/** Why a case is skipped, or undefined when it should run. */
export function skipReason(test: CorpusTest, expression: string, file: string): string | undefined {
  if (test.disable === true || test.inheritedDisable === true) {
    return 'disabled upstream'
  }
  if (typeof test.expression === 'object' && !Array.isArray(test.expression)) {
    return 'non-string expression (fhirpath.js internal AST form)'
  }
  if (test.model !== undefined && test.model !== 'r4') {
    return SKIPPED_MODELS[test.model] ?? `unknown model ${test.model}`
  }
  const quirk = matchQuirk(file, expression)
  return quirk === undefined ? undefined : `intentional divergence: ${quirk.name}`
}

const QUIRK_INDEX = new Map<string, QuirkFamily>()
for (const family of QUIRK_FAMILIES) {
  for (const key of family.keys) {
    QUIRK_INDEX.set(key, family)
  }
}

export function matchQuirk(file: string, expression: string): QuirkFamily | undefined {
  return QUIRK_INDEX.get(`${file}||${expression}`)
}

/** Run one corpus case; returns a failure description or undefined on success. */
export function runCorpusTest(file: CorpusFile, test: CorpusTest, expression: string): string | undefined {
  const input = test.inputfile !== undefined ? loadResource(test.inputfile) : structuredClone(file.subject)
  const env: { context?: unknown } & Record<string, unknown> = { ...test.variables }
  try {
    if (test.context !== undefined) {
      env.context = evaluate(test.context, input, { model: r4Model, env })[0]
    }
    const options = test.model === 'r4' ? { model: r4Model, env } : { env }
    const rendered = compile(expression)
      .evaluateTyped(input, options)
      .map(item => render(item))
    if (expectsError(test)) {
      return `expected an error, got ${JSON.stringify(rendered)}`
    }
    if (!matches(rendered, test.result ?? [])) {
      return `got ${JSON.stringify(rendered)}, want ${JSON.stringify(test.result)}`
    }
    return undefined
  } catch (error) {
    if (expectsError(test)) {
      return undefined
    }
    return `threw ${error instanceof Error ? error.message : String(error)}`
  }
}

function expectsError(test: CorpusTest): boolean {
  return test.error === true || (Array.isArray(test.error) && test.error[0] === true)
}

/** Render results the way fhirpath.js JSON-serializes its own. */
function render(typed: TypedValue): unknown {
  const value = typed.value
  if (value instanceof Decimal) {
    return value.toNumber()
  }
  if (typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Temporal) {
    return value.toString()
  }
  if (typed.type === SYSTEM_QUANTITY) {
    const quantity = value as QuantityValue
    return quantity.calendar
      ? `${quantity.value.toString()} ${quantity.unit}`
      : `${quantity.value.toString()} '${quantity.unit}'`
  }
  return value
}

function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') {
    // fhirpath.js works in floats; tolerate representation noise.
    return Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected))
  }
  if (actual === expected) {
    return true
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    return temporalEquivalent(actual, expected)
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.length === actual.length && expected.every((item, index) => matches(actual[index], item))
  }
  if (typeof expected === 'object' && expected !== null && typeof actual === 'object' && actual !== null) {
    const expectedKeys = Object.keys(expected)
    const actualKeys = Object.keys(actual)
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every(key =>
        matches((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key])
      )
    )
  }
  return false
}

/** Datetime strings compare by instant, so timezone spellings do not matter. */
function temporalEquivalent(actual: string, expected: string): boolean {
  const left = Temporal.parseDateTime(actual) ?? Temporal.parseTime(actual)
  const right = Temporal.parseDateTime(expected) ?? Temporal.parseTime(expected)
  if (!(left && right) || left.kind !== right.kind) {
    return false
  }
  return compareTemporal(left, right) === 0
}
