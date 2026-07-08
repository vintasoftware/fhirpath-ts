import { describe, expect, it } from 'vitest'

import type { EvaluateOptions } from '../api/compile.ts'
import { evaluate } from '../api/evaluate.ts'
import { FhirPathTypeError } from '../errors.ts'
import { r4Model } from '../r4/index.ts'
import { validateNarrative } from './html-checks.ts'

const options: EvaluateOptions = { model: r4Model }

describe('model navigation branches', () => {
  it('choice elements with no populated key are empty', () => {
    expect(evaluate('Observation.value', { resourceType: 'Observation', status: 'final' }, options)).toEqual([])
  })

  it('a choice primitive present only through its _field sibling still navigates', () => {
    const resource = {
      resourceType: 'Observation',
      status: 'final',
      _valueString: { extension: [{ url: 'http://data-absent', valueCode: 'masked' }] },
    }
    expect(evaluate('Observation.value.extension.url', resource, options)).toEqual(['http://data-absent'])
    expect(evaluate('Observation.value.hasValue()', resource, options)).toEqual([false])
  })

  it('unknown elements navigate to empty; choice-key misuse is the runtime error', () => {
    const resource = { resourceType: 'Patient', unknownKey: 'x' }
    // Typos are the static analyzer's job (spec §11); runtime navigation is lenient.
    expect(evaluate('unknownKey', resource, options)).toEqual([])
    expect(evaluate('resourceType', resource, options)).toEqual(['Patient'])
    // The one shape the official suites pin as a runtime semantic error.
    const observation = { resourceType: 'Observation', status: 'final', valueQuantity: { value: 1 } }
    expect(() => evaluate('Observation.valueQuantity.exists()', observation, options)).toThrow(
      'choice elements use their stem name'
    )
    // Types the model does not define read like raw JSON.
    const custom = { resourceType: 'CustomResource', anything: 'works' }
    expect(evaluate('anything', custom, options)).toEqual(['works'])
  })

  it('known elements missing from the JSON are empty', () => {
    expect(evaluate('Patient.birthDate', { resourceType: 'Patient' }, options)).toEqual([])
    expect(evaluate('Patient.name.given', { resourceType: 'Patient' }, options)).toEqual([])
  })

  it('arrays with aligned _name siblings keep per-element metadata', () => {
    const resource = {
      resourceType: 'Patient',
      name: [{ given: ['A', 'B'], _given: [null, { id: 'g2' }] }],
    }
    expect(evaluate('Patient.name.given', resource, options)).toEqual(['A', 'B'])
    expect(evaluate('Patient.name.given.id', resource, options)).toEqual(['g2'])
  })

  it('array primitives present only through _name navigate too', () => {
    const resource = {
      resourceType: 'Patient',
      name: [{ _given: [{ extension: [{ url: 'http://x', valueString: 'y' }] }] }],
    }
    expect(evaluate('Patient.name.given.extension.url', resource, options)).toEqual(['http://x'])
  })

  it('a collection element holding a single JSON value still yields one item', () => {
    const resource = { resourceType: 'Patient', name: { family: 'Solo' } }
    expect(evaluate('Patient.name.family', resource, options)).toEqual(['Solo'])
  })

  it('contained resources type by their resourceType', () => {
    const resource = {
      resourceType: 'Patient',
      contained: [{ resourceType: 'Organization', id: 'o1', name: 'ACME' }],
    }
    expect(evaluate('Patient.contained.ofType(Organization).name', resource, options)).toEqual(['ACME'])
  })

  it('decimal and integer64 primitives parse into exact values', () => {
    const resource = {
      resourceType: 'Observation',
      status: 'final',
      valueQuantity: { value: 0.1, unit: 'kg', code: 'kg' },
    }
    expect(evaluate('(Observation.value as Quantity).value + 0.2 = 0.3', resource, options)).toEqual([true])
  })

  it('malformed date strings stay as strings instead of throwing', () => {
    const resource = { resourceType: 'Patient', birthDate: 'not-a-date' }
    expect(evaluate('Patient.birthDate', resource, options)).toEqual(['not-a-date'])
    expect(evaluate('Patient.birthDate is date', resource, options)).toEqual([true])
  })

  it('primitive metadata reads only id and extension', () => {
    const resource = {
      resourceType: 'Patient',
      birthDate: '1980-01-01',
      _birthDate: { id: 'x', extension: [{ url: 'u' }] },
    }
    expect(evaluate('Patient.birthDate.value', resource, options)).toEqual([])
    expect(evaluate('Patient.birthDate.id', resource, options)).toEqual(['x'])
  })

  it('quantity coercion rejects quantities without numeric values', () => {
    const resource = {
      resourceType: 'Observation',
      status: 'final',
      valueQuantity: { unit: 'kg' },
    }
    expect(() => evaluate("Observation.value < 1 'kg'", resource, options)).toThrow(FhirPathTypeError)
  })

  it('mixed calendar and UCUM second comparisons work both ways', () => {
    expect(evaluate("1 's' = 1 second")).toEqual([true])
    expect(evaluate("1000 'ms' = 1 second")).toEqual([true])
    expect(evaluate("1 'a' = 1 year")).toEqual([])
    expect(evaluate("2 's' > 1 second")).toEqual([true])
  })

  it('bundle entries without resources are skipped by resolve()', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [{ fullUrl: 'http://x/Patient/p9' }, { resource: { resourceType: 'Patient', id: 'p1' } }],
    }
    expect(evaluate("'Patient/p1'.resolve().id", bundle, options)).toEqual(['p1'])
    expect(evaluate("'Patient/p2'.resolve()", bundle, options)).toEqual([])
    expect(evaluate("'#x'.resolve()", bundle, options)).toEqual([])
  })

  it('resolve with an empty root is empty', () => {
    expect(evaluate("'Patient/p1'.resolve()")).toEqual([])
  })

  it('comparable() promotes numbers to unity quantities; strings still error', () => {
    // Implicit Integer -> Quantity conversion (spec conversion table).
    expect(evaluate("1.comparable(1 'kg')")).toEqual([false])
    expect(evaluate('1.comparable(2)')).toEqual([true])
    expect(() => evaluate("'x'.comparable(1 'kg')")).toThrow('comparable() expects Quantity operands')
    expect(evaluate("{}.comparable(1 'kg')")).toEqual([])
  })
})

