import { readFileSync } from 'node:fs'

import {
  DEFERRED_FEATURES,
  MODEL_DIFFERENCES,
  OFFICIAL_SUITE_COPIES,
  QUIRK_FAMILIES,
  type QuirkFamily,
  SKIPPED_MODELS,
} from '../../test-data/fhirpathjs/quirk-manifest.ts'
import { SKIP_CATEGORY_LABELS, type SkipCategory } from '../../test-data/official/skip-manifest.ts'
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

/**
 * Why a corpus case is not run, by skip category: a case run with another
 * model, or a manifest family's case. `official-copy` marks a case of a file
 * `official.test.ts` runs instead; the corpus test leaves those files out, so
 * it never reports one as skipped.
 */
export type CaseSkip =
  | { kind: 'model'; reason: string }
  | { kind: SkipCategory; family: QuirkFamily; key: string }
  | { kind: 'official-copy'; reason: string }

export function isOfficialSuiteCopy(file: string): boolean {
  return OFFICIAL_SUITE_COPIES.includes(file)
}

export function classifyCase(test: CorpusTest, expression: string, file: string): CaseSkip | undefined {
  if ((test.disable === true || test.inheritedDisable === true) && isOfficialSuiteCopy(file)) {
    return { kind: 'official-copy', reason: 'disabled upstream; official.test.ts runs this official-suite case' }
  }
  if (test.model !== undefined && test.model !== 'r4') {
    return { kind: 'model', reason: SKIPPED_MODELS[test.model] ?? `unknown model ${test.model}` }
  }
  return matchQuirk(file, test, expression)
}

/** Why a case is skipped, or undefined when it should run. */
export function skipReason(test: CorpusTest, expression: string, file: string): string | undefined {
  const skip = classifyCase(test, expression, file)
  if (skip === undefined || skip.kind === 'official-copy') {
    return skip?.reason
  }
  return `${SKIP_CATEGORY_LABELS[skip.kind]}: ${'family' in skip ? skip.family.name : skip.reason}`
}

const FAMILY_INDEX = new Map<string, { kind: SkipCategory; family: QuirkFamily }>()
for (const [kind, families] of [
  ['model', MODEL_DIFFERENCES],
  ['quirk', QUIRK_FAMILIES],
  ['deferred', DEFERRED_FEATURES],
] as const) {
  for (const family of families) {
    for (const key of family.keys) {
      FAMILY_INDEX.set(key, { kind, family })
    }
  }
}

/** The manifest key forms that can name a case; see `QuirkFamily`. */
function caseKeys(file: string, test: CorpusTest, expression: string): string[] {
  const keys = [`${file}||${expression}`, `${file}@${test.model ?? 'none'}||${expression}`]
  if (test.desc !== undefined) {
    keys.push(`${file}#${test.desc}||${expression}`)
  }
  return keys
}

/** The manifest family (model difference, quirk, or deferred feature) whose key names this case. */
export function matchQuirk(
  file: string,
  test: CorpusTest,
  expression: string
): { kind: SkipCategory; family: QuirkFamily; key: string } | undefined {
  for (const key of caseKeys(file, test, expression)) {
    const entry = FAMILY_INDEX.get(key)
    if (entry !== undefined) {
      return { ...entry, key }
    }
  }
  return undefined
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
