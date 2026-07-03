import { describe, expect, it } from 'vitest'
import { FhirPathSyntaxError } from '../errors'
import { stripSpans } from '../testing/strip-spans'
import { parse } from './parser'

function ast(source: string): unknown {
  return stripSpans(parse(source))
}

describe('literals', () => {
  it('parses booleans', () => {
    expect(ast('true')).toEqual({ kind: 'boolean', value: true })
    expect(ast('false')).toEqual({ kind: 'boolean', value: false })
  })

  it('parses strings', () => {
    expect(ast("'abc'")).toEqual({ kind: 'string', value: 'abc' })
  })

  it('parses integers and decimals with the raw text kept', () => {
    expect(ast('42')).toEqual({ kind: 'number', text: '42', isDecimal: false })
    expect(ast('3.14')).toEqual({ kind: 'number', text: '3.14', isDecimal: true })
  })

  it('parses the empty collection {}', () => {
    expect(ast('{}')).toEqual({ kind: 'null' })
    expect(ast('{ }')).toEqual({ kind: 'null' })
  })

  it('parses date, dateTime, and time literals', () => {
    expect(ast('@2014-01')).toEqual({ kind: 'date', text: '2014-01' })
    expect(ast('@2014-01-25T14:30:00Z')).toEqual({ kind: 'dateTime', text: '2014-01-25T14:30:00Z' })
    expect(ast('@2014T')).toEqual({ kind: 'dateTime', text: '2014T' })
    expect(ast('@T14:30')).toEqual({ kind: 'time', text: '14:30' })
  })

  it('parses UCUM quantities', () => {
    expect(ast("4.5 'mg'")).toEqual({ kind: 'quantity', value: '4.5', unit: 'mg', unitKind: 'ucum' })
  })

  it('parses calendar duration quantities', () => {
    expect(ast('4 days')).toEqual({ kind: 'quantity', value: '4', unit: 'days', unitKind: 'calendar' })
    expect(ast('1 year')).toEqual({ kind: 'quantity', value: '1', unit: 'year', unitKind: 'calendar' })
  })

  it('does not treat other identifiers as quantity units', () => {
    expect(() => parse('4 items')).toThrow(FhirPathSyntaxError)
  })
})

describe('paths, calls, and indexers', () => {
  it('parses a dotted path left-associatively', () => {
    expect(ast('Patient.name.given')).toEqual({
      kind: 'dot',
      left: {
        kind: 'dot',
        left: { kind: 'identifier', name: 'Patient' },
        right: { kind: 'identifier', name: 'name' },
      },
      right: { kind: 'identifier', name: 'given' },
    })
  })

  it('parses delimited identifiers as path segments', () => {
    expect(ast('`PID-1`.`val`')).toEqual({
      kind: 'dot',
      left: { kind: 'identifier', name: 'PID-1' },
      right: { kind: 'identifier', name: 'val' },
    })
  })

  it('parses operator keywords as element names after a dot', () => {
    expect(ast('text.div')).toEqual({
      kind: 'dot',
      left: { kind: 'identifier', name: 'text' },
      right: { kind: 'identifier', name: 'div' },
    })
  })

  it('parses keyword-named functions after a dot', () => {
    expect(ast("'abc'.contains('b')")).toEqual({
      kind: 'dot',
      left: { kind: 'string', value: 'abc' },
      right: { kind: 'call', name: 'contains', args: [{ kind: 'string', value: 'b' }] },
    })
  })

  it('parses standalone function calls', () => {
    expect(ast('exists()')).toEqual({ kind: 'call', name: 'exists', args: [] })
    expect(ast('iif(true, 1, 2)')).toEqual({
      kind: 'call',
      name: 'iif',
      args: [
        { kind: 'boolean', value: true },
        { kind: 'number', text: '1', isDecimal: false },
        { kind: 'number', text: '2', isDecimal: false },
      ],
    })
  })

  it('parses indexers over paths', () => {
    expect(ast('name[0].given')).toEqual({
      kind: 'dot',
      left: {
        kind: 'indexer',
        target: { kind: 'identifier', name: 'name' },
        index: { kind: 'number', text: '0', isDecimal: false },
      },
      right: { kind: 'identifier', name: 'given' },
    })
  })

  it('parses special variables, also after a dot', () => {
    expect(ast('$this')).toEqual({ kind: 'special', name: 'this' })
    expect(ast('a.$index')).toEqual({
      kind: 'dot',
      left: { kind: 'identifier', name: 'a' },
      right: { kind: 'special', name: 'index' },
    })
  })

  it('parses external constants in all three spellings', () => {
    expect(ast('%ucum')).toEqual({ kind: 'external', name: 'ucum' })
    expect(ast('%`vs-zip`')).toEqual({ kind: 'external', name: 'vs-zip' })
    expect(ast("%'us-zip'")).toEqual({ kind: 'external', name: 'us-zip' })
  })
})

