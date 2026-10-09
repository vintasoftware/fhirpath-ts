import { withFrame } from '../engine/context.ts'
import { compareValues } from '../engine/operators/comparison.ts'
import { FhirPathTypeError } from '../errors.ts'
import { Decimal } from '../values/decimal.ts'
import { asNumeric, type NumericKind, numericResult } from '../values/numeric.ts'
import { alignQuantities, coerceQuantity } from '../values/quantity.ts'
import {
  type QuantityValue,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_LONG,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  SYSTEM_TIME,
  systemTypeOf,
  type TypedValue,
} from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

registerFunction('aggregate', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    let total: TypedValue[] = args.length === 2 ? evaluateNode(argAt(args, 1), context, input) : []
    input.forEach((item, index) => {
      total = withFrame(context, { thisValue: [item], index, total }, frameContext =>
        evaluateNode(argAt(args, 0), frameContext, [item])
      )
    })
    return total
  },
})

const NUMERIC_TYPES = [SYSTEM_INTEGER, SYSTEM_LONG, SYSTEM_DECIMAL, SYSTEM_QUANTITY]
const ORDERED_TYPES = [...NUMERIC_TYPES, SYSTEM_DATE, SYSTEM_DATETIME, SYSTEM_TIME, SYSTEM_STRING]

/**
 * The one System type every item of an aggregate's input shares (spec
 * "Aggregates": "All items in the input collection SHALL be the same type").
 * A FHIR primitive counts as its System type and any FHIR Quantity, such as
 * Age, as System.Quantity. A type outside `accepted` or a second type throws.
 */
function sharedType(name: string, input: TypedValue[], accepted: readonly string[]): string {
  let shared: string | undefined
  for (const item of input) {
    const type = coerceQuantity(item) ? SYSTEM_QUANTITY : systemTypeOf(item)
    if (type === undefined || !accepted.includes(type)) {
      throw new FhirPathTypeError(`${name}() is not defined for ${item.type}`)
    }
    if (shared !== undefined && shared !== type) {
      throw new FhirPathTypeError(`${name}() expects items of one type, found ${shared} and ${type}`)
    }
    shared = type
  }
  return shared as string
}

/**
 * Quantity collections add by pairwise-aligning units, exactly like repeated
 * `+`: (1 'cm' | 3 'cm' | 1 'm').sum() = 104 'cm'. Empty when any pair of units
 * cannot align.
 */
function sumQuantities(input: TypedValue[]): QuantityValue | undefined {
  const quantities = input.map(item => coerceQuantity(item) as QuantityValue)
  let acc = quantities[0] as QuantityValue
  for (const quantity of quantities.slice(1)) {
    const pair = alignQuantities(acc, quantity)
    if (!pair) {
      return undefined
    }
    acc = { value: pair.left.add(pair.right), unit: pair.unit, calendar: pair.calendar }
  }
  return acc
}

function sumNumbers(input: TypedValue[]): Decimal {
  return input.reduce((acc, item) => acc.add((asNumeric(item) as { value: Decimal }).value), Decimal.zero())
}

// Convenience aggregates (FHIRPath 3.0.0, trial use). All four are empty for empty input.
registerFunction('sum', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length === 0) {
      return []
    }
    const type = sharedType('sum', input, NUMERIC_TYPES)
    if (type === SYSTEM_QUANTITY) {
      const total = sumQuantities(input)
      return total === undefined ? [] : [{ type: SYSTEM_QUANTITY, value: total }]
    }
    // An Integer or Long total outside its type's range overflows: empty.
    return numericResult(sumNumbers(input), (asNumeric(input[0] as TypedValue) as { kind: NumericKind }).kind)
  },
})

/**
 * min() and max() return the extreme item itself, compared as the comparison
 * operators compare (spec "Aggregates"). When two items have no order, such as
 * dates of different precision or quantities whose units do not convert, the
 * result is empty, as `<` is.
 */
function extremum(name: string, keep: (comparison: number) => boolean): void {
  registerFunction(name, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      if (input.length === 0) {
        return []
      }
      sharedType(name, input, ORDERED_TYPES)
      let best = input[0] as TypedValue
      for (const item of input.slice(1)) {
        const comparison = compareValues(item, best)
        if (comparison === undefined) {
          return []
        }
        if (keep(comparison)) {
          best = item
        }
      }
      // A primitive present only through its _field sibling has no value to order by.
      return best.value === undefined ? [] : [best]
    },
  })
}

extremum('min', comparison => comparison < 0)
extremum('max', comparison => comparison > 0)

registerFunction('avg', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length === 0) {
      return []
    }
    const count = Decimal.fromString(String(input.length)) as Decimal
    if (sharedType('avg', input, NUMERIC_TYPES) === SYSTEM_QUANTITY) {
      const total = sumQuantities(input)
      const average = total?.value.divide(count)
      return total === undefined || average === undefined
        ? []
        : [{ type: SYSTEM_QUANTITY, value: { ...total, value: average } }]
    }
    // Integer and Long items convert to Decimal (spec "avg").
    const average = sumNumbers(input).divide(count)
    /* v8 ignore next -- the divisor is the non-zero item count */
    return average === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: average }]
  },
})
