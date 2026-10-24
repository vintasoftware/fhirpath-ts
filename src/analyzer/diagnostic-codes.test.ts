import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { r4, r4Model } from '../r4/index.ts'
import { analyzeExpression } from './analyze.ts'
import { ANALYZER_DIAGNOSTIC_CODES, DEFINITE_DIAGNOSTIC_CODES } from './diagnostic-codes.ts'

const patient = { resourceType: 'Patient', id: 'p' }
const named = { ...patient, name: [{ family: 'Doe' }] }

/** What evaluating `expression` gives: its values, or the class of the error it throws. */
function outcome(expression: string, input: unknown): unknown {
  try {
    return r4.evaluate(expression, input)
  } catch (error) {
    return (error as Error).constructor.name
  }
}

const codes = (expression: string, inputType = 'Patient') =>
  analyzeExpression(expression, { model: r4Model, inputType }).map(({ code }) => code)

describe('DEFINITE_DIAGNOSTIC_CODES', () => {
  // Each expression's marked part throws or is empty whatever the data: here, with and without a name.
  it.each([
    ['syntax', 'name.', 'Patient', [patient, named]],
    ['unknown-element', 'name.famly', 'Patient', [patient, named]],
    ['unknown-function', 'name.frist()', 'Patient', [patient, named]],
    ['unknown-variable', '%nope', 'Patient', [patient, named]],
    ['unknown-type', 'name.ofType(Foo)', 'Patient', [patient, named]],
    ['wrong-arity', 'name.first(1)', 'Patient', [patient, named]],
    ['variable-override', "name.defineVariable('context', 1)", 'Patient', [patient, named]],
    ['variable-redefined', "name.defineVariable('a', 1).defineVariable('a', 2)", 'Patient', [patient, named]],
    ['invalid-value', "Coding { code: 'a  b' }", 'Patient', [patient, named]],
    ['datatype-root', 'HumanName.family', 'HumanName', [{}, { family: 'Doe' }]],
  ] as const)('%s is wrong whatever the data: %s', (code, expression, inputType, inputs) => {
    expect(DEFINITE_DIAGNOSTIC_CODES.has(code)).toBe(true)
    expect(codes(expression, inputType)).toEqual([code])
    for (const input of inputs) {
      expect([[], 'FhirPathSyntaxError', 'FhirPathTypeError', 'FhirPathRuntimeError']).toContainEqual(
        outcome(expression, input)
      )
    }
  })

  it.each([
    ['singleton-required', 'name.family + 1', patient, [], { ...patient, name: [{ family: 'a' }, { family: 'b' }] }],
    ['operand-type', "name.family.first() + 1 'mg'", patient, [], named],
    ['invalid-argument', "name.family.first().matches('a', 'q')", patient, [], named],
    ['subtype-element', 'contained.name.family', { ...patient, contained: [named] }, ['Doe'], patient],
  ] as const)('%s depends on the data: %s', (code, expression, works, result, fails) => {
    expect(DEFINITE_DIAGNOSTIC_CODES.has(code)).toBe(false)
    expect(codes(expression)).toEqual([code])
    expect(outcome(expression, works)).toEqual(result)
    expect(outcome(expression, fails)).not.toEqual(result)
  })

  it('lists codes the analyzer reports', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url))
    const sources = readdirSync(directory)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'diagnostic-codes.ts')
      .map(file => readFileSync(`${directory}/${file}`, 'utf8'))
      .join('\n')
    for (const code of ANALYZER_DIAGNOSTIC_CODES) {
      expect(sources, code).toContain(`'${code}'`)
    }
    for (const code of DEFINITE_DIAGNOSTIC_CODES) {
      expect(ANALYZER_DIAGNOSTIC_CODES).toContain(code)
    }
  })
})
