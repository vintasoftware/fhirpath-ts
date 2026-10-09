import { describe, expect, it } from 'vitest'

import { evaluate } from '../api/evaluate.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { r4Model } from '../r4/index.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { MAX_REPEAT_ITEMS } from './filtering.ts'

const patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  name: [
    { use: 'official', family: 'Chalmers', given: ['Peter', 'James'] },
    { use: 'usual', given: ['Jim'] },
    { use: 'maiden', family: 'Windsor', given: ['Peter', 'James'] },
  ],
  birthDate: '1974-12-25',
}

describe('existence functions', () => {
  it.each([
    ['{}.empty()', [true]],
    ['(1).empty()', [false]],
    ['{}.exists()', [false]],
    ['(1 | 2).exists()', [true]],
    ['(1 | 2 | 3).exists($this > 2)', [true]],
    ['(1 | 2 | 3).exists($this > 5)', [false]],
    ['(1 | 2 | 3).all($this > 0)', [true]],
    ['(1 | 2 | 3).all($this > 1)', [false]],
    ['{}.all($this > 1)', [true]],
    ['(true | true).allTrue()', [true]],
    ['(true.combine(false)).allTrue()', [false]],
    ['{}.allTrue()', [true]],
    ['(true.combine(false)).anyTrue()', [true]],
    ['(false.combine(false)).anyTrue()', [false]],
    ['(false.combine(false)).allFalse()', [true]],
    ['(true.combine(false)).allFalse()', [false]],
    ['(true.combine(false)).anyFalse()', [true]],
    ['(true | true).anyFalse()', [false]],
    ['{}.count()', [0]],
    ['(1 | 2).count()', [2]],
    ['(1.combine(1).combine(2)).distinct()', [1, 2]],
    ['(1.combine(1)).isDistinct()', [false]],
    ['(1 | 2).isDistinct()', [true]],
    ['{}.distinct()', []],
    ['(1 | 2).subsetOf(1 | 2 | 3)', [true]],
    ['(1 | 4).subsetOf(1 | 2 | 3)', [false]],
    ['(1 | 2 | 3).supersetOf(1 | 2)', [true]],
    ['(1 | 2).supersetOf(1 | 2 | 3)', [false]],
    ['{}.subsetOf(1 | 2)', [true]],
    ['(1 | 2).supersetOf({})', [true]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects non-boolean input for the boolean aggregates', () => {
    expect(() => evaluate('(1 | 2).allTrue()')).toThrow(FhirPathTypeError)
  })

  it('exists(criteria) sees $index', () => {
    expect(evaluate('name.exists($index = 2)', patient)).toEqual([true])
    expect(evaluate('name.tail().exists($index = 2)', patient)).toEqual([false])
  })
})

describe('filtering and projection', () => {
  it('where filters with $this scoping', () => {
    expect(evaluate("name.where(use = 'official').family", patient)).toEqual(['Chalmers'])
    expect(evaluate("name.where(use = 'missing')", patient)).toEqual([])
    expect(evaluate('name.where($this.use.exists())', patient)).toHaveLength(3)
  })

  it('select projects and flattens', () => {
    expect(evaluate('name.select(given)', patient)).toEqual(['Peter', 'James', 'Jim', 'Peter', 'James'])
    expect(evaluate('name.select(use)', patient)).toEqual(['official', 'usual', 'maiden'])
  })

  it('select exposes $index per item', () => {
    expect(evaluate('name.select($index)', patient)).toEqual([0, 1, 2])
  })

  it('nested iteration frames do not leak', () => {
    expect(evaluate('name.select(given.select($this))', patient)).toEqual(['Peter', 'James', 'Jim', 'Peter', 'James'])
  })

  it('repeat computes a transitive closure and stops on cycles', () => {
    const tree = {
      resourceType: 'Basic',
      part: [{ name: 'a', part: [{ name: 'b' }, { name: 'c', part: [{ name: 'd' }] }] }],
    }
    expect(evaluate('repeat(part).name', tree)).toEqual(['a', 'b', 'c', 'd'])
    const looped: { resourceType: string; name: string; self?: unknown } = {
      resourceType: 'Basic',
      name: 'root',
    }
    looped.self = looped
    expect(evaluate('repeat($this).name', looped)).toEqual(['root'])
  })

  it('repeat fails once a projection keeps producing new values', () => {
    expect(() => evaluate('1.repeat($this + 1)')).toThrow(`more than ${MAX_REPEAT_ITEMS} items`)
    expect(() => evaluate("'a'.repeat($this + 'a')")).toThrow(FhirPathRuntimeError)
    expect(evaluate(`0.repeat(iif($this < ${MAX_REPEAT_ITEMS}, $this + 1, {})).count()`)).toEqual([MAX_REPEAT_ITEMS])
  })

  it('repeat keeps one of each equal value', () => {
    expect(evaluate('1.repeat(1.0 | 1 | 2 | 2.00)')).toEqual([1, 2])
    // A number equals a Quantity with unit '1', whichever comes first.
    expect(evaluate("2.repeat(iif($this = 2, 1 '1', 1)).count()")).toEqual([1])
    expect(evaluate("2.repeat(iif($this = 2, 1, 1 '1'))")).toEqual([1])
    expect(evaluate("1 'mg'.repeat(1 'mg' | 1000 'ug' | 2 'mg').count()")).toEqual([2])
    expect(evaluate("'a'.repeat('a' | 'b')")).toEqual(['a', 'b'])
  })

  it('repeat reaches its limit quickly on temporal values', () => {
    expect(() => evaluate('@2016-01-01.repeat($this + 1 day)')).toThrow(`more than ${MAX_REPEAT_ITEMS} items`)
    expect(() => evaluate("@T00:00:00.000.repeat($this + 1 'ms')")).toThrow(`more than ${MAX_REPEAT_ITEMS} items`)
  })

  it('membership functions agree with in when = is not transitive', () => {
    // The untyped %u deep-equals the FHIR Quantity, which equals 1000 'g' by
    // conversion; %u itself does not. Membership must still find the Quantity.
    const quantity = { value: 1, unit: 'kg', system: 'http://unitsofmeasure.org', code: 'kg' }
    const observation = { resourceType: 'Observation', valueQuantity: quantity }
    const options = { model: r4Model, env: { u: { ...quantity } } }
    const others = '%u.combine(Observation.value)'
    const run = (expression: string): unknown[] => evaluate(expression, observation, options)
    expect(run(`(1000 'g') in (${others})`)).toEqual([true])
    expect(run(`(1000 'g').subsetOf(${others})`)).toEqual([true])
    expect(run(`(${others}).supersetOf(1000 'g')`)).toEqual([true])
    expect(run(`(1000 'g').exclude(${others})`)).toEqual([])
    expect(run(`(1000 'g').intersect(${others}).count()`)).toEqual([1])
  })

  it('distinct() keeps two values exactly when = is not true for them', () => {
    // Every kind the deduplication index keys differently: numbers and quantities
    // by canonical unit, calendar words, opaque units, temporals at each precision
    // and zone, strings, and booleans.
    const values = [
      '1',
      '1.0',
      '1L',
      '2',
      "1 '1'",
      "1 'g'",
      "1000 'mg'",
      '1 day',
      "1 'd'",
      '24 hours',
      "86400 's'",
      '1 week',
      "7 'd'",
      '1 year',
      '12 months',
      "1 'a'",
      "12 'mo'",
      "100 '%'",
      "1 '{tablet}'",
      "1 '[foo]'",
      "1 'cm'",
      "10 'mm'",
      "1 'g/m'",
      "1 'mg/mm'",
      '@2016-01-01',
      '@2016-01-01T',
      '@2016-01',
      '@2016-01-01T10:00',
      '@2016-01-01T10:00Z',
      '@2016-01-01T12:00+02:00',
      '@2016-01-01T10:00:00.000Z',
      '@2016-01-01T10:00:00Z',
      '@T10:00',
      '@T10:00:00',
      '@T10:00:00.000',
      "'1'",
      "'a'",
      "'true'",
      'true',
      'false',
    ]
    for (const a of values) {
      for (const b of values) {
        const equal = evaluate(`${a} = ${b}`)[0] === true
        expect([`${a}, ${b}`, evaluate(`(${a}).combine(${b}).distinct().count()`)]).toEqual([
          `${a}, ${b}`,
          [equal ? 1 : 2],
        ])
      }
    }
  })

  it('ofType filters by type', () => {
    expect(evaluate("(1 | 'a' | 2.5 | true).ofType(Integer)")).toEqual([1])
    expect(evaluate("(1 | 'a' | 2.5 | true).ofType(String)")).toEqual(['a'])
    expect(evaluate("(1 | 'a').ofType(System.Integer)")).toEqual([1])
    expect(evaluate('$this.ofType(Patient).id', patient)).toEqual(['example'])
    expect(evaluate('$this.ofType(Encounter)', patient)).toEqual([])
  })

  it('is() and as() function forms work like the operators', () => {
    expect(evaluate('1.is(Integer)')).toEqual([true])
    expect(evaluate('1.as(Integer)')).toEqual([1])
    expect(evaluate('1.as(String)')).toEqual([])
    expect(evaluate('{}.is(Integer)')).toEqual([])
  })

  it('rejects non-type arguments to ofType/is/as', () => {
    expect(() => evaluate('1.ofType(1 + 2)')).toThrow("Function 'ofType' expects a type name argument")
    expect(() => evaluate("1.is('Integer')")).toThrow(FhirPathTypeError)
  })
})

describe('subsetting', () => {
  it.each([
    ['(1 | 2 | 3).single()', null, 'error'],
    ['(1).single()', [1], null],
    ['{}.single()', [], null],
    ['(1 | 2 | 3).first()', [1], null],
    ['(1 | 2 | 3).last()', [3], null],
    ['(1 | 2 | 3).tail()', [2, 3], null],
    ['{}.tail()', [], null],
    ['(1 | 2 | 3).skip(1)', [2, 3], null],
    ['(1 | 2 | 3).skip(0)', [1, 2, 3], null],
    ['(1 | 2 | 3).skip(-1)', [1, 2, 3], null],
    ['(1 | 2 | 3).skip(5)', [], null],
    ['(1 | 2 | 3).take(2)', [1, 2], null],
    ['(1 | 2 | 3).take(0)', [], null],
    ['(1 | 2 | 3).take(-1)', [], null],
    ['(1 | 2 | 3).take(5)', [1, 2, 3], null],
    ['(1 | 2 | 3).intersect(2 | 3 | 4)', [2, 3], null],
    ['(1 | 2).intersect(3 | 4)', [], null],
    ['(1 | 2 | 3).exclude(2)', [1, 3], null],
    ['(1.combine(2).combine(1)).exclude(2)', [1, 1], null],
  ] as [string, unknown[] | null, string | null][])('%s', (expression, expected, error) => {
    if (error) {
      expect(() => evaluate(expression)).toThrow(FhirPathRuntimeError)
    } else {
      expect(evaluate(expression)).toEqual(expected)
    }
  })

  it('skip/take demand integer arguments', () => {
    expect(() => evaluate("(1 | 2).skip('a')")).toThrow(FhirPathRuntimeError)
    expect(() => evaluate('(1 | 2).take({})')).toThrow(FhirPathTypeError)
  })
})

describe('combining', () => {
  it('union dedupes, combine keeps duplicates', () => {
    expect(evaluate('(1 | 2).union(2 | 3)')).toEqual([1, 2, 3])
    expect(evaluate('(1 | 2).combine(2 | 3)')).toEqual([1, 2, 2, 3])
    expect(evaluate('{}.combine(1)')).toEqual([1])
  })
})

describe('iif', () => {
  it.each([
    ["iif(true, 'yes', 'no')", ['yes']],
    ["iif(false, 'yes', 'no')", ['no']],
    ["iif({}, 'yes', 'no')", ['no']],
    ["iif(false, 'yes')", []],
    ["iif(1 > 0, 'yes', 'no')", ['yes']],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('only evaluates the selected branch', () => {
    expect(evaluate("iif(true, 'ok', 1/0.single().not())")).toEqual(['ok'])
    expect(evaluate("iif(false, (1 | 2).single(), 'ok')")).toEqual(['ok'])
    expect(() => evaluate("iif(false, 'ok', (1 | 2).single())")).toThrow(FhirPathRuntimeError)
  })

  it('a non-boolean criterion counts as true via the singleton rule', () => {
    expect(evaluate("iif('x', 'yes', 'no')")).toEqual(['yes'])
  })
})

describe('tree navigation', () => {
  it('children returns immediate child nodes, skipping resourceType', () => {
    const children = evaluate('children()', patient)
    expect(children).toContain('example')
    expect(children).toContain(true)
    expect(children).toContain('1974-12-25')
    expect(children).not.toContain('Patient')
    expect(children.filter(child => typeof child === 'object')).toHaveLength(3)
  })

  it('children of primitives is empty', () => {
    expect(evaluate('id.children()', patient)).toEqual([])
  })

  it('descendants returns all nested nodes and excludes the input', () => {
    const descendants = evaluate('descendants()', patient)
    expect(descendants).toContain('Peter')
    expect(descendants).toContain('Chalmers')
    expect(descendants).toContain('official')
    expect(descendants).toContain(true)
    expect(descendants.some(item => (item as { resourceType?: string }).resourceType === 'Patient')).toBe(false)
  })

  it('name.children() flattens per item', () => {
    expect(evaluate('name.children().count()', patient)).toEqual([10])
  })
})

describe('utility', () => {
  it('not() follows three-valued logic', () => {
    expect(evaluate('true.not()')).toEqual([false])
    expect(evaluate('false.not()')).toEqual([true])
    expect(evaluate('{}.not()')).toEqual([])
    expect(evaluate('(1 = 1).not()')).toEqual([false])
  })

  it('trace passes input through and feeds the sink', () => {
    const traced: { name: string; values: TypedValue[] }[] = []
    const trace = (name: string, values: TypedValue[]): void => {
      traced.push({ name, values })
    }
    expect(evaluate("name.trace('names').count()", patient, { trace })).toEqual([3])
    expect(traced).toHaveLength(1)
    expect(traced[0]?.name).toBe('names')
    expect(traced[0]?.values).toHaveLength(3)
  })

  it('trace with a projection traces the projection instead', () => {
    const traced: { name: string; values: TypedValue[] }[] = []
    const trace = (name: string, values: TypedValue[]): void => {
      traced.push({ name, values })
    }
    expect(evaluate("name.trace('uses', use).count()", patient, { trace })).toEqual([3])
    expect(traced[0]?.values.map(item => item.value)).toEqual(['official', 'usual', 'maiden'])
  })

  it('trace without a sink is silent', () => {
    expect(evaluate("name.trace('names').count()", patient)).toEqual([3])
  })
})
