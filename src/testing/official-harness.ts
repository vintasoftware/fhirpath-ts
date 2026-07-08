import { readFileSync } from 'node:fs'

import { SKIP_MANIFEST, type SkipEntry } from '../../test-data/official/skip-manifest.ts'
import { CompiledExpression } from '../api/compile.ts'
import { FhirPathError } from '../errors.ts'
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

export function findSkipReason(suite: SuiteName, group: OfficialGroup, test: OfficialTest): string | undefined {
  return SKIP_MANIFEST.find(entry => skipMatches(entry, suite, group, test))?.reason
}

function skipMatches(entry: SkipEntry, suite: SuiteName, group: OfficialGroup, test: OfficialTest): boolean {
  return (
    entry.suite === suite &&
    (entry.group === undefined || entry.group === group.name) &&
    (entry.test === undefined || entry.test === test.name) &&
    (entry.mode === undefined || entry.mode === test.mode)
  )
}

/** True when some suite case matches the entry — the hygiene test uses this. */
export function skipEntryMatchesSomething(entry: SkipEntry, suites: Record<SuiteName, OfficialGroup[]>): boolean {
  return suites[entry.suite].some(group => group.tests.some(test => skipMatches(entry, entry.suite, group, test)))
}

/** Run one official case; returns undefined on pass, a failure message otherwise. */
export function runOfficialTest(suite: SuiteName, test: OfficialTest): string | undefined {
  const input = test.inputfile === undefined ? undefined : loadFixture(suite, test.inputfile)
  if (test.invalid !== undefined) {
    try {
      const compiled = new CompiledExpression(test.expression)
      compiled.evaluateTyped(input, { model: r4Model })
      return `expected an error (invalid="${test.invalid}") but evaluation succeeded`
    } catch (error) {
      // The suite's syntax/semantic/execution split is looser than ours; any engine error passes.
      return error instanceof FhirPathError ? undefined : `unexpected error kind: ${String(error)}`
    }
  }
  let results: TypedValue[]
  try {
    results = new CompiledExpression(test.expression).evaluateTyped(input, { model: r4Model })
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
