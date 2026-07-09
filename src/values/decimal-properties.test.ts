import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { Decimal } from './decimal.ts'

/**
 * Property-based laws for the exact BigInt-mantissa decimal. Addition,
 * subtraction, and multiplication are exact (no rounding step), so the
 * algebraic laws must hold exactly. Float-based engines cannot promise
 * this, and it is why 1.58700 keeps its trailing zeros here.
 */

const decimalArb = fc
  .tuple(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), fc.nat({ max: 12 }))
  .map(([digits, scale]) => new Decimal(digits, scale))

const nonZeroArb = decimalArb.filter(decimal => !decimal.isZero())

describe('decimal arithmetic laws (exact operations)', () => {
  it('addition commutes and associates exactly', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, decimalArb, (a, b, c) => {
        expect(a.add(b).equals(b.add(a))).toBe(true)
        expect(
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c)))
        ).toBe(true)
      })
    )
  })

  it('multiplication commutes, associates, and distributes exactly', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, decimalArb, (a, b, c) => {
        expect(a.multiply(b).equals(b.multiply(a))).toBe(true)
        expect(
          a
            .multiply(b)
            .multiply(c)
            .equals(a.multiply(b.multiply(c)))
        ).toBe(true)
        expect(a.multiply(b.add(c)).equals(a.multiply(b).add(a.multiply(c)))).toBe(true)
      })
    )
  })

  it('subtraction and negation invert addition', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (a, b) => {
        expect(a.subtract(a).isZero()).toBe(true)
        expect(a.add(b).subtract(b).equals(a)).toBe(true)
        expect(a.negate().negate().equals(a)).toBe(true)
        expect(a.add(a.negate()).isZero()).toBe(true)
      })
    )
  })

  it('toString/fromString round-trips exactly, trailing zeros included', () => {
    // Scale survives the text round-trip, so 1.58700 stays precision 5 —
    // engines that normalize trailing zeros away lose this.
    fc.assert(
      fc.property(decimalArb, decimal => {
        const text = decimal.toString()
        const reparsed = Decimal.fromString(text)
        expect(reparsed).toBeDefined()
        expect(reparsed?.equals(decimal)).toBe(true)
        expect(reparsed?.toString()).toBe(text)
      })
    )
  })

  it('compare is an order: antisymmetric, transitive, consistent with equals', () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, decimalArb, (a, b, c) => {
        expect(a.compare(b)).toBe(-b.compare(a))
        expect(a.compare(b) === 0).toBe(a.equals(b))
        if (a.compare(b) <= 0 && b.compare(c) <= 0) {
          expect(a.compare(c)).toBeLessThanOrEqual(0)
        }
      })
    )
  })

  it('floor <= value <= ceiling, and truncate moves toward zero', () => {
    fc.assert(
      fc.property(decimalArb, decimal => {
        expect(decimal.floor().compare(decimal)).toBeLessThanOrEqual(0)
        expect(decimal.ceiling().compare(decimal)).toBeGreaterThanOrEqual(0)
        expect(decimal.truncate().abs().compare(decimal.abs())).toBeLessThanOrEqual(0)
        expect(decimal.abs().isNegative()).toBe(false)
      })
    )
  })

  it('division is defined exactly for non-zero divisors', () => {
    fc.assert(
      fc.property(decimalArb, nonZeroArb, (a, b) => {
        expect(a.divide(b)).toBeDefined()
        expect(a.divide(Decimal.zero())).toBeUndefined()
      })
    )
  })
})
