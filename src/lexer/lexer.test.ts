import { describe, expect, it } from 'vitest'
import { FhirPathSyntaxError } from '../errors.ts'
import { tokenize } from './lexer.ts'
import type { Token, TokenKind } from './tokens.ts'

function kinds(source: string): TokenKind[] {
  return tokenize(source)
    .filter(token => token.kind !== 'end')
    .map(token => token.kind)
}

function single(source: string): Token {
  const tokens = tokenize(source)
  expect(tokens).toHaveLength(2)
  expect(tokens[1]?.kind).toBe('end')
  return tokens[0] as Token
}

function texts(source: string): string[] {
  return tokenize(source)
    .filter(token => token.kind !== 'end')
    .map(token => token.text)
}

describe('identifiers and keywords', () => {
  it.each([
    ['Patient', 'identifier'],
    ['name', 'identifier'],
    ['_id', 'identifier'],
    ['value2', 'identifier'],
    ['year', 'identifier'],
    ['months', 'identifier'],
    ['and', 'keyword'],
    ['or', 'keyword'],
    ['xor', 'keyword'],
    ['implies', 'keyword'],
    ['div', 'keyword'],
    ['mod', 'keyword'],
    ['in', 'keyword'],
    ['contains', 'keyword'],
    ['is', 'keyword'],
    ['as', 'keyword'],
    ['true', 'keyword'],
    ['false', 'keyword'],
  ] as const)('%s lexes as %s', (source, kind) => {
    const token = single(source)
    expect(token.kind).toBe(kind)
    expect(token.value).toBe(source)
  })

  it('keywords are case-sensitive: True is an identifier', () => {
    expect(single('True').kind).toBe('identifier')
  })

  it('splits paths into identifiers and dots', () => {
    expect(kinds('Patient.name.given')).toEqual(['identifier', 'punct', 'identifier', 'punct', 'identifier'])
  })
})

describe('delimited identifiers', () => {
  it('decodes a backtick identifier', () => {
    const token = single('`PID-1`')
    expect(token.kind).toBe('delimitedIdentifier')
    expect(token.value).toBe('PID-1')
    expect(token.text).toBe('`PID-1`')
  })

  it('resolves escapes inside backticks', () => {
    expect(single('`a\\`b`').value).toBe('a`b')
    expect(single('`a\\u0041`').value).toBe('aA')
  })

  it('rejects an empty delimited identifier', () => {
    expect(() => tokenize('``')).toThrow(FhirPathSyntaxError)
  })

  it('rejects an unterminated delimited identifier', () => {
    expect(() => tokenize('`abc')).toThrow('Unterminated delimited identifier')
  })
})

describe('string literals', () => {
  it('decodes a simple string', () => {
    const token = single("'hello'")
    expect(token.kind).toBe('string')
    expect(token.value).toBe('hello')
  })

  it('preserves an empty string', () => {
    expect(single("''").value).toBe('')
  })

  it.each([
    ["'\\''", "'"],
    ["'\\\"'", '"'],
    ["'\\`'", '`'],
    ["'\\/'", '/'],
    ["'\\\\'", '\\'],
    ["'\\f'", '\f'],
    ["'\\n'", '\n'],
    ["'\\r'", '\r'],
    ["'\\t'", '\t'],
    ["'\\u0041'", 'A'],
    ["'\\u00e9'", 'é'],
  ])('decodes escape %s', (source, expected) => {
    expect(single(source).value).toBe(expected)
  })

  it('decodes surrogate pairs from two unicode escapes', () => {
    expect(single("'\\ud83d\\ude00'").value).toBe('\u{1f600}')
  })

  it('keeps unicode characters that are not escaped', () => {
    expect(single("'café ❤'").value).toBe('café ❤')
  })

  it.each([["'\\p'"], ["'\\q'"], ["'\\0'"]])('rejects unknown escape %s', source => {
    expect(() => tokenize(source)).toThrow('Invalid escape sequence')
  })

  it('rejects a unicode escape with fewer than 4 hex digits', () => {
    expect(() => tokenize("'\\u12'")).toThrow('4 hex digits')
    expect(() => tokenize("'\\u12zz'")).toThrow('4 hex digits')
  })

  it('rejects an unterminated string', () => {
    expect(() => tokenize("'abc")).toThrow('Unterminated string literal')
  })

  it('rejects a string ending in a backslash', () => {
    expect(() => tokenize("'abc\\")).toThrow('Unterminated escape sequence')
  })
})

