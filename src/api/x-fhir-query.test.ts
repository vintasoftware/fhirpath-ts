// All data in this file is synthetic.
import { describe, expect, expectTypeOf, it } from 'vitest'

import { FhirPathError, FhirPathRuntimeError, FhirPathSyntaxError, FhirPathTypeError } from '../errors.ts'
import { r4, r4Model } from '../r4/index.ts'
import type { TerminologyProvider } from '../terminology/provider.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { CompiledXFhirQuery, compileXFhirQuery } from './x-fhir-query.ts'

const fhir = (type: string, value: unknown): TypedValue => ({ type: `FHIR.${type}`, value })

/** The query with its one embedded expression replaced by `results`. */
function substitute(query: string, results: readonly TypedValue[]): string {
  return compileXFhirQuery(query).substitute([results])
}

/** The message of what `run` throws. */
function thrown(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('Expected an error')
}

const patient = {
  resourceType: 'Patient' as const,
  id: 'p1',
  identifier: [{ system: 'http://example.org/mrn', value: 'mrn-1' }],
  name: [{ family: 'Example', given: ['Alex'] }],
}

describe('compileXFhirQuery', () => {
  it('compiles the expressions in double braces, in order', () => {
    const query = compileXFhirQuery('Observation?code={{ a.b }}&subject={{%patient.id}}&x=1')
    expect(query.expressions.map(expression => expression.source)).toStrictEqual([' a.b ', '%patient.id'])
    expect(query.source).toBe('Observation?code={{ a.b }}&subject={{%patient.id}}&x=1')
    expect(String(query)).toBe(query.source)
    expect(compileXFhirQuery('Patient?_count=1').expressions).toStrictEqual([])
    expect(new CompiledXFhirQuery('Patient?id={{id}}').expressions).toHaveLength(1)
  })

  it('reads no expression from nested or unpaired braces', () => {
    expect(compileXFhirQuery('Patient?a={{ {b} }}&c={d}&e={{}}').expressions).toStrictEqual([])
  })

  it('names the embedded expression that is not valid FHIRPath, and keeps its error as the cause', () => {
    const run = () => compileXFhirQuery('Patient?a={{id}}&b={{name.(}}')
    expect(run).toThrow(FhirPathSyntaxError)
    expect(thrown(run)).toBe(
      "Embedded expression 2 of the x-fhir-query is not valid FHIRPath: Expected an element or function name after '.', got '(' (line 1, column 6)"
    )
    try {
      run()
    } catch (error) {
      const cause = (error as FhirPathSyntaxError).cause as FhirPathSyntaxError
      expect(cause).toBeInstanceOf(FhirPathSyntaxError)
      expect(cause.message).toBe("Expected an element or function name after '.', got '(' (line 1, column 6)")
      expect((error as FhirPathSyntaxError).span).toBe(cause.span)
    }
  })

  it('passes on an error that is not a syntax error', () => {
    const failure = new Error('compiler failed')
    expect(
      () =>
        new CompiledXFhirQuery('Patient?id={{id}}', () => {
          throw failure
        })
    ).toThrow(failure)
  })
})

