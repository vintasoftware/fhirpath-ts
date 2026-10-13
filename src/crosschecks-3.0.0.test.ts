import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { analyzeExpressionDetailed } from './analyzer/index.ts'
import { evaluate } from './api/evaluate.ts'
import { FhirPathError, FhirPathSyntaxError } from './errors.ts'
import { r4Model } from './r4/index.ts'
import { testDataPath } from './testing/test-data.ts'
import { typeLocalName } from './values/typed-value.ts'

/**
 * FHIRPath 3.0.0 cases from other engines' test suites, for the functions and
 * syntax 3.0.0 added. See test-data/crosschecks/README.md for provenance.
 */

interface CrosscheckCase {
  source: string
  file: string
  test?: string
  expression: string
  /** A key of `inputs`. */
  input?: string
  /** A file under test-data. */
  fixture?: string
  model?: 'r4'
  env?: Record<string, unknown>
  values?: unknown[]
  contains?: Record<string, unknown>[]
  count?: number
  error?: keyof typeof ERRORS
  analyzer?: { inputType: string; valid: boolean; types?: string[] }
}

interface Crosschecks {
  sources: Record<string, { commit: string; license: string }>
  inputs: Record<string, unknown>
  cases: CrosscheckCase[]
}

const ERRORS = { FhirPathError, FhirPathSyntaxError }

const dataPath = testDataPath('crosschecks/fhirpath-3.0.0.json')
const data = JSON.parse(readFileSync(dataPath, 'utf8')) as Crosschecks

function inputOf(test: CrosscheckCase): unknown {
  if (test.fixture !== undefined) {
    return JSON.parse(readFileSync(testDataPath(test.fixture), 'utf8'))
  }
  return test.input === undefined ? undefined : structuredClone(data.inputs[test.input])
}

function run(test: CrosscheckCase): void {
  if (test.analyzer !== undefined) {
    const { diagnostics, result } = analyzeExpressionDetailed(test.expression, {
      model: r4Model,
      inputType: test.analyzer.inputType,
    })
    expect(diagnostics.every(diagnostic => diagnostic.severity !== 'error')).toBe(test.analyzer.valid)
    expect((result.types ?? []).map(typeLocalName)).toEqual(expect.arrayContaining(test.analyzer.types ?? []))
    return
  }
  const options = { ...(test.model === 'r4' && { model: r4Model }), ...(test.env && { env: test.env }) }
  const evaluateCase = (): unknown[] => evaluate(test.expression, inputOf(test), options)
  if (test.error !== undefined) {
    expect(evaluateCase).toThrow(ERRORS[test.error])
  } else if (test.contains !== undefined) {
    expect(evaluateCase()).toMatchObject(test.contains)
  } else if (test.count !== undefined) {
    expect(evaluateCase()).toHaveLength(test.count)
  } else {
    expect(evaluateCase()).toEqual(test.values)
  }
}

for (const [source, { commit }] of Object.entries(data.sources)) {
  describe(`${source} ${commit.slice(0, 7)}`, () => {
    const tests = data.cases.filter(test => test.source === source)
    const repeated = new Set(
      tests.map(test => test.expression).filter((expression, i, all) => all.indexOf(expression) !== i)
    )
    for (const test of tests) {
      const title = repeated.has(test.expression)
        ? `${test.expression} on ${test.input ?? 'no input'}`
        : test.expression
      it(title, () => run(test))
    }
  })
}

describe('cross-check data', () => {
  it('names a known source, input, and fixture in every case', () => {
    for (const test of data.cases) {
      expect(data.sources, test.expression).toHaveProperty([test.source])
      if (test.input !== undefined) {
        expect(data.inputs, test.expression).toHaveProperty([test.input])
      }
      if (test.fixture !== undefined) {
        expect(() => testDataPath(test.fixture as string), test.expression).not.toThrow()
      }
    }
  })

  it('uses every input and ships every license file', () => {
    const used = new Set(data.cases.map(test => test.input))
    expect(Object.keys(data.inputs).filter(name => !used.has(name))).toEqual([])
    for (const { license } of Object.values(data.sources)) {
      expect(existsSync(join(dirname(dataPath), license)), license).toBe(true)
    }
  })
})
