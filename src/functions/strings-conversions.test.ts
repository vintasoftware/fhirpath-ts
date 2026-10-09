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
    // FHIRPath 3.0.0 regex flags: 'i' ignores case, 'm' anchors at line breaks.
    ["'first line\\nsecond line'.matches('^second', 'm')", [true]],
    ["'first line\\nsecond line'.matches('^second', '')", [false]],
    ["'first line\\nsecond line'.matches('^SECOND', 'im')", [true]],
    ["'first line\\nsecond line'.matches('line.second', '')", [true]],
    ["'Hello'.matches('hello', {})", [false]],
    ["'Hello'.matches('hello', 'i')", [true]],
    ["'Hello'.matches('hello', 'ii')", [true]],
    ["'Test String'.matchesFull('test string', 'i')", [true]],
    ["'Test String'.matchesFull('test string', '')", [false]],
    ["'abc\\ndef'.matchesFull('abc', 'm')", [true]],
    ["'ABC'.replaceMatches('[a-z]+', 'x', 'i')", ['x']],
    ["'ABC'.replaceMatches('[a-z]+', 'x')", ['ABC']],
    ["'a\\nb'.replaceMatches('^', '> ', 'm')", ['> a\n> b']],
    ["'abc123def'.replaceMatches('\\\\d+', '|')", ['abc|def']],
    // Spec §5.6.10 example: PCRE-style named group references.
    [
      "'11/30/1972'.replaceMatches('\\\\b(?<month>\\\\d{1,2})/(?<day>\\\\d{1,2})/(?<year>\\\\d{2,4})\\\\b', '${day}-${month}-${year}')",
      ['30-11-1972'],
    ],
    ["'ab'.replaceMatches('(a)(b)', '${2}${1}0')", ['ba0']],
    ["'ab'.replaceMatches('(a)', '[${0}]')", ['[a]b']],
    ["'ab'.replaceMatches('(a)(b)', '$2$1')", ['ba']],
    ["'ab'.replaceMatches('(?<x>a)', '$${x}')", ['${x}b']],
    ["'abcdefg'.length()", [7]],
    ["''.length()", [0]],
    ["'ab'.toChars()", ['a', 'b']],
    ["'  hi  '.trim()", ['hi']],
    ["'a,b,c'.split(',')", ['a', 'b', 'c']],
    ["'a'.split(',')", ['a']],
    ["('a' | 'b' | 'c').join(',')", ['a,b,c']],
    ["('a' | 'b').join()", ['ab']],
    ["{}.join(',')", []],
    ["'abc'.encode('base64')", ['YWJj']],
    ["'YWJj'.decode('base64')", ['abc']],
    ["'ab?'.encode('urlbase64')", ['YWI_']],
    ["'YWI_'.decode('urlbase64')", ['ab?']],
    ["'abc'.encode('hex')", ['616263']],
    ["'616263'.decode('hex')", ['abc']],
    ["'abc'.encode('ascii')", ['abc']],
    ["'café 🔥!'.encode('ascii')", ['caf? ?!']],
    ["'\\u007f\\u0080'.encode('ascii')", ['\u007f?']],
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

  // Characters are Unicode scalar values, so a surrogate pair counts as one.
  it.each([
    ["'a🔥b'.length()", [3]],
    ["'a\\uD83D\\uDD25b'.length()", [3]],
    ["'e\\u0301'.length()", [2]],
    ["'a🔥b'.indexOf('b')", [2]],
    ["'a🔥b'.indexOf('🔥')", [1]],
    ["'a🔥b'.indexOf('x')", [-1]],
    ["'a🔥b🔥c'.lastIndexOf('🔥')", [3]],
    ["'a🔥b'.lastIndexOf('')", [3]],
    ["'a🔥b'.substring(1, 1)", ['🔥']],
    ["'a🔥b'.substring(2)", ['b']],
    ["'a🔥b'.substring(3)", []],
    ["'a🔥b'.toChars()", ['a', '🔥', 'b']],
    ["'a🔥c'.replace('', 'x')", ['xax🔥xcx']],
    // Indexing selects from the collection; a string is one item.
    ["'a🔥b'[0]", ['a🔥b']],
  ])('counts characters as scalar values: %s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it.each([
    ["'&#65;&#x42;&#X43;'.unescape('html')", ['ABC']],
    ["'caf&#233; &#128512;'.unescape('html')", ['café 😀']],
    // Only the named references escape('html') writes; not Object.prototype's names.
    ["'&constructor;'.unescape('html')", ['&constructor;']],
    ["'&#39;&lt;&gt;&quot;&amp;'.unescape('html')", ['\'<>"&']],
    // One pass: a decoded ampersand does not start another reference.
    ["'&amp;#65;&amp;lt;'.unescape('html')", ['&#65;&lt;']],
    // References to no scalar value and unknown names stay as written.
    ["'&#xD800;&#1114112;&nbsp;&#;'.unescape('html')", ['&#xD800;&#1114112;&nbsp;&#;']],
  ])('decodes HTML character references: %s -> %j', (expression, expected) => {
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
    // ascii is lossy, so it has no decode counterpart.
    expect(() => evaluate("'a'.decode('ascii')")).toThrow("decode() does not support the format 'ascii'")
    expect(() => evaluate("'!!'.decode('base64')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'xyz'.decode('hex')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.escape('xml')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.unescape('xml')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'\\\\q'.unescape('json')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.matches('[')")).toThrow('invalid regular expression')
  })

  it('rejects regex flags other than i and m', () => {
    expect(() => evaluate("'a'.matches('a', 'g')")).toThrow("matches() received an invalid regex flag 'g'")
    expect(() => evaluate("'a'.matchesFull('a', 'is')")).toThrow("matchesFull() received an invalid regex flag 's'")
    expect(() => evaluate("'a'.replaceMatches('a', 'b', 'x')")).toThrow(FhirPathTypeError)
    // The flags are checked even when the pattern is empty.
    expect(() => evaluate("'a'.replaceMatches('', 'b', 'x')")).toThrow(FhirPathTypeError)
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
    ["'-9223372036854775808'.toLong()", [-9223372036854775808n]],
    ['true.toLong()', [1n]],
    ['1.5.toLong()', []],
    ["'12'.convertsToLong()", [true]],
    // One past the signed 64-bit range in either direction: neither convertible nor
    // silently truncated.
    ["'9223372036854775808'.toLong()", []],
    ["'9223372036854775808'.convertsToLong()", [false]],
    ["'-9223372036854775809'.toLong()", []],
    ["'99999999999999999999999999999'.toLong()", []],
    ["'99999999999999999999999999999'.convertsToLong()", [false]],

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
    // With a unit argument, convertible exactly when toQuantity(unit) succeeds.
    ["4.5 'mg'.convertsToQuantity('mg')", [true]],
    ["4.5 'mg'.convertsToQuantity('kg')", [true]],
    ["4.5 'mg'.convertsToQuantity('cm')", [false]],
    ["4.5 'mg'.convertsToQuantity('s')", [false]],
    ["'x'.convertsToQuantity('mg')", [false]],
    ["{}.convertsToQuantity('mg')", []],
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
    expect(() => evaluate("4.5 'mg'.convertsToQuantity(1)")).toThrow(FhirPathTypeError)
  })
})