describe('CompiledXFhirQuery.substitute', () => {
  it.each<[string, TypedValue[], string]>([
    ['a string', r4.evaluateTyped("'abc'"), 'abc'],
    ['an integer', r4.evaluateTyped('5'), '5'],
    ['a long', r4.evaluateTyped('5L'), '5'],
    ['a decimal', r4.evaluateTyped('2.50'), '2.50'],
    ['a boolean', r4.evaluateTyped('false'), 'false'],
    ['true', r4.evaluateTyped('true'), 'true'],
    ['a date', r4.evaluateTyped('@2024-03-01'), '2024-03-01'],
    ['a FHIR code', [fhir('code', 'final')], 'final'],
    ['a FHIR primitive with no value, as nothing', [fhir('string', undefined)], ''],
    [
      'a Coding with a system',
      [fhir('Coding', { system: 'http://loinc.org', code: '8302-2' })],
      'http://loinc.org|8302-2',
    ],
    ['a Coding without a system', [fhir('Coding', { code: 'x' })], 'x'],
    ['a Coding without a code', [fhir('Coding', { system: 'http://example.org/a' })], 'http://example.org/a|'],
    [
      'an Identifier',
      [fhir('Identifier', { system: 'http://example.org/mrn', value: '42' })],
      'http://example.org/mrn|42',
    ],
    ['an Identifier without a system', [fhir('Identifier', { value: '42' })], '42'],
    [
      'a CodeableConcept, as its codings',
      [fhir('CodeableConcept', { coding: [{ system: 'http://example.org/a', code: '1' }, { code: '2' }] })],
      'http://example.org/a|1,2',
    ],
    ['a CodeableConcept without codings, as nothing', [fhir('CodeableConcept', { text: 'x' })], ''],
    ['a Reference', [fhir('Reference', { reference: 'Patient/p1' })], 'Patient/p1'],
    ['a Reference without a reference, as nothing', [fhir('Reference', { display: 'x' })], ''],
    [
      'a Quantity',
      [fhir('Quantity', { value: 5, system: 'http://unitsofmeasure.org', code: 'mg' })],
      '5|http://unitsofmeasure.org|mg',
    ],
    ['a Quantity with a unit and no code', [fhir('Quantity', { value: 5, unit: 'mg' })], '5||mg'],
    ['a Quantity without a value', [fhir('Quantity', { unit: 'mg' })], '||mg'],
    [
      'an Age',
      [fhir('Age', { value: 30, system: 'http://unitsofmeasure.org', code: 'a' })],
      '30|http://unitsofmeasure.org|a',
    ],
    ['a SimpleQuantity', [fhir('SimpleQuantity', { value: 1, code: 'mL' })], '1||mL'],
    ['a FHIRPath quantity', r4.evaluateTyped("5 'mg'"), '5|http://unitsofmeasure.org|mg'],
    ['a FHIRPath calendar duration, by its UCUM code', r4.evaluateTyped('3 years'), '3|http://unitsofmeasure.org|a'],
    ['several values, as a comma list', r4.evaluateTyped("'a' | 'b'"), 'a,b'],
    ['no value, as nothing', [], ''],
  ])('%s', (_name, results, expected) => {
    expect(substitute('Observation?x={{ e }}', results)).toBe(`Observation?x=${expected}`)
  })

  it('percent-encodes what would change the query, and keeps the characters of tokens and URLs', () => {
    expect(substitute('Patient?name={{ e }}', r4.evaluateTyped("'Ana & Bo #1'"))).toBe(
      'Patient?name=Ana%20%26%20Bo%20%231'
    )
    expect(substitute('Patient?name={{ e }}', r4.evaluateTyped("'a,b'"))).toBe('Patient?name=a%2Cb')
    expect(substitute('Observation?date={{ e }}', r4.evaluateTyped('@2024-03-01T10:00:00+02:00'))).toBe(
      'Observation?date=2024-03-01T10:00:00%2B02:00'
    )
    expect(substitute('Observation?code={{ e }}', [fhir('Coding', { system: 'http://loinc.org', code: 'a/b' })])).toBe(
      'Observation?code=http://loinc.org|a/b'
    )
  })

  it('puts each result list in the place of its expression', () => {
    const query = compileXFhirQuery('Observation?subject={{a}}&code={{b}}')
    expect(query.substitute([[fhir('string', 'Patient/p1')], r4.evaluateTyped("'x' | 'y'")])).toBe(
      'Observation?subject=Patient/p1&code=x,y'
    )
  })

  it('refuses a value with no search form by naming its type only', () => {
    const run = () => substitute('Patient?name={{ e }}', [fhir('HumanName', { family: 'Example', given: ['Alex'] })])
    expect(run).toThrow(FhirPathTypeError)
    expect(thrown(run)).toBe('A FHIR.HumanName value cannot be put in an x-fhir-query')
    expect(thrown(() => substitute('Patient?name={{ e }}', [{ type: 'Object', value: { a: 'secret' } }]))).toBe(
      'A Object value cannot be put in an x-fhir-query'
    )
  })

  it('refuses a result list for each expression of another length', () => {
    expect(thrown(() => compileXFhirQuery('Patient?a={{a}}&b={{b}}').substitute([[]]))).toBe(
      'The x-fhir-query has 2 embedded expressions, but substitute() got 1 results'
    )
  })

  it('keeps a query with no embedded expression', () => {
    expect(compileXFhirQuery('Patient?_count=1').substitute([])).toBe('Patient?_count=1')
  })
})

