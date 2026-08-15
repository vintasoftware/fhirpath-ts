import { readFileSync } from 'node:fs'

import {
  PHASE_OVERRIDES,
  type PhaseName,
  SKIP_MANIFEST,
  type SkipEntry,
} from '../../test-data/official/skip-manifest.ts'
import { CompiledExpression } from '../api/compile.ts'
import { FhirPathError, FhirPathRuntimeError, FhirPathSyntaxError, FhirPathTypeError } from '../errors.ts'
import { valueToString } from '../functions/conversion.ts'
import { r4Model } from '../r4/index.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_BOOLEAN, SYSTEM_INTEGER, SYSTEM_LONG, systemTypeOf, type TypedValue } from '../values/typed-value.ts'
import { testDataPath } from './test-data.ts'

export interface OfficialOutput {
  type: string
  value: string
}

export interface OfficialTest {
  name: string
  inputfile?: string
  expression: string
  invalid?: string
  predicate?: boolean
  mode?: string
  /** Suite marker: valid to evaluate but not statically checkable; the analyzer conformance test skips it. */
  skipStaticCheck?: boolean
  outputs: OfficialOutput[]
}

export interface OfficialGroup {
  name: string
  description?: string
  tests: OfficialTest[]
}

export type SuiteName = 'r4' | 'r5'

export function loadOfficialSuite(suite: SuiteName): OfficialGroup[] {
  return JSON.parse(readFileSync(testDataPath(`official/${suite}/tests.json`), 'utf8')) as OfficialGroup[]
}

const fixtureCache = new Map<string, unknown>()

function loadFixture(suite: SuiteName, inputfile: string): unknown {
  const key = `${suite}/${inputfile}`
  if (!fixtureCache.has(key)) {
    const jsonName = inputfile.replace(/\.xml$/, '.json')
    const content = readFileSync(testDataPath(`official/${suite}/fixtures/${jsonName}`), 'utf8')
    fixtureCache.set(key, JSON.parse(content))
  }
  return fixtureCache.get(key)
}

export function findSkipReason(
  suite: SuiteName,
  group: OfficialGroup,
  test: OfficialTest,
  manifest: SkipEntry[] = SKIP_MANIFEST
): string | undefined {
  return manifest.find(entry => skipMatches(entry, suite, group, test))?.reason
}

/** The fixture's resourceType, for seeding the analyzer's input type. */
export function fixtureResourceType(suite: SuiteName, inputfile: string): string | undefined {
  const fixture = loadFixture(suite, inputfile)
  const resourceType = (fixture as { resourceType?: unknown }).resourceType
  return typeof resourceType === 'string' ? resourceType : undefined
}

function skipMatches(entry: SkipEntry, suite: SuiteName, group: OfficialGroup, test: OfficialTest): boolean {
  return (
    entry.suite === suite &&
    (entry.group === undefined || entry.group === group.name) &&
    (entry.test === undefined || entry.test === test.name) &&
    (entry.mode === undefined || entry.mode === test.mode)
  )
}

/** Every suite case a manifest entry matches — the hygiene tests derive existence and per-case checks from this. */
export function casesMatching(
  entry: SkipEntry,
  suites: Record<SuiteName, OfficialGroup[]>
): { group: OfficialGroup; test: OfficialTest }[] {
  const matches: { group: OfficialGroup; test: OfficialTest }[] = []
  for (const group of suites[entry.suite]) {
    for (const test of group.tests) {
      if (skipMatches(entry, entry.suite, group, test)) {
        matches.push({ group, test })
      }
    }
  }
  return matches
}

/**
 * The error classes an `invalid` phase tag admits. `semantic` maps to the type
 * error our dynamic evaluator raises where a checker would have; `execution`
 * admits type errors too because some argument checks only happen once values
 * flow (e.g. a non-String subject reaching startsWith()).
 */
const PHASE_ERROR_CLASSES: Record<PhaseName, (error: FhirPathError) => boolean> = {
  syntax: error => error instanceof FhirPathSyntaxError,
  semantic: error => error instanceof FhirPathTypeError,
  execution: error => error instanceof FhirPathRuntimeError || error instanceof FhirPathTypeError,
}

