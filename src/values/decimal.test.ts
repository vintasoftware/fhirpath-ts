import { describe, expect, it } from 'vitest'
import { Decimal } from './decimal.ts'

function decimal(text: string): Decimal {
  const parsed = Decimal.fromString(text)
  if (!parsed) {
    throw new Error(`bad decimal in test: ${text}`)
  }
  return parsed
}

describe('parsing and printing', () => {
  it.each([
    ['0'],
    ['1'],
    ['-1'],
    ['3.14'],
    ['-0.5'],
    ['0.00000001'],
    ['1.10'],
    ['1000000'],
  ])('round trips %s through toString', text => {
    expect(decimal(text).toString()).toBe(text)
  })

  it('keeps trailing zeros (they carry precision)', () => {
    const value = decimal('1.5870')
    expect(value.scale).toBe(4)
    expect(value.toString()).toBe('1.5870')
  })

  it('parses a leading plus', () => {
    expect(decimal('+2.5').toString()).toBe('2.5')
  })

  it('rejects garbage', () => {
    expect(Decimal.fromString('abc')).toBeUndefined()
    expect(Decimal.fromString('1.')).toBeUndefined()
    expect(Decimal.fromString('.5')).toBeUndefined()
    expect(Decimal.fromString('')).toBeUndefined()
  })

  it('accepts exponent notation for values arriving from JSON numbers', () => {
    expect(decimal('1e2').toString()).toBe('100')
    expect(decimal('1.5e2').toString()).toBe('150')
    expect(decimal('1.5e1').toString()).toBe('15')
    expect(decimal('1e-3').toString()).toBe('0.001')
    expect(decimal('2.5e-1').toString()).toBe('0.25')
  })

  it('converts from JS numbers', () => {
    expect(Decimal.fromNumber(0.1)?.toString()).toBe('0.1')
    expect(Decimal.fromNumber(1e21)?.toString()).toBe('1000000000000000000000')
    expect(Decimal.fromNumber(1e-7)?.toString()).toBe('0.0000001')
    expect(Decimal.fromNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(Decimal.fromNumber(Number.NaN)).toBeUndefined()
  })
})

describe('arithmetic', () => {
  it('adds exactly where floats cannot', () => {
    expect(decimal('0.1').add(decimal('0.2')).equals(decimal('0.3'))).toBe(true)
    expect(decimal('0.1').add(decimal('0.2')).toString()).toBe('0.3')
  })

  it('subtracts across scales', () => {
    expect(decimal('1').subtract(decimal('0.001')).toString()).toBe('0.999')
    expect(decimal('0.5').subtract(decimal('1')).toString()).toBe('-0.5')
  })

  it('multiplies with scale addition', () => {
    expect(decimal('1.5').multiply(decimal('2.5')).toString()).toBe('3.75')
    expect(decimal('0.1').multiply(decimal('0.1')).toString()).toBe('0.01')
  })

  it('divides exactly for terminating quotients', () => {
    expect(decimal('1').divide(decimal('2'))?.toString()).toBe('0.5')
    expect(decimal('3.75').divide(decimal('2.5'))?.toString()).toBe('1.5')
  })

  it('divides repeating quotients to long precision', () => {
    const third = decimal('1').divide(decimal('3'))
    expect(third?.toString().startsWith('0.33333333')).toBe(true)
  })

  it('divides by negative values with correct rounding', () => {
    expect(decimal('1').divide(decimal('-2'))?.toString()).toBe('-0.5')
    expect(decimal('1').divide(decimal('-3'))?.toString().startsWith('-0.33333333')).toBe(true)
  })

  it('returns empty for division by zero', () => {
    expect(decimal('1').divide(decimal('0'))).toBeUndefined()
    expect(decimal('1').integerDivide(decimal('0'))).toBeUndefined()
    expect(decimal('1').modulo(decimal('0'))).toBeUndefined()
  })

  it('integer division truncates toward zero', () => {
    expect(decimal('7').integerDivide(decimal('2'))?.toString()).toBe('3')
    expect(decimal('-7').integerDivide(decimal('2'))?.toString()).toBe('-3')
    expect(decimal('5.5').integerDivide(decimal('0.7'))?.toString()).toBe('7')
  })

  it('modulo keeps the sign of the dividend', () => {
    expect(decimal('7').modulo(decimal('2'))?.toString()).toBe('1')
    expect(decimal('-7').modulo(decimal('2'))?.toString()).toBe('-1')
    expect(decimal('5.5').modulo(decimal('0.7'))?.toString()).toBe('0.6')
  })

  it('negates and takes absolute values', () => {
    expect(decimal('1.5').negate().toString()).toBe('-1.5')
    expect(decimal('-1.5').abs().toString()).toBe('1.5')
    expect(decimal('1.5').abs().toString()).toBe('1.5')
  })
})

describe('comparison', () => {
  it('compares across scales', () => {
    expect(decimal('0.5').compare(decimal('0.50'))).toBe(0)
    expect(decimal('1.1').compare(decimal('1.09'))).toBe(1)
    expect(decimal('-2').compare(decimal('1'))).toBe(-1)
  })

  it('equality ignores trailing zeros', () => {
    expect(decimal('0.5').equals(decimal('0.500'))).toBe(true)
    expect(decimal('0.5').equals(decimal('0.51'))).toBe(false)
  })
})

describe('rounding', () => {
  it('rounds half away from zero', () => {
    expect(decimal('2.5').round().toString()).toBe('3')
    expect(decimal('-2.5').round().toString()).toBe('-3')
    expect(decimal('2.4').round().toString()).toBe('2')
    expect(decimal('3.14159').round(3).toString()).toBe('3.142')
  })

  it('rounding to a wider scale is a no-op', () => {
    expect(decimal('1.5').round(4).toString()).toBe('1.5')
  })

  it('truncates toward zero', () => {
    expect(decimal('1.9').truncate().toString()).toBe('1')
    expect(decimal('-1.9').truncate().toString()).toBe('-1')
  })

  it('ceiling and floor', () => {
    expect(decimal('1.1').ceiling().toString()).toBe('2')
    expect(decimal('-1.1').ceiling().toString()).toBe('-1')
    expect(decimal('1.9').floor().toString()).toBe('1')
    expect(decimal('-1.1').floor().toString()).toBe('-2')
    expect(decimal('2').ceiling().toString()).toBe('2')
    expect(decimal('2').floor().toString()).toBe('2')
  })
})

describe('scale utilities', () => {
  it('trims trailing zeros down to a minimum scale', () => {
    expect(decimal('1.500').trimTrailingZeros().toString()).toBe('1.5')
    expect(decimal('100').trimTrailingZeros().toString()).toBe('100')
    expect(decimal('1.000').trimTrailingZeros().toString()).toBe('1')
    expect(decimal('1.500').trimTrailingZeros(2).toString()).toBe('1.50')
  })

  it('rescales with padding or rounding', () => {
    expect(decimal('1.5').withScale(3).toString()).toBe('1.500')
    expect(decimal('1.567').withScale(1).toString()).toBe('1.6')
  })

  it('answers isInteger and sign checks', () => {
    expect(decimal('2.00').isInteger()).toBe(true)
    expect(decimal('2.01').isInteger()).toBe(false)
    expect(decimal('0').isZero()).toBe(true)
    expect(decimal('-1').isNegative()).toBe(true)
    expect(Decimal.zero().isZero()).toBe(true)
  })

  it('converts to JS numbers', () => {
    expect(decimal('2.5').toNumber()).toBe(2.5)
  })
})