describe('CompiledXFhirQuery.evaluate', () => {
  it('evaluates each embedded expression on the input with the options', () => {
    const query = compileXFhirQuery('Observation?subject=Patient/{{id}}&patient.identifier={{identifier}}&x={{%x}}')
    expect(query.evaluate(patient, { model: r4Model, env: { x: 'y' } })).toBe(
      'Observation?subject=Patient/p1&patient.identifier=http://example.org/mrn|mrn-1&x=y'
    )
  })

  it('evaluates at an element context, as evaluateTyped() does', () => {
    const [name] = r4.evaluateTyped('Patient.name', patient)
    expect(compileXFhirQuery('Patient?family={{family}}&root={{%resource.id}}').evaluate([name as TypedValue])).toBe(
      'Patient?family=Example&root=p1'
    )
  })

  it('throws the error of an embedded expression', () => {
    expect(() => compileXFhirQuery('Patient?a={{(1 | 2).single()}}').evaluate()).toThrow(FhirPathRuntimeError)
    expect(() => compileXFhirQuery('Patient?a={{name}}').evaluate(patient, { model: r4Model })).toThrow(
      'A FHIR.HumanName value cannot be put in an x-fhir-query'
    )
  })

  it('is on the engine, with its defaults and parse cache', () => {
    expect(r4.evaluateXFhirQuery('Patient?identifier={{identifier}}', patient)).toBe(
      'Patient?identifier=http://example.org/mrn|mrn-1'
    )
    expect(() => r4.evaluateXFhirQuery('Patient?a={{name.(}}', patient)).toThrow(
      'Embedded expression 1 of the x-fhir-query is not valid FHIRPath'
    )
  })
})

describe('CompiledXFhirQuery.evaluateAsync', () => {
  const VS = 'http://example.org/ValueSet/kinds'
  const provider: TerminologyProvider & { calls: number } = {
    calls: 0,
    async validateVS() {
      this.calls++
      return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] }
    },
  }
  const coding = { resourceType: 'Observation', code: { coding: [{ system: 'http://example.org/cs', code: 'a' }] } }

  it('evaluates with a terminology service', async () => {
    const query = compileXFhirQuery('Observation?member={{code.memberOf(%vs)}}&code={{code}}')
    await expect(query.evaluateAsync(coding, { model: r4Model, terminology: provider, env: { vs: VS } })).resolves.toBe(
      'Observation?member=true&code=http://example.org/cs|a'
    )
    expect(provider.calls).toBe(1)
  })

  it('returns the result itself under syncWhenPossible when no service is needed', async () => {
    const query = compileXFhirQuery('Observation?code={{code}}')
    expect(query.evaluateAsync(coding, { model: r4Model, syncWhenPossible: true })).toBe(
      'Observation?code=http://example.org/cs|a'
    )
    const pending = compileXFhirQuery('Observation?member={{code.memberOf(%vs)}}').evaluateAsync(coding, {
      model: r4Model,
      terminology: provider,
      env: { vs: VS },
      syncWhenPossible: true,
    })
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toBe('Observation?member=true')
  })

  it('rejects with the error of an embedded expression or of the substitution', async () => {
    await expect(compileXFhirQuery('Patient?a={{(1 | 2).single()}}').evaluateAsync()).rejects.toThrow(
      FhirPathRuntimeError
    )
    await expect(compileXFhirQuery('Patient?a={{name}}').evaluateAsync(patient, { model: r4Model })).rejects.toThrow(
      FhirPathError
    )
    await expect(compileXFhirQuery('Patient?_count=1').evaluateAsync()).resolves.toBe('Patient?_count=1')
  })

  it('types the result as a Promise only without syncWhenPossible', () => {
    const query = compileXFhirQuery('Patient?_count=1')
    expectTypeOf(query.evaluateAsync()).toEqualTypeOf<Promise<string>>()
    expectTypeOf(query.evaluateAsync(undefined, { syncWhenPossible: true })).toEqualTypeOf<string | Promise<string>>()
  })
})