function expectedPhase(suite: SuiteName, groupName: string, test: OfficialTest): PhaseName | undefined {
  const override = PHASE_OVERRIDES.find(
    entry => entry.suite === suite && entry.group === groupName && entry.test === test.name
  )
  if (override !== undefined) {
    return override.throws
  }
  return test.invalid !== undefined && test.invalid in PHASE_ERROR_CLASSES ? (test.invalid as PhaseName) : undefined
}

/** Run one official case; returns undefined on pass, a failure message otherwise. */
export function runOfficialTest(suite: SuiteName, test: OfficialTest, groupName = ''): string | undefined {
  const input = test.inputfile === undefined ? undefined : loadFixture(suite, test.inputfile)
  const options = {
    model: r4Model,
    ...((test.invalid === 'semantic' || test.mode === 'strict') && { strict: true }),
  }
  if (test.invalid !== undefined) {
    const phase = expectedPhase(suite, groupName, test)
    try {
      const compiled = new CompiledExpression(test.expression)
      compiled.evaluateTyped(input, options)
      return `expected an error (invalid="${test.invalid}") but evaluation succeeded`
    } catch (error) {
      if (!(error instanceof FhirPathError)) {
        return `unexpected error kind: ${String(error)}`
      }
      // The suite's phase tag pins the error class; PHASE_OVERRIDES documents divergences.
      if (phase !== undefined && !PHASE_ERROR_CLASSES[phase](error)) {
        return `expected a ${phase}-phase error (invalid="${test.invalid}"), got ${error.name}: ${error.message}`
      }
      return undefined
    }
  }
  let results: TypedValue[]
  try {
    results = new CompiledExpression(test.expression).evaluateTyped(input, options)
  } catch (error) {
    return `evaluation failed: ${(error as Error).message}`
  }
  if (test.predicate) {
    results = [{ type: SYSTEM_BOOLEAN, value: results.length > 0 }]
  }
  if (results.length !== test.outputs.length) {
    return `expected ${test.outputs.length} results, got ${results.length}: ${render(results)}`
  }
  for (let i = 0; i < results.length; i++) {
    const failure = compareOutput(results[i] as TypedValue, test.outputs[i] as OfficialOutput)
    if (failure !== undefined) {
      return `result ${i}: ${failure}`
    }
  }
  return undefined
}

function compareOutput(result: TypedValue, output: OfficialOutput): string | undefined {
  // Temporal outputs use literal form (@2014-01-01); compare the literal rendering.
  if (output.value.startsWith('@') && result.value instanceof Temporal) {
    return result.value.toLiteralString() === output.value
      ? undefined
      : `expected ${output.value}, got ${result.value.toLiteralString()}`
  }
  switch (output.type) {
    case 'boolean': {
      const expected = output.value === 'true'
      return systemTypeOf(result) === SYSTEM_BOOLEAN && result.value === expected
        ? undefined
        : `expected ${output.value}, got ${render([result])}`
    }
    case 'integer': {
      const matches =
        (systemTypeOf(result) === SYSTEM_INTEGER && result.value === Number(output.value)) ||
        (systemTypeOf(result) === SYSTEM_LONG && result.value === BigInt(output.value))
      return matches ? undefined : `expected integer ${output.value}, got ${render([result])}`
    }
    case 'decimal':
    case '': {
      const expected = Decimal.fromString(output.value)
      if (!expected) {
        // Untyped outputs (older R4 rows) may not be decimals at all.
        const text = valueToString(result)
        return text === output.value ? undefined : `expected "${output.value}", got "${text ?? render([result])}"`
      }
      const actual =
        result.value instanceof Decimal
          ? result.value
          : typeof result.value === 'number'
            ? Decimal.fromNumber(result.value)
            : undefined
      return expected && actual?.equals(expected)
        ? undefined
        : `expected decimal ${output.value}, got ${render([result])}`
    }
    default: {
      const text = valueToString(result)
      return text === output.value
        ? undefined
        : `expected ${output.type} "${output.value}", got "${text ?? render([result])}"`
    }
  }
}

function render(results: TypedValue[]): string {
  return JSON.stringify(
    results.map(item => ({ type: item.type, value: valueToString(item) ?? item.value })),
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
  )
}
