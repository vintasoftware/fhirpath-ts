import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { SourceSpan } from '../errors.ts'
import { CALENDAR_DURATION_UNITS, KEYWORDS } from '../lexer/tokens.ts'
import { stripSpans } from '../testing/strip-spans.ts'
import type { AstNode } from './ast.ts'
import { parse } from './parser.ts'
import { printExpression } from './printer.ts'

/**
 * Property-based round-trip: for any parser-shaped AST, printExpression()
 * must render text that parses back to the identical tree. This exercises the
 * printer's precedence parenthesization and identifier/string/unit escaping
 * against the whole grammar, not just curated cases.
 *
 * "Parser-shaped" means the arbitrary only builds trees the parser itself can
 * produce — e.g. the right side of a dot is an invocation (identifier, call,
 * $-variable), never an arbitrary expression.
 */

const SPAN: SourceSpan = { start: 0, end: 0, line: 1, column: 1 }

// Any name at all round-trips: the printer backtick-quotes what plain
// identifiers can't say (keywords included), so names are fuzzed hard.
const nameArb = fc.oneof(
  fc.constantFrom('name', 'given', 'family', 'value', 'div', 'contains', 'true', 'item'),
  fc.string({ minLength: 1 })
)

// Function and type names print unquoted, so they stay plain identifiers
// outside the lexer's reserved words (keywords and calendar duration units).
const RESERVED = new Set([...KEYWORDS, ...CALENDAR_DURATION_UNITS])
const plainNameArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name))

const intTextArb = fc.nat({ max: 1_000_000 }).map(String)
const decimalTextArb = fc
  .tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 999_999 }))
  .map(([whole, fraction]) => `${whole}.${fraction}`)

const numberArb = fc.oneof(
  intTextArb.map(text => ({ kind: 'number' as const, text, isDecimal: false, span: SPAN })),
  intTextArb.map(text => ({ kind: 'number' as const, text, isDecimal: false, isLong: true, span: SPAN })),
  decimalTextArb.map(text => ({ kind: 'number' as const, text, isDecimal: true, span: SPAN }))
)

const quantityArb = fc
  .tuple(
    fc.oneof(intTextArb, decimalTextArb),
    fc.oneof(
      fc.constantFrom(...CALENDAR_DURATION_UNITS).map(unit => ({ unit, unitKind: 'calendar' as const })),
      fc.string({ minLength: 1, maxLength: 8 }).map(unit => ({ unit, unitKind: 'ucum' as const }))
    )
  )
  .map(([value, { unit, unitKind }]) => ({ kind: 'quantity' as const, value, unit, unitKind, span: SPAN }))

const temporalArb = fc.oneof(
  fc.constantFrom('2014', '2014-01', '2014-01-25').map(text => ({ kind: 'date' as const, text, span: SPAN })),
  fc
    .constantFrom('2014T', '2015-02T', '2015-02-04T14', '2015-02-04T14:34:28Z', '2015-02-04T14:34:28.123+10:00')
    .map(text => ({ kind: 'dateTime' as const, text, span: SPAN })),
  fc.constantFrom('14', '14:30', '14:34:28', '14:34:28.123').map(text => ({ kind: 'time' as const, text, span: SPAN }))
)

const identifierArb = nameArb.map(name => ({ kind: 'identifier' as const, name, span: SPAN }))
const specialArb = fc
  .constantFrom('this' as const, 'index' as const, 'total' as const)
  .map(name => ({ kind: 'special' as const, name, span: SPAN }))
const externalArb = nameArb.map(name => ({ kind: 'external' as const, name, span: SPAN }))

const leafArb: fc.Arbitrary<AstNode> = fc.oneof(
  fc.constant({ kind: 'null' as const, span: SPAN }),
  fc.boolean().map(value => ({ kind: 'boolean' as const, value, span: SPAN })),
  fc.string().map(value => ({ kind: 'string' as const, value, span: SPAN })),
  numberArb,
  temporalArb,
  quantityArb,
  identifierArb,
  specialArb,
  externalArb
)

const BINARY_OPERATORS = [
  '*',
  '/',
  'div',
  'mod',
  '+',
  '-',
  '&',
  '|',
  '<',
  '>',
  '<=',
  '>=',
  '=',
  '~',
  '!=',
  '!~',
  'in',
  'contains',
  'and',
  'or',
  'xor',
  'implies',
] as const

const { expression } = fc.letrec<{ expression: AstNode; invocation: AstNode }>(tie => ({
  invocation: fc.oneof(
    identifierArb,
    specialArb,
    fc
      .tuple(plainNameArb, fc.array(tie('expression'), { maxLength: 3 }))
      .map(([name, args]) => ({ kind: 'call' as const, name, args, span: SPAN }))
  ),
  expression: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb,
    leafArb,
    fc
      .tuple(tie('expression'), tie('invocation'))
      .map(([left, right]) => ({ kind: 'dot' as const, left, right, span: SPAN })),
    fc
      .tuple(tie('expression'), tie('expression'))
      .map(([target, index]) => ({ kind: 'indexer' as const, target, index, span: SPAN })),
    fc
      .tuple(plainNameArb, fc.array(tie('expression'), { maxLength: 3 }))
      .map(([name, args]) => ({ kind: 'call' as const, name, args, span: SPAN })),
    fc
      .tuple(fc.constantFrom('+' as const, '-' as const), tie('expression'))
      .map(([operator, operand]) => ({ kind: 'unary' as const, operator, operand, span: SPAN })),
    fc
      .tuple(fc.constantFrom(...BINARY_OPERATORS), tie('expression'), tie('expression'))
      .map(([operator, left, right]) => ({ kind: 'binary' as const, operator, left, right, span: SPAN })),
    fc
      .tuple(
        fc.constantFrom('is' as const, 'as' as const),
        tie('expression'),
        fc.array(plainNameArb, { minLength: 1, maxLength: 2 })
      )
      .map(([operator, operand, parts]) => ({
        kind: 'typeOp' as const,
        operator,
        operand,
        type: { parts, span: SPAN },
        span: SPAN,
      }))
  ),
}))

describe('printer/parser round-trip fuzz', () => {
  it('printExpression() output parses back to the identical tree', () => {
    fc.assert(
      fc.property(expression, node => {
        const printed = printExpression(node)
        let reparsed: AstNode
        try {
          reparsed = parse(printed)
        } catch (error) {
          throw new Error(`failed to reparse ${JSON.stringify(printed)}: ${(error as Error).message}`)
        }
        expect(stripSpans(reparsed)).toEqual(stripSpans(node))
      }),
      // CI budget: 1000 fresh random cases per run (unseeded, so coverage
      // accumulates across runs); a one-off 20k-run sweep passed before landing.
      { numRuns: 1000 }
    )
  })
})