describe('numbers', () => {
  it.each([['0'], ['5'], ['42'], ['1000000']])('lexes integer %s', source => {
    const token = single(source)
    expect(token.kind).toBe('number')
    expect(token.value).toBe(source)
  })

  it.each([['0.0'], ['3.14'], ['0.00000001'], ['10.5']])('lexes decimal %s', source => {
    const token = single(source)
    expect(token.kind).toBe('number')
    expect(token.value).toBe(source)
  })

  it('does not eat the dot of a method call: 5.single()', () => {
    expect(kinds('5.single()')).toEqual(['number', 'punct', 'identifier', 'punct', 'punct'])
    expect(texts('5.single()')).toEqual(['5', '.', 'single', '(', ')'])
  })

  it('lexes 1.5.toString() with the decimal intact', () => {
    expect(texts('1.5.toString()')).toEqual(['1.5', '.', 'toString', '(', ')'])
  })

  it('has no exponent notation: 1e3 is number then identifier', () => {
    expect(kinds('1e3')).toEqual(['number', 'identifier'])
  })

  it('lexes .5 as dot then number, not a decimal', () => {
    expect(kinds('.5')).toEqual(['punct', 'number'])
  })

  it('a trailing dot at end of input stays a separate token', () => {
    expect(kinds('5.')).toEqual(['number', 'punct'])
  })
})

describe('date, dateTime, and time literals', () => {
  it.each([
    ['@2014', '2014'],
    ['@2014-01', '2014-01'],
    ['@2014-01-25', '2014-01-25'],
  ])('lexes date %s', (source, value) => {
    const token = single(source)
    expect(token.kind).toBe('date')
    expect(token.value).toBe(value)
  })

  it.each([
    ['@2014T', '2014T'],
    ['@2014-01T', '2014-01T'],
    ['@2014-01-25T', '2014-01-25T'],
    ['@2014-01-25T14', '2014-01-25T14'],
    ['@2014-01-25T14:30', '2014-01-25T14:30'],
    ['@2014-01-25T14:30:14', '2014-01-25T14:30:14'],
    ['@2014-01-25T14:30:14.559', '2014-01-25T14:30:14.559'],
    ['@2014-01-25T14:30:14.559Z', '2014-01-25T14:30:14.559Z'],
    ['@2014-01-25T14:30+11:00', '2014-01-25T14:30+11:00'],
    ['@2014-01-25T14:30:00-05:00', '2014-01-25T14:30:00-05:00'],
    ['@2015-02-04T14:34:28Z', '2015-02-04T14:34:28Z'],
  ])('lexes dateTime %s', (source, value) => {
    const token = single(source)
    expect(token.kind).toBe('dateTime')
    expect(token.value).toBe(value)
  })

  it.each([
    ['@T14', '14'],
    ['@T14:30', '14:30'],
    ['@T14:30:14', '14:30:14'],
    ['@T14:30:14.559', '14:30:14.559'],
  ])('lexes time %s', (source, value) => {
    const token = single(source)
    expect(token.kind).toBe('time')
    expect(token.value).toBe(value)
  })

  it('treats an incomplete month as subtraction: @2014-5', () => {
    expect(kinds('@2014-5')).toEqual(['date', 'operator', 'number'])
  })

  it('treats an incomplete day as subtraction: @2014-01-5', () => {
    expect(kinds('@2014-01-5')).toEqual(['date', 'operator', 'number'])
  })

  it('treats a lone +/- after a time as an operator', () => {
    expect(kinds('@2014-01-01T10:00 + 3')).toEqual(['dateTime', 'operator', 'number'])
    expect(kinds('@2014-01-01T10:00-3')).toEqual(['dateTime', 'operator', 'number'])
  })

  it('does not attach a timezone to a bare T dateTime: @2014TZ', () => {
    expect(kinds('@2014TZ')).toEqual(['dateTime', 'identifier'])
    expect(texts('@2014TZ')).toEqual(['@2014T', 'Z'])
  })

  it('time literals have no timezone: @T10:00-05:00 fails on the stray colon', () => {
    expect(kinds('@T10:00-05')).toEqual(['time', 'operator', 'number'])
    expect(() => tokenize('@T10:00-05:00')).toThrow("Unexpected character ':'")
  })

  it.each([['@'], ['@20'], ['@201'], ['@T'], ['@Tabc'], ['@abcd']])('rejects malformed literal %s', source => {
    expect(() => tokenize(source)).toThrow(FhirPathSyntaxError)
  })

  it('handles truncation at end of input', () => {
    expect(kinds('@T12:00:00.')).toEqual(['time', 'punct'])
    expect(kinds('@2014-01-01T10:00+')).toEqual(['dateTime', 'operator'])
    expect(kinds('@2014-')).toEqual(['date', 'operator'])
  })
})

describe('special variables', () => {
  it.each([
    ['$this', 'this'],
    ['$index', 'index'],
    ['$total', 'total'],
  ])('lexes %s', (source, value) => {
    const token = single(source)
    expect(token.kind).toBe('specialVariable')
    expect(token.value).toBe(value)
  })

  it('rejects unknown special variables', () => {
    expect(() => tokenize('$foo')).toThrow('Unknown special variable $foo')
    expect(() => tokenize('$')).toThrow('Unknown special variable $')
  })
})