describe('additional branch sweep', () => {
  it('CodeableConcepts are equivalent when any coding matches', () => {
    const a = {
      coding: [
        { system: 's1', code: 'c1' },
        { system: 's2', code: 'c2' },
      ],
    }
    const b = { coding: [{ system: 's2', code: 'c2' }] }
    const c = { coding: [{ system: 's3', code: 'c3' }] }
    const observation = { resourceType: 'Observation', status: 'final', code: a }
    expect(evaluate('Observation.code ~ %other', observation, { ...options, env: { other: b } })).toEqual([true])
    expect(evaluate('Observation.code ~ %other', observation, { ...options, env: { other: c } })).toEqual([false])
    expect(evaluate('Observation.code ~ %other', observation, { ...options, env: { other: {} } })).toEqual([false])
  })

  it('time-only values parse through model navigation', () => {
    const timing = {
      resourceType: 'Observation',
      status: 'final',
      valueTime: '10:30:00',
      _valueTime: { id: 't' },
    }
    expect(evaluate('Observation.value is time', timing, options)).toEqual([true])
    expect(evaluate('Observation.value = @T10:30:00', timing, options)).toEqual([true])
    expect(evaluate('Observation.value.id', timing, options)).toEqual(['t'])
  })

  it('instant and integer64-shaped primitives convert', () => {
    const resource = { resourceType: 'Patient', birthDate: '1980-01-02', meta: { lastUpdated: '2020-01-01T00:00:00Z' } }
    expect(evaluate('Patient.meta.lastUpdated is instant', resource, options)).toEqual([true])
    expect(evaluate('Patient.meta.lastUpdated.yearOf()', resource, options)).toEqual([2020])
  })

  it('sum keeps Decimal kind and avg divides exactly', () => {
    expect(evaluate('(0.1 | 0.2).sum() = 0.3')).toEqual([true])
    expect(evaluate('(1 | 2).avg()')).toEqual([1.5])
  })

  it('negative and zero unit exponents parse', () => {
    expect(evaluate("(1 's-1' * 1 's').exists()")).toEqual([true])
    expect(evaluate("1 's-1' = 1 's-1'")).toEqual([true])
  })

  it('temporal arithmetic hitting the year floor from milliseconds is empty', () => {
    expect(evaluate('@0001-01-01T00:00 - 1 hour')).toEqual([])
    expect(evaluate('@9999-12-31T23:00 + 2 hours')).toEqual([])
  })

  it('date vs dateTime comparisons share the day prefix', () => {
    expect(evaluate('@2014-01-01 = @2014-01-01T10:00')).toEqual([])
    expect(evaluate('@2014-01-02 > @2014-01-01T10:00')).toEqual([true])
  })

  it('boundary precision below the value precision truncates components', () => {
    expect(evaluate('@2014-01-01T08.lowBoundary(8).toString()')).toEqual(['2014-01-01'])
    expect(evaluate('@T10.lowBoundary(2).toString()')).toEqual(['10'])
  })

  it('component extraction on values missing the component', () => {
    expect(evaluate('@2014-01.dayOf()')).toEqual([])
    expect(evaluate('@2014-01-01T10.minuteOf()')).toEqual([])
    expect(evaluate('@T10.minuteOf()')).toEqual([])
  })

  it('math functions with quantity or empty argument shapes', () => {
    expect(evaluate('{}.floor()')).toEqual([])
    expect(evaluate('{}.truncate()')).toEqual([])
    expect(evaluate('2.power(0)')).toEqual([1])
    expect(evaluate('0.ln()')).toEqual([])
  })

  it('is()/as() function forms on multi-item input error via singleton', () => {
    expect(() => evaluate('(1 | 2).is(Integer)')).toThrow()
    expect(() => evaluate('(1 | 2).as(Integer)')).toThrow()
  })

  it('conversion defaults for temporal inputs', () => {
    expect(evaluate('@T10:00.toDate()')).toEqual([])
    expect(evaluate('@T10:00.toDateTime()')).toEqual([])
    expect(evaluate('true.toDate()')).toEqual([])
    expect(evaluate('true.toDateTime()')).toEqual([])
    expect(evaluate('true.toTime()')).toEqual([])
    expect(evaluate('@2014.convertsToBoolean()')).toEqual([false])
  })

  it('deep equality with differing key counts', () => {
    const input = { resourceType: 'Basic', a: { x: 1 }, b: { x: 1, y: 2 } }
    expect(evaluate('a = b', input)).toEqual([false])
    expect(evaluate('a ~ b', input)).toEqual([false])
  })
})

