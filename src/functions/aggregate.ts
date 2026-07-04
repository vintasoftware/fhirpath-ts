import { withFrame } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { Decimal } from '../values/decimal.ts'
import { asNumeric, type NumericKind, widerKind, wrapNumeric } from '../values/numeric.ts'
import { alignQuantities, coerceQuantity, type QuantityValue } from '../values/quantity.ts'
import { SYSTEM_DECIMAL, SYSTEM_QUANTITY, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

registerFunction('aggregate', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    let total: TypedValue[] = args.length === 2 ? evaluateNode(args[1] as AstNode, context, input) : []
    input.forEach((item, index) => {
      total = withFrame(context, { thisValue: [item], index, total }, frameContext =>
        evaluateNode(args[0] as AstNode, frameContext, [item])
      )
    })
    return total
  },
})

/** Shared by sum/min/max/avg: all items must be numeric, of a comparable kind. */
function numericItems(name: string, input: TypedValue[]): { values: Decimal[]; kind: NumericKind } {
  let kind: NumericKind = 'Integer'
  const values = input.map(item => {
    const numeric = asNumeric(item)
    if (!numeric) {
      throw new FhirPathTypeError(`${name}() expects numeric values, found ${item.type}`)
    }
    kind = widerKind(kind, numeric.kind)
    return numeric.value
  })
  return { values, kind }
}

/**
 * Quantity collections aggregate by pairwise-aligning units, exactly like
 * repeated `+`: (1 'cm' | 3 'cm' | 1 'm').sum() = 104 'cm'. Empty when any
 * pair of units cannot align.
 */
function foldQuantities(quantities: QuantityValue[], fold: (acc: Decimal, next: Decimal) => Decimal): TypedValue[] {
  let acc = quantities[0] as QuantityValue
  for (const quantity of quantities.slice(1)) {
    const pair = alignQuantities(acc, quantity)
    if (!pair) {
      return []
    }
    acc = { value: fold(pair.left, pair.right), unit: pair.unit, calendar: pair.calendar }
  }
  return [{ type: SYSTEM_QUANTITY, value: acc }]
}

function allQuantities(input: TypedValue[]): QuantityValue[] | undefined {
  const quantities: QuantityValue[] = []
  for (const item of input) {
    const quantity = coerceQuantity(item)
    if (quantity === undefined) {
      return undefined
    }
    quantities.push(quantity)
  }
  return quantities
}

// Convenience aggregates (ballot STU). All four are empty for empty input.
registerFunction('sum', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length === 0) {
      return []
    }
    const quantities = allQuantities(input)
    if (quantities) {
      return foldQuantities(quantities, (acc, next) => acc.add(next))
    }
    const { values, kind } = numericItems('sum', input)
    const total = values.reduce((acc, value) => acc.add(value), Decimal.zero())
    const wrapped = wrapNumeric(total, kind)
    return wrapped === undefined ? [] : [wrapped]
  },
})

function extremum(name: string, keep: (comparison: number) => boolean): void {
  registerFunction(name, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      if (input.length === 0) {
        return []
      }
      const quantities = allQuantities(input)
      if (quantities) {
        return foldQuantities(quantities, (acc, next) => (keep(next.compare(acc)) ? next : acc))
      }
      const { values, kind } = numericItems(name, input)
      let best = values[0] as Decimal
      for (const value of values.slice(1)) {
        if (keep(value.compare(best))) {
          best = value
        }
      }
      const wrapped = wrapNumeric(best, kind)
      /* v8 ignore next -- min/max of in-range inputs cannot overflow */
      return wrapped === undefined ? [] : [wrapped]
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
    const quantities = allQuantities(input)
    if (quantities) {
      const total = foldQuantities(quantities, (acc, next) => acc.add(next))
      if (total.length === 0) {
        return []
      }
      const sum = (total[0] as TypedValue).value as QuantityValue
      const average = sum.value.divide(count)
      /* v8 ignore next -- the divisor is the non-zero item count */
      return average === undefined ? [] : [{ type: SYSTEM_QUANTITY, value: { ...sum, value: average } }]
    }
    const { values } = numericItems('avg', input)
    const total = values.reduce((acc, value) => acc.add(value), Decimal.zero())
    const average = total.divide(count)
    /* v8 ignore next -- the divisor is the non-zero item count */
    return average === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: average }]
  },
})
