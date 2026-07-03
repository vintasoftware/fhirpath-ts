import { describe, expect, it } from 'vitest'
import { evaluate } from '../../api/evaluate'
import { FhirPathRuntimeError, FhirPathTypeError } from '../../errors'

/** `{}` for empty, `true`/`false` for booleans — mirrors the spec's truth tables. */
function triLiteral(value: boolean | undefined): string {
  if (value === undefined) {
    return '{}'
  }
  return value ? 'true' : 'false'
}

function triResult(value: boolean | undefined): unknown[] {
  return value === undefined ? [] : [value]
}

describe('three-valued logic (spec §6.5, all 9 cells per operator)', () => {
  const T = true
  const F = false
  const E = undefined
  const cells: [boolean | undefined, boolean | undefined][] = [
    [T, T],
    [T, F],
    [T, E],
    [F, T],
    [F, F],
    [F, E],
    [E, T],
    [E, F],
    [E, E],
  ]

  const tables: Record<string, (boolean | undefined)[]> = {
    and: [T, F, E, F, F, F, E, F, E],
    or: [T, T, T, T, F, E, T, E, E],
    xor: [F, T, E, T, F, E, E, E, E],
    implies: [T, F, E, T, T, T, T, E, E],
  }

  for (const [operator, results] of Object.entries(tables)) {
    describe(operator, () => {
      cells.forEach(([a, b], index) => {
        it(`${triLiteral(a)} ${operator} ${triLiteral(b)} = ${triLiteral(results[index])}`, () => {
          expect(evaluate(`${triLiteral(a)} ${operator} ${triLiteral(b)}`)).toEqual(triResult(results[index]))
        })
      })
    })
  }

  it('applies the singleton implicit-true rule to operands', () => {
    expect(evaluate("'a' and true")).toEqual([true])
    expect(evaluate("'a' or false")).toEqual([true])
  })
})

