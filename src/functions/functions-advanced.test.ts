import { describe, expect, it } from 'vitest'
import { evaluate } from '../api/evaluate'
import { FhirPathTypeError } from '../errors'

describe('math functions', () => {
  it.each([
    ['(-5).abs()', [5]],
    ['(-5.5).abs()', [5.5]],
    ["(-5.5 'mg').abs()", [{ value: 5.5, unit: 'mg' }]],
    ['1.ceiling()', [1]],
    ['1.1.ceiling()', [2]],
    ['(-1.1).ceiling()', [-1]],
    ['1.floor()', [1]],
    ['2.1.floor()', [2]],
    ['(-2.1).floor()', [-3]],
    ['101.truncate()', [101]],
    ['1.00000001.truncate()', [1]],
    ['(-1.56).truncate()', [-1]],
    ['1.round()', [1]],
    ['1.23456.round(3)', [1.235]],
    ['2.5.round()', [3]],
    ['(-2.5).round()', [-3]],
    ['0.exp()', [1]],
    ['1.ln() = 0.0', [true]],
    ['16.sqrt()', [4]],
    ['(-1).sqrt()', []],
    ['16.log(2)', [4]],
    ['100.0.log(10.0)', [2]],
    ['2.power(3)', [8]],
    ['2.5.power(2)', [6.25]],
    ['(-1).power(0.5)', []],
    ['{}.abs()', []],
    ['{}.round()', []],
    ['{}.log(2)', []],
    ['2.log({})', []],
    ['2.power({})', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects non-numeric inputs and bad precision', () => {
    expect(() => evaluate("'a'.abs()")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.ceiling()")).toThrow(FhirPathTypeError)
    expect(() => evaluate('1.5.round(-1)')).toThrow(FhirPathTypeError)
  })

  it('power keeps integers integral', () => {
    expect(evaluate('2.power(3) is Integer')).toEqual([true])
    expect(evaluate('2.power(-1)')).toEqual([0.5])
  })
})

describe('boundary and precision functions', () => {
  it.each([
    // toString() inside the expression keeps the Decimal's scale; unwrap() would
    // turn it into a JS number and drop the trailing zeros.
    ['1.587.lowBoundary().toString()', ['1.58650000']],
    ['1.587.highBoundary().toString()', ['1.58750000']],
    ['1.587.lowBoundary(6).toString()', ['1.586500']],
    ['1.9.lowBoundary(0) <= 2', [true]],
    // Integers behave as scale-0 decimals: the boundary is the half-unit range.
    ['5.lowBoundary().toString()', ['4.50000000']],
    ['5.highBoundary().toString()', ['5.50000000']],
    ["(4.5 'mg').lowBoundary().toString()", ["4.45000000 'mg'"]],
  ] as [string, unknown[]][])('%s', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('date boundaries fill missing components', () => {
    expect(evaluate('@2014.lowBoundary().toString()')).toEqual(['2014-01-01'])
    expect(evaluate('@2014.highBoundary().toString()')).toEqual(['2014-12-31'])
    expect(evaluate('@2014-02.highBoundary().toString()')).toEqual(['2014-02-28'])
    expect(evaluate('@2016-02.highBoundary().toString()')).toEqual(['2016-02-29'])
    expect(evaluate('@2014.lowBoundary(6).toString()')).toEqual(['2014-01'])
  })

  it('dateTime and time boundaries reach milliseconds; missing timezones get the extremes', () => {
    expect(evaluate('@2014-01-01T08.lowBoundary().toString()')).toEqual(['2014-01-01T08:00:00.000+14:00'])
    expect(evaluate('@2014-01-01T08.highBoundary().toString()')).toEqual(['2014-01-01T08:59:59.999-12:00'])
    expect(evaluate('@2014-01-01T08:05+08:00.lowBoundary().toString()')).toEqual(['2014-01-01T08:05:00.000+08:00'])
    expect(evaluate('@T10:30.lowBoundary().toString()')).toEqual(['10:30:00.000'])
    expect(evaluate('@T10:30.highBoundary().toString()')).toEqual(['10:30:59.999'])
  })

  it('precision counts digits', () => {
    expect(evaluate('1.58700.precision()')).toEqual([5])
    expect(evaluate('5.precision()')).toEqual([0])
    expect(evaluate('@2014.precision()')).toEqual([4])
    expect(evaluate('@2014-01-05T10:30:00.000.precision()')).toEqual([17])
    expect(evaluate('@T10:30.precision()')).toEqual([4])
    expect(evaluate('{}.precision()')).toEqual([])
    expect(() => evaluate('true.precision()')).toThrow(FhirPathTypeError)
    expect(() => evaluate('true.lowBoundary()')).toThrow(FhirPathTypeError)
    // Out-of-range precision means the boundary cannot be represented.
    expect(evaluate('1.5.lowBoundary(-1)')).toEqual([])
    expect(evaluate('1.5.lowBoundary(40)')).toEqual([])
  })
})

describe('date component extraction', () => {
  it.each([
    ['@2014-03-05T10:30:14.559.yearOf()', [2014]],
    ['@2014-03-05T10:30:14.559.monthOf()', [3]],
    ['@2014-03-05T10:30:14.559.dayOf()', [5]],
    ['@2014-03-05T10:30:14.559.hourOf()', [10]],
    ['@2014-03-05T10:30:14.559.minuteOf()', [30]],
    ['@2014-03-05T10:30:14.559.secondOf()', [14]],
    ['@2014-03-05T10:30:14.559.millisecondOf()', [559]],
    ['@2014.monthOf()', []],
    ['@T10:30.yearOf()', []],
    ['@T10:30.hourOf()', [10]],
    ['@2014-03-05.hourOf()', []],
    ['{}.yearOf()', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('timezoneOffsetOf returns decimal hours', () => {
    expect(evaluate('@2014-01-01T10:00+05:30.timezoneOffsetOf()')).toEqual([5.5])
    expect(evaluate('@2014-01-01T10:00-05:00.timezoneOffsetOf()')).toEqual([-5])
    expect(evaluate('@2014-01-01T10:00Z.timezoneOffsetOf()')).toEqual([0])
    expect(evaluate('@2014-01-01T10:00.timezoneOffsetOf()')).toEqual([])
  })

  it('dateOf and timeOf split a dateTime', () => {
    expect(evaluate('@2014-03-05T10:30:14.dateOf().toString()')).toEqual(['2014-03-05'])
    expect(evaluate('@2014-03-05T10:30:14.timeOf().toString()')).toEqual(['10:30:14'])
    expect(evaluate('@2014-03-05.timeOf()')).toEqual([])
    expect(evaluate('@T10:30.dateOf()')).toEqual([])
    expect(evaluate('@2014.dateOf().toString()')).toEqual(['2014'])
  })

  it('rejects non-temporal input', () => {
    expect(() => evaluate('1.yearOf()')).toThrow(FhirPathTypeError)
  })
})

describe('aggregate and convenience aggregates', () => {
  it.each([
    ['(1 | 2 | 3 | 4).aggregate($this + $total, 0)', [10]],
    ['(1 | 2 | 3 | 4).aggregate($this + $total, 10)', [20]],
    ['(1 | 2 | 3).aggregate(iif($total.empty(), $this, iif($this < $total, $this, $total)))', [1]],
    ['{}.aggregate($this + $total, 5)', [5]],
    ['(1 | 2 | 3 | 4).sum()', [10]],
    ['{}.sum()', [0]],
    ['(1.5 | 2.5).sum()', [4]],
    ['(1 | 2 | 3).min()', [1]],
    ['(3 | 1 | 2).max()', [3]],
    ['{}.min()', []],
    ['{}.max()', []],
    ['(1 | 2 | 3 | 4).avg()', [2.5]],
    ['{}.avg()', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('$index is available inside aggregate', () => {
    expect(evaluate("('a' | 'b').aggregate($total + $index.toString(), '')")).toEqual(['01'])
  })

  it('rejects non-numeric input for sum/min/max/avg', () => {
    expect(() => evaluate("('a' | 'b').sum()")).toThrow(FhirPathTypeError)
    expect(() => evaluate("('a' | 'b').min()")).toThrow(FhirPathTypeError)
  })
})

describe('type() reflection', () => {
  it.each([
    ['1.type().namespace', ['System']],
    ['1.type().name', ['Integer']],
    ['true.type().name', ['Boolean']],
    ["'a'.type().name", ['String']],
    ['1.5.type().name', ['Decimal']],
    ['@2014.type().name', ['Date']],
    ['@2014T.type().name', ['DateTime']],
    ['@T10:00.type().name', ['Time']],
    ["4 'mg'.type().name", ['Quantity']],
    ['(1 | 2).type().name', ['Integer', 'Integer']],
    ['{}.type()', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('resources reflect their type name', () => {
    const patient = { resourceType: 'Patient', id: 'p' }
    expect(evaluate('$this.type().namespace', patient)).toEqual(['FHIR'])
    expect(evaluate('$this.type().name', patient)).toEqual(['Patient'])
  })
})

describe('defineVariable', () => {
  const patient = {
    resourceType: 'Patient',
    id: 'example',
    active: true,
    name: [
      { use: 'official', family: 'Chalmers', given: ['Peter', 'James'] },
      { use: 'usual', given: ['Jim'] },
    ],
  }

  it.each([
    ["defineVariable('v1', 'value1').select(%v1)", ['value1']],
    ["defineVariable('n1', name.first()).select(%n1.given)", ['Peter', 'James']],
    ["defineVariable('n1', name.first()).select(%n1.given).first()", ['Peter']],
    // The same name may be defined separately in each operand of a union.
    [
      "defineVariable('n1', name.first()).select(%n1.given) | defineVariable('n1', name.skip(1).first()).select(%n1.given)",
      ['Peter', 'James', 'Jim'],
    ],
    [
      "Patient.name.defineVariable('n2', skip(1).first()).defineVariable('res', %n2.given & %n2.given).select(%res).first()",
      ['JimJim'],
    ],
    ["defineVariable('v1').select(%v1.id)", ['example']],
    [
      "defineVariable('root', 'r1-').select(defineVariable('v1', 'v1').defineVariable('v2', 'v2').select(%v1 | %v2)).select(%root & $this)",
      ['r1-v1', 'r1-v2'],
    ],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression, patient)).toEqual(expected)
  })

  it('variables do not leak across operator operands', () => {
    expect(() =>
      evaluate("defineVariable('n1', 'v1').active | defineVariable('n2', 'v2').select(%n1)", patient)
    ).toThrow('Undefined environment variable %n1')
  })

  it('variables defined inside a lambda do not leak out', () => {
    expect(() =>
      evaluate(
        "defineVariable('root', 'r1-').select(defineVariable('v1', 'v1').select(%v1)).select(%root & %v1)",
        patient
      )
    ).toThrow('Undefined environment variable %v1')
  })

  it('redefinition in the same chain is an error', () => {
    expect(() => evaluate("defineVariable('v1').defineVariable('v1').select(%v1)", patient)).toThrow(
      'Variable %v1 is already defined in this scope'
    )
  })

  it('overriding an environment variable is an error', () => {
    expect(() => evaluate("defineVariable('context', 'oops')", patient)).toThrow(
      'Cannot override the environment variable %context'
    )
    expect(() => evaluate("defineVariable('ucum', 'oops')", patient)).toThrow(FhirPathTypeError)
  })

  it('sibling arguments have separate scopes', () => {
    expect(
      evaluate(
        "'aaa'.replace(defineVariable('param', 'aaa').select(%param), defineVariable('param', 'bbb').select(%param))",
        patient
      )
    ).toEqual(['bbb'])
  })

  it('the name argument must be a string', () => {
    expect(() => evaluate('defineVariable(1)', patient)).toThrow('defineVariable() expects a String name')
  })
})

describe('clock functions', () => {
  const now = new Date(2026, 6, 3, 14, 30, 45)

  it('now/today/timeOfDay come from the injected clock', () => {
    expect(evaluate('today().toString()', undefined, { now })).toEqual(['2026-07-03'])
    expect(evaluate('timeOfDay().toString()', undefined, { now })).toEqual(['14:30:45'])
    const [nowText] = evaluate('now().toString()', undefined, { now }) as [string]
    expect(nowText.startsWith('2026-07-03T14:30:45')).toBe(true)
    expect(evaluate('now() = now()', undefined, { now })).toEqual([true])
  })

  it('now() is stable within one evaluation without an injected clock', () => {
    expect(evaluate('now() = now()')).toEqual([true])
    expect(evaluate('today() = today()')).toEqual([true])
    expect(evaluate('now().yearOf() >= 2026')).toEqual([true])
  })
})

describe('remaining phase-7 branches', () => {
  it('empty input propagates through every math function', () => {
    for (const fn of ['ceiling()', 'floor()', 'truncate()', 'exp()', 'ln()', 'sqrt()', 'power(2)']) {
      expect(evaluate(`{}.${fn}`)).toEqual([])
    }
  })

  it('components missing at the value precision are empty', () => {
    expect(evaluate('@T10:30.monthOf()')).toEqual([])
    expect(evaluate('@2014.dayOf()')).toEqual([])
    expect(evaluate('@2014-01-01T10.minuteOf()')).toEqual([])
    expect(evaluate('@2014-01-01T10:30.secondOf()')).toEqual([])
    expect(evaluate('@2014-01-01T10:30:14.millisecondOf()')).toEqual([])
    expect(evaluate('{}.timezoneOffsetOf()')).toEqual([])
    expect(evaluate('{}.dateOf()')).toEqual([])
    expect(evaluate('{}.timeOf()')).toEqual([])
  })

  it('boundaries fill time components at each precision', () => {
    expect(evaluate('@T10.highBoundary().toString()')).toEqual(['10:59:59.999'])
    expect(evaluate('@2014.lowBoundary(4).toString()')).toEqual(['2014'])
    expect(evaluate('@2014-01-01T10:00:00.500.lowBoundary().toString()')).toEqual(['2014-01-01T10:00:00.500+14:00'])
  })

  it('type() namespace falls back for plain objects and uses the model namespace', () => {
    expect(evaluate('%obj.type().namespace', undefined, { env: { obj: { a: 1 } } })).toEqual(['FHIR'])
    const model = {
      namespace: 'CDA',
      resolveType: () => undefined,
      getElement: () => undefined,
      isSubtypeOf: () => false,
    }
    expect(evaluate('%obj.type().namespace', undefined, { env: { obj: { a: 1 } }, model })).toEqual(['CDA'])
  })

  it('Long values flow through sum/min/max', () => {
    expect(evaluate('(%a.combine(%b)).sum()', undefined, { env: { a: 5n, b: 2n } })).toEqual([7n])
    expect(evaluate('(%a.combine(%b)).min()', undefined, { env: { a: 5n, b: 2n } })).toEqual([2n])
  })

  it('non-boolean toBoolean decimals are empty', () => {
    expect(evaluate('2.0.toBoolean()')).toEqual([])
    expect(evaluate('@2014.toTime()')).toEqual([])
  })

  it('type arguments must be plain dotted names', () => {
    expect(() => evaluate('1.ofType(exists().foo)')).toThrow('expects a type name argument')
  })

  it('durations that truncate to zero leave the value unchanged', () => {
    expect(evaluate('@2014 + 11 months')).toEqual(['2014'])
    expect(evaluate('@2014-01 + 20 days')).toEqual(['2014-01'])
  })

  it('sub-second time arithmetic keeps the fraction digits', () => {
    expect(evaluate('@T10:00:00.500 + 100 milliseconds')).toEqual(['10:00:00.600'])
    expect(evaluate('@T10:00 + 30 seconds')).toEqual(['10:00'])
  })

  it('times with different precisions compare per the shared prefix', () => {
    expect(evaluate('@T10 = @T10:30')).toEqual([])
    expect(evaluate('@T10 < @T11:00')).toEqual([true])
    expect(evaluate('@T10 ~ @T10:30')).toEqual([false])
  })

  it('week durations are equivalent to UCUM weeks', () => {
    expect(evaluate("1 week ~ 1 'wk'")).toEqual([true])
    expect(evaluate("1 week = 1 'wk'")).toEqual([true])
  })
})
