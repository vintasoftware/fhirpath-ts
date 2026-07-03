import { describe, expect, it } from 'vitest'
import { evaluate } from '../api/evaluate'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors'
import type { TypedValue } from '../values/typed-value'

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