describe('final branch sweep', () => {
  it('malformed containers behave as empty', () => {
    const resource = { resourceType: 'Patient', name: 'oops' }
    expect(evaluate('Patient.name.family', resource, options)).toEqual([])
  })

  it('primitive metadata without the asked field is empty', () => {
    const resource = { resourceType: 'Patient', birthDate: '1980-01-01', _birthDate: { id: 'x' } }
    expect(evaluate('Patient.birthDate.extension', resource, options)).toEqual([])
  })

  it('quantity conversions of non-quantity inputs stay non-quantity', () => {
    expect(evaluate("(4 'mg').toBoolean()")).toEqual([])
    expect(evaluate('@2014T.toDateTime().toString()')).toEqual(['2014'])
    expect(evaluate('@T10:00.toTime().toString()')).toEqual(['10:00'])
  })

  it('temporal component functions are empty for non-temporal inputs', () => {
    expect(evaluate('1.timezoneOffsetOf()')).toEqual([])
    expect(evaluate('1.dateOf()')).toEqual([])
    expect(evaluate('1.timeOf()')).toEqual([])
  })

  it('boundary at a precision matching the value is unchanged', () => {
    expect(evaluate('@T10.lowBoundary(2).toString()')).toEqual(['10'])
    expect(evaluate('@T10:30:14.559.highBoundary().toString()')).toEqual(['10:30:14.559'])
  })

  it('integer sums that overflow the Integer range are empty', () => {
    expect(evaluate('(2147483647 | 1).sum()')).toEqual([])
  })

  it('type arguments with call segments are rejected', () => {
    expect(() => evaluate('1.ofType(a.exists().b)')).toThrow('expects a type name argument')
  })

  it('year-only ordering compares at the year level', () => {
    expect(evaluate('@2013 < @2014')).toEqual([true])
    expect(evaluate('@T10 + 26 hours = @T12')).toEqual([true])
  })

  it('unit exponents of zero are dimensionless', () => {
    expect(evaluate("1 'm0' = 1 '1'")).toEqual([true])
  })
})

