import { describe, expect, it } from 'vitest'

import { analyzeExpression } from './analyze.ts'
import { hasNestedUnboundedQuantifier } from './regex-safety.ts'

describe('hasNestedUnboundedQuantifier', () => {
  it.each([
    ['(a+)+'],
    ['(a*)*'],
    ['(a+)*'],
    ['(\\d*)+'],
    ['(x|y+)*'],
    ['^(([a-z])+.)+[A-Z]([a-z])+$'],
    ['(a{2,})+'],
    ['(a+){3,}'],
    ['(?:a+)+'],
    ['((a)+)+'],
    ['(a+?)+'],
  ])('flags %s', pattern => {
    expect(hasNestedUnboundedQuantifier(pattern)).toBe(true)
  })

  it.each([
    ['a+'],
    ['a*b*c*'],
    ['(abc)+'],
    ['(a?)+'],
    ['(a+)?'],
    ['(a+){2,5}'],
    ['(a{2,5})+'],
    ['[a-z]+@[a-z]+\\.[a-z]{2,}'],
    ['\\(a+\\)+'],
    ['[(+*]+'],
    ['^\\d{4}-\\d{2}-\\d{2}$'],
    [''],
    ['('],
    ['a{,}'],
  ])('accepts %s', pattern => {
    expect(hasNestedUnboundedQuantifier(pattern)).toBe(false)
  })
})

describe('regex-backtracking analyzer warning', () => {
  const diagnostics = (expression: string) => analyzeExpression(expression)

  it('warns on ReDoS-prone literal patterns in the matches family', () => {
    for (const expression of ["'x'.matches('(a+)+')", "'x'.matchesFull('(a+)+')", "'x'.replaceMatches('(a+)+', 'y')"]) {
      const found = diagnostics(expression)
      expect(found.map(d => [d.severity, d.code])).toEqual([['warning', 'regex-backtracking']])
    }
  })

  it('stays quiet on benign patterns and non-literal arguments', () => {
    expect(diagnostics("'x'.matches('[a-z]+')")).toEqual([])
    expect(diagnostics("'x'.matches('a' & 'b')")).toEqual([])
  })
})