describe('equality (=, !=)', () => {
  it.each([
    ['1 = 1', [true]],
    ['1 = 2', [false]],
    ['1 = 1.0', [true]],
    ['1.01 = 1.0100', [true]],
    ["'abc' = 'abc'", [true]],
    ["'abc' = 'ABC'", [false]],
    ['true = true', [true]],
    ['true = false', [false]],
    ["1 = 'abc'", [false]],
    ['{} = 1', []],
    ['1 = {}', []],
    ['(1 | 2) = (1 | 2)', [true]],
    ['(1 | 2) = (2 | 1)', [false]],
    ['(1 | 2 | 3) = (1 | 2)', [false]],
    ['1 != 2', [true]],
    ['1 != 1', [false]],
    ['{} != 1', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('compares dates by component with timezone normalization', () => {
    expect(evaluate('@2012-04-15 = @2012-04-15')).toEqual([true])
    expect(evaluate('@2012-04-15 = @2012-04-16')).toEqual([false])
    expect(evaluate('@2012-04-15T15:00:00Z = @2012-04-15T10:00:00-05:00')).toEqual([true])
  })

  it('mismatched date precision is empty for = and unequal values are false', () => {
    expect(evaluate('@2012-01 = @2012')).toEqual([])
    expect(evaluate('@2012-04-15 = @2012-04-15T10:00:00')).toEqual([])
    expect(evaluate('@2013-01 = @2012')).toEqual([false])
  })

  it('seconds and milliseconds are one precision', () => {
    expect(evaluate('@2012-04-15T15:00:00 = @2012-04-15T15:00:00.000')).toEqual([true])
  })

  it('compares complex values recursively', () => {
    const patient = { resourceType: 'Patient', name: [{ given: ['A'] }] }
    expect(evaluate('name = name', patient)).toEqual([true])
  })

  it('quantities with the same unit compare by value', () => {
    expect(evaluate("4 'mg' = 4 'mg'")).toEqual([true])
    expect(evaluate("4 'mg' = 5 'mg'")).toEqual([false])
    expect(evaluate('1 year = 1 year')).toEqual([true])
    expect(evaluate('1 year = 12 months')).toEqual([true])
    expect(evaluate('1 year = 11 months')).toEqual([false])
    expect(evaluate('1 year = 365 days')).toEqual([])
  })

  it('calendar years never equal UCUM years', () => {
    expect(evaluate("1 year = 1 'a'")).toEqual([])
    expect(evaluate("1 second = 1 's'")).toEqual([true])
  })
})

describe('equivalence (~, !~)', () => {
  it.each([
    ['{} ~ {}', [true]],
    ['{} ~ 1', [false]],
    ['1 ~ 1', [true]],
    ['1 ~ 1.0', [true]],
    ['1.010 ~ 1.012', [false]],
    ['1.01 ~ 1.012', [true]],
    ['0.012 ~ 0.0124', [true]],
    ["'abc' ~ 'ABC'", [true]],
    ["'a b' ~ 'a\\tb'", [true]],
    ['@2012-01 ~ @2012', [false]],
    ['@2012 ~ @2012', [true]],
    ['(1 | 2) ~ (2 | 1)', [true]],
    ['(1 | 2 | 3) ~ (2 | 1)', [false]],
    ['1 !~ 2', [true]],
    ['{} !~ {}', [false]],
    ["1 year ~ 1 'a'", [true]],
    ["1 ~ 'abc'", [false]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })
})

describe('comparison (< > <= >=)', () => {
  it.each([
    ['1 < 2', [true]],
    ['2 < 1', [false]],
    ['1 <= 1', [true]],
    ['2 > 1', [true]],
    ['1 >= 2', [false]],
    ['1.5 > 1', [true]],
    ["'abc' > 'ABC'", [true]],
    ["'a' < 'b'", [true]],
    ['{} < 1', []],
    ['1 < {}', []],
    ['@2012-04-15 < @2012-04-16', [true]],
    ['@2012-04-15T15:00 > @2012-04-15T10:00', [true]],
    ['@T10:00 < @T14:30', [true]],
    ['@2012-04-15 > @2012-04-15T10:00', []],
    ["4 'mg' < 5 'mg'", [true]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects incomparable types', () => {
    expect(() => evaluate("1 < 'abc'")).toThrow(FhirPathTypeError)
    expect(() => evaluate('true < false')).toThrow(FhirPathTypeError)
    expect(() => evaluate('@T10:00 < @2012-04-15')).toThrow('Cannot compare a time with a date or dateTime')
  })
})

describe('math', () => {
  it.each([
    ['1 + 2', [3]],
    ['5 - 2', [3]],
    ['3 * 4', [12]],
    ['1 / 2', [0.5]],
    // Exact decimals: a non-terminating quotient times 3 is 0.99..., equal fails, equivalence rounds.
    ['1.0 / 3 * 3 = 1.0', [false]],
    ['1.0 / 3 * 3 ~ 1.0', [true]],
    ['0.1 + 0.2 = 0.3', [true]],
    ['7 div 2', [3]],
    ['-7 div 2', [-3]],
    ['7 mod 2', [1]],
    ['5.5 mod 0.7 = 0.6', [true]],
    ['1 / 0', []],
    ['1 div 0', []],
    ['1 mod 0', []],
    ['1.5 + 1', [2.5]],
    ['{} + 1', []],
    ['1 + {}', []],
    ["'abc' + 'def'", ['abcdef']],
    ['-5', [-5]],
    ['+5', [5]],
    ['-(1.5)', [-1.5]],
    ['2147483647 + 1', []],
    ['-2147483647 - 2', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects string operands for non-concat operators', () => {
    expect(() => evaluate("'abc' - 'c'")).toThrow(FhirPathTypeError)
    expect(() => evaluate("1 + 'abc'")).toThrow(FhirPathTypeError)
    expect(() => evaluate('-true')).toThrow(FhirPathTypeError)
  })

  it('errors on multi-item operands', () => {
    expect(() => evaluate('(1 | 2) + 1')).toThrow(FhirPathRuntimeError)
  })
})

describe('string concatenation (&)', () => {
  it.each([
    ["'abc' & 'def'", ['abcdef']],
    ["'abc' & {}", ['abc']],
    ["{} & 'def'", ['def']],
    ['{} & {}', ['']],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects non-string operands', () => {
    expect(() => evaluate("1 & 'a'")).toThrow(FhirPathTypeError)
  })
})

describe('date/time arithmetic', () => {
  it.each([
    ['@2014 + 1 year', ['2015']],
    ['@2014 + 24 months', ['2016']],
    ['@2014 + 23 months', ['2015']],
    ['@2014-01 + 1 month', ['2014-02']],
    ['@2014-12 + 1 month', ['2015-01']],
    ['@2020-01-31 + 1 month', ['2020-02-29']],
    ['@2019-01-31 + 1 month', ['2019-02-28']],
    ['@2016-02-29 + 1 year', ['2017-02-28']],
    ['@2014-01-01 + 10 days', ['2014-01-11']],
    ['@2014-01-01 - 1 day', ['2013-12-31']],
    ['@2014-01-01 + 2 weeks', ['2014-01-15']],
    ["@2014-01-01 + 2 'wk'", ['2014-01-15']],
    ['@2014-01-01 + 36 hours', ['2014-01-02']],
    ['@2014-01-01T10:00 + 90 minutes', ['2014-01-01T11:30']],
    ['@2014-01-01T00:00 - 1 minute', ['2013-12-31T23:59']],
    ['@T10:00 + 3 hours', ['13:00']],
    ['@T23:00 + 2 hours', ['01:00']],
    ['@T01:00 - 2 hours', ['23:00']],
    ['@2014-01-01T10:00:00.500 + 500 milliseconds', ['2014-01-01T10:00:01.000']],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('keeps the timezone through arithmetic', () => {
    expect(evaluate('@2014-01-01T10:00+02:00 + 1 hour')).toEqual(['2014-01-01T11:00+02:00'])
  })

  it('rejects UCUM year and month for calendar arithmetic', () => {
    expect(() => evaluate("@2014 + 1 'a'")).toThrow(FhirPathRuntimeError)
    expect(() => evaluate("@2014-01 + 1 'mo'")).toThrow(FhirPathRuntimeError)
  })

  it('out-of-range years are empty', () => {
    expect(evaluate('@9999 + 1 year')).toEqual([])
    expect(evaluate('@0001 - 1 year')).toEqual([])
  })
})

describe('membership and union', () => {
  it.each([
    ['1 in (1 | 2 | 3)', [true]],
    ['4 in (1 | 2 | 3)', [false]],
    ['{} in (1 | 2)', []],
    ['1 in {}', [false]],
    ['(1 | 2) contains 2', [true]],
    ['(1 | 2) contains 3', [false]],
    ['{} contains 1', [false]],
    ['1 contains {}', []],
    ['1 | 2 | 2 | 3', [1, 2, 3]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('union eliminates duplicates across both sides', () => {
    expect(evaluate('(1 | 2) | (2 | 3)')).toEqual([1, 2, 3])
    expect(evaluate("'a' | 'a'")).toEqual(['a'])
  })

  it("errors when 'in' has a multi-item left operand", () => {
    expect(() => evaluate('(1 | 2) in (1 | 2)')).toThrow(FhirPathRuntimeError)
  })
})

describe('is / as', () => {
  const patient = { resourceType: 'Patient', active: true, birthDate: '1974-12-25' }

  it.each([
    ['1 is Integer', [true]],
    ['1 is System.Integer', [true]],
    ['1 is Decimal', [false]],
    ['1.0 is Decimal', [true]],
    ["'a' is String", [true]],
    ['true is Boolean', [true]],
    ['true is boolean', [true]],
    ['@2014 is Date', [true]],
    ['@2014T is DateTime', [true]],
    ['@T10:00 is Time', [true]],
    ["4 'mg' is Quantity", [true]],
    ['1 is System.Any', [true]],
    ['{} is Integer', []],
    ['1 is Unknown', [false]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('matches resource types dynamically', () => {
    expect(evaluate('$this is Patient', patient)).toEqual([true])
    expect(evaluate('$this is Encounter', patient)).toEqual([false])
  })

  it('as keeps matching items and drops the rest', () => {
    expect(evaluate('1 as Integer', patient)).toEqual([1])
    expect(evaluate('1 as String', patient)).toEqual([])
    expect(evaluate('{} as Integer')).toEqual([])
  })

  it('errors on multi-item input', () => {
    expect(() => evaluate('(1 | 2) is Integer')).toThrow(FhirPathRuntimeError)
    expect(() => evaluate('(1 | 2) as Integer')).toThrow(FhirPathRuntimeError)
  })
})

describe('quantity arithmetic', () => {
  it.each([
    ["4 'mg' + 3 'mg'", [{ value: 7, unit: 'mg' }]],
    ["4 'mg' - 3 'mg'", [{ value: 1, unit: 'mg' }]],
    ['4 days + 3 days', [{ value: 7, unit: 'days' }]],
    ["4 'mg' * 2", [{ value: 8, unit: 'mg' }]],
    ["4 'mg' / 2", [{ value: 2, unit: 'mg' }]],
    ["4 'mg' / 0", []],
    ["-(4 'mg')", [{ value: -4, unit: 'mg' }]],
    ["+(4 'mg')", [{ value: 4, unit: 'mg' }]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects quantity-plus-number and non-additive temporal operators', () => {
    expect(() => evaluate("4 'mg' + 2")).toThrow(FhirPathTypeError)
    expect(() => evaluate('@2014 * 1 day')).toThrow(FhirPathTypeError)
    expect(() => evaluate('1 year * 2 months')).toThrow(FhirPathTypeError)
  })
})

describe('Long arithmetic through environment values', () => {
  it('keeps Long-ness for integral results', () => {
    expect(evaluate('%a + %b', undefined, { env: { a: 5n, b: 2n } })).toEqual([7n])
    expect(evaluate('%a + 1', undefined, { env: { a: 5n } })).toEqual([6n])
    expect(evaluate('%a * 2', undefined, { env: { a: 5n } })).toEqual([10n])
    expect(evaluate('-%a', undefined, { env: { a: 5n } })).toEqual([-5n])
  })

  it('division always produces a Decimal', () => {
    expect(evaluate('%a / 2', undefined, { env: { a: 5n } })).toEqual([2.5])
  })

  it('compares and equates Longs with Integers', () => {
    expect(evaluate('%a = 5', undefined, { env: { a: 5n } })).toEqual([true])
    expect(evaluate('%a < 6', undefined, { env: { a: 5n } })).toEqual([true])
    expect(evaluate('%a is Long', undefined, { env: { a: 5n } })).toEqual([true])
  })
})

describe('equivalence over complex values', () => {
  const patient = {
    resourceType: 'Patient',
    name: [{ family: 'Chalmers', given: ['Peter', 'James'] }],
    contact: [{ name: { family: 'DU  MARCHÉ' } }],
  }

  it('booleans and identical complex values are equivalent', () => {
    expect(evaluate('true ~ true')).toEqual([true])
    expect(evaluate('true ~ false')).toEqual([false])
    expect(evaluate('name ~ name', patient)).toEqual([true])
  })

  it('nested strings compare with equivalence semantics', () => {
    expect(evaluate('contact.name ~ %other', patient, { env: { other: { family: 'du  marché' } } })).toEqual([true])
    expect(evaluate('contact.name ~ %other', patient, { env: { other: { family: 'other' } } })).toEqual([false])
    expect(
      evaluate('name ~ %other', patient, { env: { other: { family: 'Chalmers', given: ['Peter', 'X'] } } })
    ).toEqual([false])
    expect(evaluate('name ~ %other', patient, { env: { other: { family: 'Chalmers' } } })).toEqual([false])
  })

  it('mismatched quantities are not equivalent', () => {
    expect(evaluate("4 'mg' ~ 4 'kg'")).toEqual([false])
    expect(evaluate("4 'mg' ~ 5 'mg'")).toEqual([false])
  })

  it('equal strings compare as equal in ordering', () => {
    expect(evaluate("'a' <= 'a'")).toEqual([true])
    expect(evaluate("'b' < 'a'")).toEqual([false])
  })
})
