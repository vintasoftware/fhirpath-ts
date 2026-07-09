import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { Temporal } from './datetime.ts'
import { compareTemporal, type TemporalComparison } from './temporal-compare.ts'

/**
 * Property-based laws for precision-aware temporal comparison: the ordering
 * must be symmetric and transitive at any mix of precisions, and precision
 * mismatches must resolve to 'differentPrecision' (empty at the FHIRPath
 * level) in both directions — never to an arbitrary order.
 */

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

const dateTextArb = fc
  .tuple(
    fc.integer({ min: 1900, max: 2100 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 2 })
  )
  .map(([year, month, day, precision]) => {
    if (precision === 0) {
      return String(year)
    }
    if (precision === 1) {
      return `${year}-${pad(month)}`
    }
    return `${year}-${pad(month)}-${pad(day)}`
  })

const timeSuffixArb = fc
  .tuple(
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 3 })
  )
  .map(([hour, minute, second, millisecond, precision]) => {
    if (precision === 0) {
      return pad(hour)
    }
    if (precision === 1) {
      return `${pad(hour)}:${pad(minute)}`
    }
    if (precision === 2) {
      return `${pad(hour)}:${pad(minute)}:${pad(second)}`
    }
    return `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millisecond, 3)}`
  })

const offsetArb = fc.constantFrom('', 'Z', '+02:00', '-05:00', '+10:00')

const dateArb = dateTextArb.map(text => Temporal.parseDate(text) as Temporal)

const dateTimeArb = fc
  .tuple(
    fc.integer({ min: 1900, max: 2100 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.option(fc.tuple(timeSuffixArb, offsetArb), { nil: undefined })
  )
  .map(([year, month, day, time]) => {
    const text =
      time === undefined
        ? `${year}-${pad(month)}-${pad(day)}T`
        : `${year}-${pad(month)}-${pad(day)}T${time[0]}${time[1]}`
    return Temporal.parseDateTime(text) as Temporal
  })

const timeArb = timeSuffixArb.map(text => Temporal.parseTime(text) as Temporal)

const temporalArb = fc.oneof(dateArb, dateTimeArb, timeArb)

const sameKindPairArb = fc.oneof(
  fc.tuple(dateArb, dateArb),
  fc.tuple(dateTimeArb, dateTimeArb),
  fc.tuple(timeArb, timeArb)
)

function flip(comparison: TemporalComparison): TemporalComparison {
  return comparison === -1 ? 1 : comparison === 1 ? -1 : comparison
}

describe('temporal comparison laws (mixed precisions)', () => {
  it('every generated literal parses', () => {
    fc.assert(
      fc.property(temporalArb, temporal => {
        expect(temporal).toBeDefined()
      })
    )
  })

  it('comparison is reflexive: a value equals itself', () => {
    fc.assert(
      fc.property(temporalArb, temporal => {
        expect(compareTemporal(temporal, temporal)).toBe(0)
      })
    )
  })

  it('comparison is symmetric, including the indeterminate outcomes', () => {
    fc.assert(
      fc.property(sameKindPairArb, ([a, b]) => {
        expect(compareTemporal(b, a)).toBe(flip(compareTemporal(a, b)))
      })
    )
  })

  it('determinate order is transitive', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(dateArb, dateArb, dateArb),
          fc.tuple(dateTimeArb, dateTimeArb, dateTimeArb),
          fc.tuple(timeArb, timeArb, timeArb)
        ),
        ([a, b, c]) => {
          const ab = compareTemporal(a, b)
          const bc = compareTemporal(b, c)
          if ((ab === -1 || ab === 0) && (bc === -1 || bc === 0)) {
            const ac = compareTemporal(a, c)
            // a <= b <= c with determinate steps must not order a after c —
            // but mixed precisions may make a vs c indeterminate, which is fine.
            expect(ac).not.toBe(1)
          }
        }
      )
    )
  })

  it('dates and times never compare', () => {
    fc.assert(
      fc.property(dateArb, timeArb, (date, time) => {
        expect(compareTemporal(date, time)).toBe('incompatible')
      })
    )
  })
})
