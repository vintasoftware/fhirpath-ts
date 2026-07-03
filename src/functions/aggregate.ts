import { withFrame } from '../engine/context'
import { FhirPathTypeError } from '../errors'
import type { AstNode } from '../parser/ast'
import { Decimal } from '../values/decimal'
import { asNumeric, type NumericKind, widerKind, wrapNumeric } from '../values/numeric'
import { SYSTEM_DECIMAL, type TypedValue } from '../values/typed-value'
import { registerFunction } from './registry'

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

// Convenience aggregates. The core spec defines these only as aggregate() idioms,
// e.g. sum() = aggregate($this + $total, 0), which is why sum of empty is 0.
registerFunction('sum', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
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
    const { values } = numericItems('avg', input)
    const total = values.reduce((acc, value) => acc.add(value), Decimal.zero())
    const average = total.divide(Decimal.fromString(String(values.length)) as Decimal)
    /* v8 ignore next -- the divisor is the non-zero item count */
    return average === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: average }]
  },
})