describe('phase-11 branch sweep', () => {
  it('null slots in primitive arrays without siblings are dropped', () => {
    const resource = { resourceType: 'Patient', name: [{ given: [null, 'A'] }] }
    expect(evaluate('Patient.name.given', resource, options)).toEqual(['A'])
  })

  it('null slots in complex arrays are dropped even with sibling metadata', () => {
    const resource = { resourceType: 'Patient', name: [null], _name: [{ id: 'x' }] }
    expect(evaluate('Patient.name', resource, options)).toEqual([])
  })

  it('math edges: overflow and domain errors are empty', () => {
    expect(evaluate('10000000000.5.floor()')).toEqual([])
    expect(evaluate('10000000000.5.ceiling()')).toEqual([])
    expect(evaluate('10000000000.5.truncate()')).toEqual([])
    expect(evaluate('(-1).log(2)')).toEqual([])
    expect(evaluate('2.log(1)')).toEqual([])
    expect(evaluate('2.power(31)')).toEqual([])
  })

  it('boundary precision above the type maximum is empty', () => {
    expect(evaluate("(1.5 'mg').lowBoundary(30)")).toEqual([])
    expect(evaluate('@T10.lowBoundary(12)')).toEqual([])
  })

  it('long values convert through toDecimal/toString/toQuantity', () => {
    expect(evaluate('%a.toDecimal()', undefined, { env: { a: 5n } })).toEqual([5])
    expect(evaluate('%a.toString()', undefined, { env: { a: 5n } })).toEqual(['5'])
    expect(evaluate('%a.toQuantity()', undefined, { env: { a: 5n } })).toEqual([{ value: 5, unit: '1' }])
    expect(evaluate('@2014.toDate().toString()')).toEqual(['2014'])
  })

  it('extension url edge cases', () => {
    expect(evaluate('Patient.extension({})', { resourceType: 'Patient' }, options)).toEqual([])
    expect(() => evaluate('Patient.extension(1)', { resourceType: 'Patient' }, options)).toThrow(
      'extension() expects a String url'
    )
    expect(evaluate('{}.conformsTo(%x)', undefined, { env: { x: 'y' } })).toEqual([])
  })

  it('ordering with mixed timezone presence is empty', () => {
    expect(evaluate('@2014-01-01T10:00Z < @2014-01-01T11:00')).toEqual([])
    // 11:00+02:00 is 09:00Z, so it comes before 10:00Z.
    expect(evaluate('@2014-01-01T10:00Z < @2014-01-01T11:00+02:00')).toEqual([false])
    expect(evaluate('@2014-01-01T08:00Z < @2014-01-01T11:00+02:00')).toEqual([true])
  })

  it('quoted calendar words drive date arithmetic', () => {
    expect(evaluate("@2014-01-01 + 1 'week'")).toEqual(['2014-01-08'])
    expect(evaluate("@2014-12-25 - 1 'month'")).toEqual(['2014-11-25'])
  })

  it('non-quantity complex values never coerce to quantities', () => {
    const observation = { resourceType: 'Observation', status: 'final', code: { coding: [{ code: 'x' }] } }
    expect(evaluate("Observation.code = 1 'kg'", observation, options)).toEqual([false])
  })

  it('narrative validation handles CDATA and bare attributes', () => {
    expect(validateNarrative('<div xmlns="http://www.w3.org/1999/xhtml"><![CDATA[x]]><p>t</p></div>')).toBe(true)
    expect(
      validateNarrative('<div xmlns="http://www.w3.org/1999/xhtml"><table><tr><td nowrap="1">t</td></tr></table></div>')
    ).toBe(true)
  })
})

describe('final coverage sweep', () => {
  it('unsigned registered functions still walk and stay unknown in the analyzer', async () => {
    const { analyzeExpression } = await import('../analyzer/analyze.ts')
    expect(analyzeExpression("subsumedBy('x')", { model: r4Model, inputType: 'Patient' })).toEqual([])
    expect(analyzeExpression('1 as System.Integer', { model: r4Model })).toEqual([])
    expect(analyzeExpression('%resource | 1', { model: r4Model })).toEqual([])
    expect(analyzeExpression('(4 / 2) = 2.0', { model: r4Model })).toEqual([])
  })

  it('conversion edges for Long and unit-checked convertsToQuantity', () => {
    expect(evaluate('%a.toInteger()', undefined, { env: { a: 5n } })).toEqual([5])
    expect(evaluate('%a.toInteger()', undefined, { env: { a: 1099511627776n } })).toEqual([])
    expect(evaluate("'a'.toLong()")).toEqual([])
    expect(evaluate("'1'.convertsToQuantity()")).toEqual([true])
    expect(evaluate('@2014-01-25.toDate().toString()')).toEqual(['2014-01-25'])
  })

  it('resolve skips non-reference values and conformsTo needs a string url', () => {
    expect(evaluate('1.resolve()')).toEqual([])
    expect(() => evaluate('conformsTo(1)', { resourceType: 'Patient' }, options)).toThrow(
      'only supports base StructureDefinition urls'
    )
  })

  it('narrative with a stray unmatched character fails', () => {
    expect(validateNarrative('<div xmlns="http://www.w3.org/1999/xhtml">a<</div>')).toBe(false)
  })

  it('partial timezone offsets lex as operators', () => {
    expect(evaluate('@2014-01-01T10:00 < @2014-01-01T11:00')).toEqual([true])
    // '+05' is not a full offset, so it parses as adding the integer 5 — a type error.
    expect(() => evaluate('@2014-01-01T10:00+05')).toThrow(FhirPathTypeError)
  })
})
