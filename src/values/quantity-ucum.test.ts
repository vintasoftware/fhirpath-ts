import { describe, expect, it } from 'vitest'
import { evaluate } from '../api/evaluate'
import { canonicalizeUnit } from './ucum'

describe('unit canonicalization', () => {
  it('resolves prefixed units', () => {
    expect(canonicalizeUnit('mg')?.factor.toString()).toBe('0.001')
    expect(canonicalizeUnit('kg')?.factor.toString()).toBe('1000')
    expect(canonicalizeUnit('cm')?.factor.toString()).toBe('0.01')
    expect(canonicalizeUnit('ms')?.factor.toString()).toBe('0.001')
  })

  it('keeps atom matches ahead of prefix splits', () => {
    expect(canonicalizeUnit('min')?.dimensions).toEqual({ s: 1 })
    expect(canonicalizeUnit('min')?.factor.toString()).toBe('60')
    expect(canonicalizeUnit('mo')?.factor.toString()).toBe('2629800')
  })

  it('handles exponents and compound units', () => {
    expect(canonicalizeUnit('m2')?.dimensions).toEqual({ m: 2 })
    expect(canonicalizeUnit('cm2')?.factor.toString()).toBe('0.0001')
    expect(canonicalizeUnit('g/m')?.dimensions).toEqual({ g: 1, m: -1 })
    expect(canonicalizeUnit('kg.m/s2')?.dimensions).toEqual({ g: 1, m: 1, s: -2 })
    expect(canonicalizeUnit('m/m')?.dimensions).toEqual({})
  })

  it('handles volumes and dimensionless units', () => {
    expect(canonicalizeUnit('L')?.dimensions).toEqual({ m: 3 })
    expect(canonicalizeUnit('mL')?.factor.toString()).toBe('0.000001')
    expect(canonicalizeUnit('%')?.dimensions).toEqual({})
    expect(canonicalizeUnit('1')?.dimensions).toEqual({})
  })

  it('unknown units stay opaque', () => {
    expect(canonicalizeUnit('[s]')).toBeUndefined()
    expect(canonicalizeUnit('bananas')).toBeUndefined()
    expect(canonicalizeUnit('g/bananas')).toBeUndefined()
  })
})

describe('cross-unit quantity semantics', () => {
  it.each([
    ["1 'm' = 100 'cm'", [true]],
    ["1 'm' = 10 'cm'", [false]],
    ["4000.0 'mg' = 4.0 'g'", [true]],
    ["4040 'mg' = 4.0 'g'", [false]],
    ["1 'm' < 2 'cm'", [false]],
    ["18 'cm' < 1 'm'", [true]],
    ["1 '[in_i]' = 2.54 'cm'", [true]],
    ["185 '[lb_av]' > 80 'kg'", [true]],
    ["1 'm' = 1 's'", []],
    ["1 'bananas' = 1 'bananas'", [true]],
    ["1 'bananas' = 1 'apples'", []],
    ["1 'wk' = 7 'd'", [true]],
    ["1 'a' = 12 'mo'", [true]],
    ["1 'm' ~ 100 'cm'", [true]],
    ['1 week = 7 days', [true]],
    ['2 hours = 120 minutes', [true]],
    ['1 second = 1000 milliseconds', [true]],
    ['1 year = 365 days', []],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('addition aligns on the more granular unit', () => {
    expect(evaluate("1 'm' + 20 'cm'")).toEqual([{ value: 120, unit: 'cm' }])
    expect(evaluate("20 'cm' + 1 'm'")).toEqual([{ value: 120, unit: 'cm' }])
    expect(evaluate("1 'kg' - 100 'g'")).toEqual([{ value: 900, unit: 'g' }])
    expect(evaluate('1 year + 6 months')).toEqual([{ value: 18, unit: 'month' }])
    expect(evaluate('1 week + 1 day')).toEqual([{ value: 8, unit: 'day' }])
    expect(evaluate("1 'mg' + 1 'bananas'")).toEqual([])
    expect(evaluate('1 year + 1 day')).toEqual([])
    // Calendar week-and-below are exact UCUM twins, so mixed addition converts.
    expect(evaluate("1 day + 1 'd'")).toEqual([{ value: 2, unit: 'd' }])
    expect(evaluate("1 year + 1 'a'")).toEqual([])
  })

  it('multiplication and division compose units', () => {
    expect(evaluate("4.0 'g' / 2.0 'm'")).toEqual([{ value: 2, unit: 'g/m' }])
    expect(evaluate("4 'g' / 2 'g'")).toEqual([{ value: 2, unit: '1' }])
    expect(evaluate("2 'm' * 3 'm'")).toEqual([{ value: 6, unit: 'm.m' }])
    expect(evaluate("2 'm' * 3 '1'")).toEqual([{ value: 6, unit: 'm' }])
    expect(evaluate("2 '1' * 3 'm'")).toEqual([{ value: 6, unit: 'm' }])
    expect(evaluate("6 'm' / 3 '1'")).toEqual([{ value: 2, unit: 'm' }])
    expect(evaluate("4 'g' / 0 'm'")).toEqual([])
  })

  it('composed units compare through canonicalization', () => {
    expect(evaluate("(2 'm' * 3 'm') = 6 'm2'")).toEqual([true])
    expect(evaluate("(4.0 'g' / 2.0 'm') = 2 'g/m'")).toEqual([true])
  })

  it('toQuantity converts across comparable units', () => {
    expect(evaluate("1 '[in_i]'.toQuantity('cm')")).toEqual([{ value: 2.54, unit: 'cm' }])
    expect(evaluate("2 weeks.toQuantity('d')")).toEqual([{ value: 14, unit: 'd' }])
  })
})