describe('date conversion formats', () => {
  it.each([
    // Spec examples.
    ["'150124'.toDate('ddMMyy')", '2024-01-15'],
    ["'15-01-2024'.toDate('dd-MM-yyyy')", '2024-01-15'],
    ["'12-27'.toDate('MM-yy')", '2027-12'],
    // hfs case.
    ["'01/15/2025'.toDate('MM/dd/yyyy')", '2025-01-15'],
    ["'99'.toDate('yy')", '1999'],
    ["'1/5/2025'.toDate('M/d/yyyy')", '2025-01-05'],
    ["'15 Jan 2024'.toDate('dd MMM yyyy')", '2024-01-15'],
    ["'15 JANUARY 2024'.toDate('dd MMMM yyyy')", '2024-01-15'],
    // Time components a Date cannot hold are read and dropped.
    ["'2024-01-15 10:30'.toDate('yyyy-MM-dd HH:mm')", '2024-01-15'],
    ["'2024-01-15 10:30'.toDateTime('yyyy-MM-dd HH:mm')", '2024-01-15T10:30'],
    ["'01/15/2025 3:04:05.123 PM -0500'.toDateTime('MM/dd/yyyy h:mm:ss.SSS a Z')", '2025-01-15T15:04:05.123-05:00'],
    ["'2025-01-15T12:00Z'.toDateTime('yyyy-MM-ddTHH:mmZ')", '2025-01-15T12:00Z'],
    ["'2025-01-15 12:00 +05:30'.toDateTime('yyyy-MM-dd HH:mm Z')", '2025-01-15T12:00+05:30'],
    ["'2025-01-01 12 AM'.toDateTime('yyyy-MM-dd h a')", '2025-01-01T00'],
    ["'2025-01-01 12 p'.toDateTime('yyyy-MM-dd h a')", '2025-01-01T12'],
    ["'2025-01-01 10:00:00.5'.toDateTime('yyyy-MM-dd HH:mm:ss.S')", '2025-01-01T10:00:00.5'],
    // `z` takes the zone's offset at the date and time read.
    ["'2025-01-15 10:30 America/New_York'.toDateTime('yyyy-MM-dd HH:mm z')", '2025-01-15T10:30-05:00'],
    ["'2025-07-15 10:30 America/New_York'.toDateTime('yyyy-MM-dd HH:mm z')", '2025-07-15T10:30-04:00'],
    ["'2025-07-15 10 Asia/Kolkata'.toDateTime('yyyy-MM-dd HH z')", '2025-07-15T10+05:30'],
    ["'2025-07-15 10:30 UTC'.toDateTime('yyyy-MM-dd HH:mm z')", '2025-07-15T10:30Z'],
    ["'2025-07-15 3 PM Etc/GMT+5'.toDateTime('yyyy-MM-dd h a z')", '2025-07-15T15-05:00'],
    ["'2025-07-15 10:30 America/New_York'.toDate('yyyy-MM-dd HH:mm z')", '2025-07-15'],
    // A wall time that happens twice takes the earlier instant.
    ["'2025-11-02 01:30 America/New_York'.toDateTime('yyyy-MM-dd HH:mm z')", '2025-11-02T01:30-04:00'],
  ])('%s -> %s', (expression, expected) => {
    expect(evaluate(expression).map(String)).toEqual([expected])
  })

  it('gives empty for text that does not match the format', () => {
    expect(evaluate("'2024-13'.toDate('yyyy-MM')")).toEqual([])
    expect(evaluate("'2024-02-30'.toDate('yyyy-MM-dd')")).toEqual([])
    expect(evaluate("'2024/01/15'.toDate('yyyy-MM-dd')")).toEqual([])
    // Literal characters match exactly, case included.
    expect(evaluate("'2025-01-15t12:00'.toDateTime('yyyy-MM-ddTHH:mm')")).toEqual([])
    expect(evaluate("'2025-01-01 13 PM'.toDateTime('yyyy-MM-dd h a')")).toEqual([])
    expect(evaluate("'150124'.convertsToDate('ddMMyy')")).toEqual([true])
    expect(evaluate("'150124'.convertsToDate()")).toEqual([false])
    expect(evaluate("'2024-01-15'.convertsToDateTime('dd-MM-yyyy')")).toEqual([false])
  })

  it('gives empty for a time zone it cannot resolve', () => {
    const read = (text: string) => evaluate(`'${text}'.toDateTime('yyyy-MM-dd HH:mm z')`)
    // Abbreviations and names are not ids, and Intl does not know Foo/Bar.
    expect(read('2025-01-15 10:30 PST')).toEqual([])
    expect(read('2025-01-15 10:30 Pacific Standard Time')).toEqual([])
    expect(read('2025-01-15 10:30 Foo/Bar')).toEqual([])
    // A forward transition skips the wall time.
    expect(read('2025-03-09 02:30 America/New_York')).toEqual([])
    // Local mean time is not a whole number of minutes.
    expect(read('1850-01-01 10:00 America/New_York')).toEqual([])
  })

  it('ignores the format for other inputs and for an empty format', () => {
    expect(evaluate("@2024-01-15T23:30:00-05:00.toDate('yyyy')").map(String)).toEqual(['2024-01-15'])
    expect(evaluate("@2024-01-15.toDateTime('MM-yy')").map(String)).toEqual(['2024-01-15'])
    expect(evaluate("1.toDate('nonsense')")).toEqual([])
    expect(evaluate("'2024'.toDate({})").map(String)).toEqual(['2024'])
  })

  it('rejects formats a conversion cannot use', () => {
    expect(() => evaluate("'x'.toDate('MM-dd')")).toThrow("toDate() received an invalid format 'MM-dd': it has no year")
    expect(() => evaluate("'x'.toDate('dd-yyyy')")).toThrow('it gives the day but no month')
    expect(() => evaluate("'x'.toDate('yyy')")).toThrow("'yyy' is not a format code")
    expect(() => evaluate("'x'.toDate('yyyy-MM-ddyyyy')")).toThrow('it gives the year more than once')
    expect(() => evaluate("'x'.toDateTime('yyyy z')")).toThrow("the time zone code 'z' needs an hour")
    expect(() => evaluate("'x'.toDateTime('yyyy-MM-dd HH zz')")).toThrow("'zz' is not a format code")
    expect(() => evaluate("'x'.toDateTime('yyyy-MM-dd HH z Z')")).toThrow('it gives the zone more than once')
    expect(() => evaluate("'x'.toDateTime('yyyy-MM-dd h')")).toThrow("need the AM/PM code 'a'")
    expect(() => evaluate("'x'.toDateTime('yyyy-MM-dd HH a')")).toThrow("the AM/PM code 'a' needs 'h' or 'hh'")
    expect(() => evaluate("'x'.toDateTime('yyyy Z')")).toThrow("the time zone code 'Z' needs an hour")
    expect(() => evaluate("'2024'.toDate(1)")).toThrow(FhirPathTypeError)
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

describe('pluggable regex engine (EvaluateOptions.regex)', () => {
  // A stub engine that recognizes exactly one pattern, to prove the hook is used.
  const stub = {
    compile(pattern: string, flags: string) {
      if (pattern.includes('[')) {
        throw new Error('unsupported')
      }
      return {
        test: (subject: string) => subject === `${pattern}:${flags}`,
        replace: (subject: string, substitution: string) => `${subject}|${substitution}|${flags}`,
      }
    },
  }

  it('routes matches/matchesFull/replaceMatches through the supplied engine', () => {
    expect(evaluate("'abc:s'.matches('abc')", undefined, { regex: stub })).toEqual([true])
    expect(evaluate("'abc'.matches('abc')", undefined, { regex: stub })).toEqual([false])
    expect(evaluate("'^(?:abc)$:s'.matchesFull('abc')", undefined, { regex: stub })).toEqual([true])
    expect(evaluate("'x'.replaceMatches('abc', 'y')", undefined, { regex: stub })).toEqual(['x|y|gs'])
    expect(evaluate("'x'.replaceMatches('abc', '${n}${1}')", undefined, { regex: stub })).toEqual(['x|$<n>$01|gs'])
    expect(evaluate("'abc:smi'.matches('abc', 'mi')", undefined, { regex: stub })).toEqual([true])
    expect(evaluate("'x'.replaceMatches('abc', 'y', 'i')", undefined, { regex: stub })).toEqual(['x|y|gsi'])
  })

  it('compile failures surface as the spec invalid-regex type error', () => {
    expect(() => evaluate("'a'.matches('[')", undefined, { regex: stub })).toThrow(FhirPathTypeError)
    expect(() => evaluate("'a'.matches('[')", undefined, { regex: stub })).toThrow('invalid regular expression')
  })

  it('without the option, the built-in RegExp still runs', () => {
    expect(evaluate("'abc'.matches('a.c')")).toEqual([true])
  })
})