describe('operator precedence', () => {
  function binary(operator: string, left: unknown, right: unknown): unknown {
    return { kind: 'binary', operator, left, right }
  }
  const n = (text: string): unknown => ({ kind: 'number', text, isDecimal: false })
  const id = (name: string): unknown => ({ kind: 'identifier', name })

  it('dot binds tighter than indexer chains resolve left to right', () => {
    expect(ast('a.b[0]')).toEqual({
      kind: 'indexer',
      target: { kind: 'dot', left: id('a'), right: id('b') },
      index: n('0'),
    })
  })

  it('unary minus binds looser than dot: -1.abs() negates the call result', () => {
    expect(ast('-1.abs()')).toEqual({
      kind: 'unary',
      operator: '-',
      operand: { kind: 'dot', left: n('1'), right: { kind: 'call', name: 'abs', args: [] } },
    })
  })

  it('unary binds tighter than multiplication', () => {
    expect(ast('-1 * 2')).toEqual(binary('*', { kind: 'unary', operator: '-', operand: n('1') }, n('2')))
  })

  it('multiplicative binds tighter than additive', () => {
    expect(ast('1 + 2 * 3')).toEqual(binary('+', n('1'), binary('*', n('2'), n('3'))))
    expect(ast('1 - 2 div 3')).toEqual(binary('-', n('1'), binary('div', n('2'), n('3'))))
    expect(ast('1 mod 2 & 3')).toEqual(binary('&', binary('mod', n('1'), n('2')), n('3')))
  })

  it('additive binds tighter than is/as', () => {
    expect(ast('a + b is C')).toEqual({
      kind: 'typeOp',
      operator: 'is',
      operand: binary('+', id('a'), id('b')),
      type: { parts: ['C'] },
    })
  })

  it('is/as binds tighter than union', () => {
    expect(ast('a as B | c')).toEqual(
      binary('|', { kind: 'typeOp', operator: 'as', operand: id('a'), type: { parts: ['B'] } }, id('c'))
    )
  })

  it('union binds tighter than comparison', () => {
    expect(ast('1 < 2 | 3')).toEqual(binary('<', n('1'), binary('|', n('2'), n('3'))))
  })

  it('comparison binds tighter than equality', () => {
    expect(ast('1 = 2 < 3')).toEqual(binary('=', n('1'), binary('<', n('2'), n('3'))))
  })

  it('equality binds tighter than in/contains', () => {
    expect(ast('a = b in c')).toEqual(binary('in', binary('=', id('a'), id('b')), id('c')))
  })

  it('in/contains binds tighter than and', () => {
    expect(ast('a in b and c')).toEqual(binary('and', binary('in', id('a'), id('b')), id('c')))
  })

  it('and binds tighter than xor/or', () => {
    expect(ast('a or b and c')).toEqual(binary('or', id('a'), binary('and', id('b'), id('c'))))
    expect(ast('a xor b and c')).toEqual(binary('xor', id('a'), binary('and', id('b'), id('c'))))
  })

  it('xor/or binds tighter than implies', () => {
    expect(ast('a implies b or c')).toEqual(binary('implies', id('a'), binary('or', id('b'), id('c'))))
  })

  it('binary operators are left-associative', () => {
    expect(ast('1 - 2 - 3')).toEqual(binary('-', binary('-', n('1'), n('2')), n('3')))
    expect(ast('a implies b implies c')).toEqual(binary('implies', binary('implies', id('a'), id('b')), id('c')))
    expect(ast('a xor b or c')).toEqual(binary('or', binary('xor', id('a'), id('b')), id('c')))
  })

  it('parentheses override precedence', () => {
    expect(ast('(1 + 2) * 3')).toEqual(binary('*', binary('+', n('1'), n('2')), n('3')))
  })
})

describe('type specifiers', () => {
  it('parses qualified type names', () => {
    expect(ast('value is System.Boolean')).toEqual({
      kind: 'typeOp',
      operator: 'is',
      operand: { kind: 'identifier', name: 'value' },
      type: { parts: ['System', 'Boolean'] },
    })
  })

  it('qualified type names are greedy: value as Quantity.unit is one type name', () => {
    expect(ast('value as Quantity.unit')).toEqual({
      kind: 'typeOp',
      operator: 'as',
      operand: { kind: 'identifier', name: 'value' },
      type: { parts: ['Quantity', 'unit'] },
    })
  })

  it('parenthesized as-casts allow further navigation', () => {
    expect(ast('(value as Quantity).unit')).toEqual({
      kind: 'dot',
      left: {
        kind: 'typeOp',
        operator: 'as',
        operand: { kind: 'identifier', name: 'value' },
        type: { parts: ['Quantity'] },
      },
      right: { kind: 'identifier', name: 'unit' },
    })
  })

  it('rejects a missing type name', () => {
    expect(() => parse('a is 5')).toThrow("Expected a type name, got '5'")
  })
})

describe('syntax errors', () => {
  it.each([
    ['', 'Unexpected end of expression'],
    ['a +', 'Unexpected end of expression'],
    ['(a', "Expected ')'"],
    ['a[1', "Expected ']'"],
    ['f(a,', 'Unexpected end of expression'],
    ['{', "Expected '}'"],
    ['{a}', "Expected '}'"],
    ['a b', "Unexpected 'b' after expression"],
    ['a.', "Expected an element or function name after '.'"],
    ['a.5', "Expected an element or function name after '.'"],
    ['%', 'Expected a name after %'],
    ['*a', "Unexpected '*'"],
    ['and', "Unexpected 'and'"],
    ['a.true', "Expected an element or function name after '.'"],
    ['(a)(b)', 'Unexpected parentheses'],
    [',5', "Unexpected ','"],
    [')', "Unexpected ')'"],
    ['2 + 2 /* not finished', 'Unterminated comment'],
  ])('rejects %j', (source, message) => {
    expect(() => parse(source)).toThrow(message)
  })

  it('reports the position of the offending token', () => {
    try {
      parse('Patient.name.')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(FhirPathSyntaxError)
      expect((error as FhirPathSyntaxError).span.column).toBe(14)
    }
  })
})

describe('spans', () => {
  it('covers the whole construct', () => {
    const node = parse('a + b')
    expect(node.span).toMatchObject({ start: 0, end: 5 })
  })

  it('keeps token spans on leaves', () => {
    const node = parse('Patient.name')
    expect(node.kind).toBe('dot')
    if (node.kind === 'dot') {
      expect(node.left.span).toMatchObject({ start: 0, end: 7 })
      expect(node.right.span).toMatchObject({ start: 8, end: 12 })
    }
  })
})
