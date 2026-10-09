import { describe, expect, it } from 'vitest'

import { stripSpans } from '../testing/strip-spans.ts'
import { parse } from './parser.ts'
import { printExpression } from './printer.ts'

function roundTrip(source: string): void {
  const first = parse(source)
  const printed = printExpression(first)
  expect(stripSpans(parse(printed))).toEqual(stripSpans(first))
}

describe('canonical printing', () => {
  it.each([
    ['Patient.name.given', 'Patient.name.given'],
    ['Patient . name', 'Patient.name'],
    ["name.where(use = 'official').given.first()", "name.where(use = 'official').given.first()"],
    ['(1 + 2) * 3', '(1 + 2) * 3'],
    ['1 + 2 * 3', '1 + 2 * 3'],
    ['{}', '{}'],
    ['{ }', '{}'],
    ['-1.abs()', '-1.abs()'],
    ['(-1).abs()', '(-1).abs()'],
    ['a as B | c', 'a as B | c'],
    ['(a is System.Boolean).not()', '(a is System.Boolean).not()'],
    ["4.5 'mg'", "4.5 'mg'"],
    ['4 days', '4 days'],
    ['@2014-01-25T14:30:00Z', '@2014-01-25T14:30:00Z'],
    ['@T14:30', '@T14:30'],
    ['$this', '$this'],
    ['%ucum', '%ucum'],
    ['%`vs-zip`', '%`vs-zip`'],
    ["%'us-zip'", '%`us-zip`'],
    ['a.`div`', 'a.`div`'],
    ['text.div', 'text.`div`'],
    ["iif(true, 'a', 'b')", "iif(true, 'a', 'b')"],
    ['name[0] | contact.name', 'name[0] | contact.name'],
  ])('prints %j as %j', (source, expected) => {
    expect(printExpression(parse(source))).toBe(expected)
  })

  it('escapes strings when printing', () => {
    expect(printExpression(parse("'it\\'s\\n\\t\\\\'"))).toBe("'it\\'s\\n\\t\\\\'")
  })

  it('prints control characters as unicode escapes', () => {
    expect(printExpression(parse("'\\u0001'"))).toBe("'\\u0001'")
  })

  it('backticks identifiers that need it', () => {
    expect(printExpression(parse('`PID-1`'))).toBe('`PID-1`')
    expect(printExpression(parse('`plain`'))).toBe('plain')
  })
})

describe('print/parse round trips', () => {
  it.each([
    ["Patient.name.where(use = 'official').given.first()"],
    ['1 + 2 * 3 - 4 / 5 div 6 mod 7'],
    ['a and b or c xor d implies e'],
    ['a = b != c ~ d !~ e'],
    ['1 < 2 | 3 >= 4'],
    ['a in b contains c'],
    ['-a * +b'],
    ['- -a'],
    ['(a or b) and (c or d)'],
    ['value as Quantity.unit'],
    ['(value as Quantity).unit > 4 implies true'],
    ["Bundle.entry.resource.ofType(Patient).name.select(given.first() + ' ' + family)"],
    ["4 days + 2 weeks = 18 days and 4.5 'mg' < 5 'mg'"],
    ["%`vs-observation-vitalsignresult`.contains('x')"],
    ["name.given.aggregate($total + $this, '')"],
    ['@2014-01-25T14:30:00+11:00 > @2014-01-25'],
    ["'it\\'s' = 'it\\u0027s'"],
    ["contained.select(('#' + id in %resource.descendants().reference).not()).empty()"],
    ['`PID-1`[0].`odd name`.exists()'],
    ['x as `odd type`'],
    ['x is FHIR.`odd type` or y.ofType(Quantity)'],
  ])('round trips %j', roundTrip)
})