describe('operators and punctuation', () => {
  it.each([
    ['='],
    ['~'],
    ['<'],
    ['>'],
    ['+'],
    ['-'],
    ['*'],
    ['/'],
    ['|'],
    ['&'],
    ['!='],
    ['!~'],
    ['<='],
    ['>='],
  ])('lexes operator %s', source => {
    const token = single(source)
    expect(token.kind).toBe('operator')
    expect(token.value).toBe(source)
  })

  it.each([['('], [')'], ['['], [']'], ['{'], ['}'], ['.'], [','], ['%']])('lexes punctuation %s', source => {
    const token = single(source)
    expect(token.kind).toBe('punct')
    expect(token.value).toBe(source)
  })

  it('prefers two-character operators over one: a<=b', () => {
    expect(texts('a<=b')).toEqual(['a', '<=', 'b'])
  })

  it('rejects a bare exclamation mark', () => {
    expect(() => tokenize('a ! b')).toThrow("Unexpected character '!'")
  })

  it('rejects unknown characters', () => {
    expect(() => tokenize('a # b')).toThrow("Unexpected character '#'")
    expect(() => tokenize('a ; b')).toThrow("Unexpected character ';'")
  })

  it('lexes the empty collection {} as two puncts', () => {
    expect(kinds('{}')).toEqual(['punct', 'punct'])
  })

  it('lexes external constants as percent then name', () => {
    expect(kinds('%ucum')).toEqual(['punct', 'identifier'])
    expect(kinds("%'us-zip'")).toEqual(['punct', 'string'])
    expect(kinds('%`us-zip`')).toEqual(['punct', 'delimitedIdentifier'])
  })
})

describe('whitespace and comments', () => {
  it('skips spaces, tabs, newlines, carriage returns, and form feeds', () => {
    expect(kinds(' \t\r\n\fa \t b ')).toEqual(['identifier', 'identifier'])
  })

  it('skips line comments', () => {
    expect(texts('a // rest of line\n.b')).toEqual(['a', '.', 'b'])
  })

  it('a line comment at the end of input needs no newline', () => {
    expect(texts('a // done')).toEqual(['a'])
  })

  it('skips block comments, including multi-line ones', () => {
    expect(texts('a /* x */ .b')).toEqual(['a', '.', 'b'])
    expect(texts('a /* line1\nline2 */ .b')).toEqual(['a', '.', 'b'])
  })

  it('rejects an unterminated block comment', () => {
    expect(() => tokenize('a /* never closed')).toThrow('Unterminated comment')
  })

  it('an empty expression yields only the end token', () => {
    const tokens = tokenize('')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.kind).toBe('end')
  })

  it('a comment-only expression yields only the end token', () => {
    expect(kinds('// nothing')).toEqual([])
    expect(kinds('/* nothing */')).toEqual([])
  })
})

describe('spans and error positions', () => {
  it('records offsets and 1-based line/column on tokens', () => {
    const tokens = tokenize('name.given')
    expect(tokens[0]?.span).toEqual({ start: 0, end: 4, line: 1, column: 1 })
    expect(tokens[1]?.span).toEqual({ start: 4, end: 5, line: 1, column: 5 })
    expect(tokens[2]?.span).toEqual({ start: 5, end: 10, line: 1, column: 6 })
  })

  it('tracks line numbers across newlines', () => {
    const tokens = tokenize('a\n  .b')
    expect(tokens[1]?.span.line).toBe(2)
    expect(tokens[1]?.span.column).toBe(3)
  })

  it('reports the error position in the message', () => {
    try {
      tokenize("a.where(name = 'unterminated")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(FhirPathSyntaxError)
      const syntaxError = error as FhirPathSyntaxError
      expect(syntaxError.span.line).toBe(1)
      expect(syntaxError.span.column).toBe(16)
      expect(syntaxError.message).toContain('line 1, column 16')
    }
  })
})

describe('realistic expressions', () => {
  it('lexes a where clause with a comparison', () => {
    expect(texts("Patient.name.where(use = 'official').given.first()")).toEqual([
      'Patient',
      '.',
      'name',
      '.',
      'where',
      '(',
      'use',
      '=',
      "'official'",
      ')',
      '.',
      'given',
      '.',
      'first',
      '(',
      ')',
    ])
  })

  it('lexes quantities as number followed by unit', () => {
    expect(kinds("4.5 'mg'")).toEqual(['number', 'string'])
    expect(kinds('4 days')).toEqual(['number', 'identifier'])
  })

  it('lexes indexers and unions', () => {
    expect(kinds('name[0] | contact.name')).toEqual([
      'identifier',
      'punct',
      'number',
      'punct',
      'operator',
      'identifier',
      'punct',
      'identifier',
    ])
  })

  it('lexes keyword-heavy expressions', () => {
    expect(kinds('value is Quantity and value as Quantity > 4 implies true')).toEqual([
      'identifier',
      'keyword',
      'identifier',
      'keyword',
      'identifier',
      'keyword',
      'identifier',
      'operator',
      'number',
      'keyword',
      'keyword',
    ])
  })
})
