import { describe, expect, it } from 'vitest'
import { evaluate } from '../api/evaluate.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'

describe('string functions', () => {
  it.each([
    ["'abcdefg'.indexOf('bc')", [1]],
    ["'abcdefg'.indexOf('x')", [-1]],
    ["'abcdefg'.indexOf('')", [0]],
    ["'abcabc'.lastIndexOf('bc')", [4]],
    ["'abcdefg'.substring(3)", ['defg']],
    ["'abcdefg'.substring(1, 2)", ['bc']],
    ["'abcdefg'.substring(6, 3)", ['g']],
    ["'abcdefg'.substring(7)", []],
    ["'abcdefg'.substring(-1)", []],
    ["'abcdefg'.substring({})", []],
    ["'abcdefg'.startsWith('abc')", [true]],
    ["'abcdefg'.startsWith('xyz')", [false]],
    ["''.startsWith('')", [true]],
    ["'abcdefg'.endsWith('efg')", [true]],
    ["'abcdefg'.endsWith('abc')", [false]],
    ["'abcdefg'.contains('cde')", [true]],
    ["'abcdefg'.contains('xyz')", [false]],
    ["'abcdefg'.contains('')", [true]],
    ["'abc'.upper()", ['ABC']],
    ["'ABC'.lower()", ['abc']],
    ["'abcdefg'.replace('cde', '123')", ['ab123fg']],
    ["'abcdefg'.replace('cde', '')", ['abfg']],
    ["'abc'.replace('', 'x')", ['xaxbxcx']],
    ["'http://fhir.org/guides/patient'.matches('hir')", [true]],
    ["'http://fhir'.matches('^hir$')", [false]],
    ["'hi'.matchesFull('hi')", [true]],
    ["'hihi'.matchesFull('hi')", [false]],
    ["'abc123def'.replaceMatches('\\\\d+', '|')", ['abc|def']],
    ["'abcdefg'.length()", [7]],
    ["''.length()", [0]],
    ["'ab'.toChars()", ['a', 'b']],
    ["'  hi  '.trim()", ['hi']],
    ["'a,b,c'.split(',')", ['a', 'b', 'c']],
    ["'a'.split(',')", ['a']],
    ["('a' | 'b' | 'c').join(',')", ['a,b,c']],
    ["('a' | 'b').join()", ['ab']],
    ["{}.join(',')", ['']],
    ["'abc'.encode('base64')", ['YWJj']],
    ["'YWJj'.decode('base64')", ['abc']],
    ["'ab?'.encode('urlbase64')", ['YWI_']],
    ["'YWI_'.decode('urlbase64')", ['ab?']],
    ["'abc'.encode('hex')", ['616263']],
    ["'616263'.decode('hex')", ['abc']],
    ["'1<2 & \\'quote\\''.escape('html')", ['1&lt;2 &amp; &#39;quote&#39;']],
    ["'1&lt;2'.unescape('html')", ['1<2']],
    ["'a\"b\\\\c'.escape('json')", ['a\\"b\\\\c']],
    ["'line\\\\nbreak'.unescape('json')", ['line\nbreak']],
    ['{}.length()', []],
    ['{}.upper()', []],
    ["'abc'.indexOf({})", []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('base64 handles padding variants', () => {
    expect(evaluate("'a'.encode('base64')")).toEqual(['YQ=='])
    expect(evaluate("'YQ=='.decode('base64')")).toEqual(['a'])
    expect(evaluate("'ab'.encode('base64')")).toEqual(['YWI='])
    expect(evaluate("'YWI='.decode('base64')")).toEqual(['ab'])
  })

  it('control characters escape to unicode in json', () => {
    expect(evaluate("'a\\u0001b'.escape('json')")).toEqual(['a\\u0001b'])
    expect(evaluate("'tab\\there'.escape('json')")).toEqual(['tab\\there'])
    expect(evaluate("'cr\\r'.escape('json')")).toEqual(['cr\\r'])
  })

  it('encodes multi-byte characters through utf-8', () => {
    expect(evaluate("'é'.encode('hex')")).toEqual(['c3a9'])
    expect(evaluate("'c3a9'.decode('hex')")).toEqual(['é'])
  })

  it('rejects wrong input and argument types', () => {
    expect(() => evaluate('1.length()')).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.indexOf(1)")).toThrow(FhirPathTypeError)
    expect(() => evaluate("('a' | 'b').length()")).toThrow(FhirPathRuntimeError)
    expect(() => evaluate("(1 | 'b').join()")).toThrow(FhirPathTypeError)
  })

  it('rejects unknown encode/decode/escape targets and bad payloads', () => {
    expect(() => evaluate("'a'.encode('rot13')")).toThrow("encode() does not support the format 'rot13'")
    expect(() => evaluate("'a'.decode('rot13')")).toThrow("decode() does not support the format 'rot13'")
    expect(() => evaluate("'!!'.decode('base64')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'xyz'.decode('hex')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.escape('xml')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.unescape('xml')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'\\\\q'.unescape('json')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.matches('[')")).toThrow('invalid regular expression')
  })
})

describe('conversions', () => {
  it.each([
    ['true.toBoolean()', [true]],
    ['1.toBoolean()', [true]],
    ['0.toBoolean()', [false]],
    ['2.toBoolean()', []],
    ['1.0.toBoolean()', [true]],
    ['0.0.toBoolean()', [false]],
    ["'true'.toBoolean()", [true]],
    ["'YES'.toBoolean()", [true]],
    ["'F'.toBoolean()", [false]],
    ["'nope'.toBoolean()", []],
    ["'1.0'.toBoolean()", [true]],
    ['@2014.toBoolean()', []],
    ['1.convertsToBoolean()', [true]],
    ['2.convertsToBoolean()', [false]],
    ['{}.toBoolean()', []],
    ['{}.convertsToBoolean()', []],

    ['1.toInteger()', [1]],
    ["'123'.toInteger()", [123]],
    ["'+5'.toInteger()", [5]],
    ["'-5'.toInteger()", [-5]],
    ["'1.5'.toInteger()", []],
    ['true.toInteger()', [1]],
    ['false.toInteger()', [0]],
    ['1.5.toInteger()', []],
    ["'abc'.convertsToInteger()", [false]],
    ["'123'.convertsToInteger()", [true]],

    ['1.toLong()', [1n]],
    ["'9223372036854775807'.toLong()", [9223372036854775807n]],
    ['true.toLong()', [1n]],
    ['1.5.toLong()', []],
    ["'12'.convertsToLong()", [true]],

    ['1.toDecimal()', [1]],
    ['1.5.toDecimal()', [1.5]],
    ["'1.5'.toDecimal()", [1.5]],
    ["'abc'.toDecimal()", []],
    ['true.toDecimal()', [1]],
    ["'1.5'.convertsToDecimal()", [true]],

    ['1.toString()', ['1']],
    ['1.5.toString()', ['1.5']],
    ['true.toString()', ['true']],
    ["4.5 'mg'.toString()", ["4.5 'mg'"]],
    ['4 days.toString()', ['4 days']],
    ['@2014-01-25.toString()', ['2014-01-25']],
    ['@T14:30.toString()', ['14:30']],
    ['1.convertsToString()', [true]],

    ["'2014-01'.toDate()", ['2014-01']],
    ['@2014-01-25T14:30.toDate()', ['2014-01-25']],
    ["'abc'.toDate()", []],
    ["'2014-01-25'.convertsToDate()", [true]],

    ['@2014-01-25.toDateTime()', ['2014-01-25']],
    ["'2014-01-25T14:30:00Z'.toDateTime()", ['2014-01-25T14:30:00Z']],
    ["'abc'.convertsToDateTime()", [false]],

    ["'14:30'.toTime()", ['14:30']],
    ["'25:00'.toTime()", []],
    ["'14:30'.convertsToTime()", [true]],

    ['1.toQuantity()', [{ value: 1, unit: '1' }]],
    ['1.5.toQuantity()', [{ value: 1.5, unit: '1' }]],
    ["'4.5 \\'mg\\''.toQuantity()", [{ value: 4.5, unit: 'mg' }]],
    ["'4 days'.toQuantity()", [{ value: 4, unit: 'days' }]],
    ["'10'.toQuantity()", [{ value: 10, unit: '1' }]],
    ["'4 nonsense'.toQuantity()", []],
    ['true.toQuantity()', [{ value: 1, unit: '1' }]],
    ["4.5 'mg'.toQuantity()", [{ value: 4.5, unit: 'mg' }]],
    ["4.5 'mg'.toQuantity('mg')", [{ value: 4.5, unit: 'mg' }]],
    ["4.5 'mg'.toQuantity('kg')", [{ value: 0.0000045, unit: 'kg' }]],
    ["4.5 'mg'.toQuantity('s')", []],
    ["'4 days'.convertsToQuantity()", [true]],
    ["'x'.convertsToQuantity()", [false]],
    ['{}.convertsToQuantity()', []],
  ])('%s', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it.each([
    ['1.toTime()', []],
    ['1.toDate()', []],
    ['1.toDateTime()', []],
    ['@2014.toLong()', []],
    ['@2014.toInteger()', []],
    ['@2014.toDecimal()', []],
    ['@2014.toQuantity()', []],
    ['name.toString()', []],
    ['false.toDecimal()', [0]],
    ['false.toLong()', [0n]],
    ['false.toQuantity()', [{ value: 0, unit: '1' }]],
    ["'2'.toBoolean()", []],
    ["'9999999999999999999'.toInteger()", []],
    ["'.5'.toDecimal()", []],
    ["' 4 days '.toQuantity()", [{ value: 4, unit: 'days' }]],
  ] as [string, unknown[]][])('non-convertible and edge inputs: %s', (expression, expected) => {
    expect(evaluate(expression, { resourceType: 'Patient', name: [{ family: 'X' }] })).toEqual(expected)
  })

  it('multi-item input errors', () => {
    expect(() => evaluate('(1 | 2).toString()')).toThrow(FhirPathRuntimeError)
  })

  it('toQuantity unit argument must be a string', () => {
    expect(() => evaluate("4.5 'mg'.toQuantity(1)")).toThrow(FhirPathTypeError)
  })
})

describe('json escape variants', () => {
  it.each([
    // Doubled backslashes: the FHIRPath lexer resolves one level first.
    ["'a\\\\/b'.unescape('json')", ['a/b']],
    ["'a\\\\bb'.unescape('json')", ['a\bb']],
    ["'a\\\\fb'.unescape('json')", ['a\fb']],
    ["'a\\\\rb'.unescape('json')", ['a\rb']],
    ["'a\\\\tb'.unescape('json')", ['a\tb']],
    ["'a\\\\u0041b'.unescape('json')", ['aAb']],
    ["'aAb'.unescape('json')", ['aAb']],
    [`'"1<2"'.unescape('json')`, ['"1<2"']],
  ])('%s', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('rejects malformed json escapes', () => {
    expect(() => evaluate("'a\\\\qb'.unescape('json')")).toThrow('invalid JSON')
    expect(() => evaluate("'a\\\\u12'.unescape('json')")).toThrow('invalid JSON')
    expect(() => evaluate("'trailing\\\\'.unescape('json')")).toThrow('invalid JSON')
  })
})

describe('sort', () => {
  it.each([
    ['(3 | 1 | 2).sort()', [1, 2, 3]],
    ["('c' | 'a').sort($this)", ['a', 'c']],
    ['(1 | 2 | 3).sort(-$this)', [3, 2, 1]],
    ['{}.sort()', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('empty keys sort last ascending and first descending', () => {
    const input = { resourceType: 'Basic', part: [{ n: 'b' }, { x: 1 }, { n: 'a' }] }
    expect(evaluate('part.sort(n).n', input)).toEqual(['a', 'b'])
    expect(evaluate('part.sort(-n).count()', input)).toEqual([3])
    expect(evaluate('part.sort(-n)[0].n', input)).toEqual([])
  })

  it('multiple keys break ties in order', () => {
    const input = {
      resourceType: 'Basic',
      part: [
        { a: 1, b: 2 },
        { a: 1, b: 1 },
        { a: 0, b: 9 },
      ],
    }
    expect(evaluate('part.sort(a, b).b', input)).toEqual([9, 1, 2])
    expect(evaluate('part.sort(a, -b).b', input)).toEqual([9, 2, 1])
  })
})
