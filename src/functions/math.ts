import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { singleton } from '../values/collection.ts'
import { Decimal } from '../values/decimal.ts'
import { asNumeric, numericResult } from '../values/numeric.ts'
import { coerceQuantity } from '../values/quantity.ts'
import { SYSTEM_DECIMAL, SYSTEM_INTEGER, SYSTEM_QUANTITY, type TypedValue } from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

function numericInput(name: string, input: TypedValue[]): { item: TypedValue; value: Decimal } | undefined {
  const item = singleton(input)
  if (item === undefined) {
    return undefined
  }
  const numeric = asNumeric(item)
  if (!numeric) {
    throw new FhirPathTypeError(`${name}() is not defined for ${item.type}`)
  }
  return { item, value: numeric.value }
}

registerFunction('abs', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    const quantity = coerceQuantity(item)
    if (quantity) {
      return [{ type: SYSTEM_QUANTITY, value: { ...quantity, value: quantity.value.abs() } }]
    }
    const numeric = asNumeric(item)
    if (!numeric) {
      throw new FhirPathTypeError(`abs() is not defined for ${item.type}`)
    }
    return numericResult(numeric.value.abs(), numeric.kind)
  },
})

/**
 * ceiling(), floor(), round(), and truncate() take a number or a Quantity
 * (spec "Math"). A Quantity keeps its unit and gets the rounded value; a number
 * gives `kind`, and an Integer result outside 32 bits is empty.
 */
function rounding(
  name: string,
  kind: 'Integer' | 'Decimal',
  maxArity: number,
  round: (value: Decimal, precision: number) => Decimal
): void {
  registerFunction(name, {
    minArity: 0,
    maxArity,
    evaluate: (context, input, args, evaluateNode) => {
      const item = singleton(input)
      if (item === undefined) {
        return []
      }
      let precision = 0
      if (args.length === 1) {
        const argument = singleton(evaluateNode(argAt(args, 0), context, input), SYSTEM_INTEGER)
        if (argument === undefined || typeof argument.value !== 'number' || argument.value < 0) {
          throw new FhirPathTypeError(`${name}() expects a non-negative integer precision`)
        }
        precision = argument.value
      }
      const quantity = coerceQuantity(item)
      if (quantity) {
        return [{ type: SYSTEM_QUANTITY, value: { ...quantity, value: round(quantity.value, precision) } }]
      }
      const numeric = numericInput(name, input) as { value: Decimal }
      return numericResult(round(numeric.value, precision), kind)
    },
  })
}

rounding('ceiling', 'Integer', 0, value => value.ceiling())
rounding('floor', 'Integer', 0, value => value.floor())
rounding('truncate', 'Integer', 0, value => value.truncate())
rounding('round', 'Decimal', 1, (value, precision) => value.round(precision))

/** Number-backed transcendental; empty when the JS result is not finite (domain errors). */
function transcendental(name: string, compute: (value: number) => number): void {
  registerFunction(name, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      const numeric = numericInput(name, input)
      if (!numeric) {
        return []
      }
      const result = compute(numeric.value.toNumber())
      const decimal = Decimal.fromNumber(result)
      return decimal === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: decimal }]
    },
  })
}

transcendental('exp', Math.exp)
transcendental('ln', Math.log)
transcendental('sqrt', Math.sqrt)

registerFunction('log', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const numeric = numericInput('log', input)
    if (!numeric) {
      return []
    }
    const base = numericInput('log', evaluateNode(argAt(args, 0), context, input))
    if (!base) {
      return []
    }
    // A zero or negative input or base is an error (spec "log").
    if (numeric.value.isZero() || numeric.value.isNegative()) {
      throw new FhirPathRuntimeError('log() is not defined for an input of zero or less')
    }
    if (base.value.isZero() || base.value.isNegative()) {
      throw new FhirPathRuntimeError('log() is not defined for a base of zero or less')
    }
    const decimal = Decimal.fromNumber(Math.log(numeric.value.toNumber()) / Math.log(base.value.toNumber()))
    // Base 1 divides by log(1) = 0, which has no finite result: empty.
    return decimal === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: decimal }]
  },
})

registerFunction('power', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const numeric = numericInput('power', input)
    if (!numeric) {
      return []
    }
    const exponent = numericInput('power', evaluateNode(argAt(args, 0), context, input))
    if (!exponent) {
      return []
    }
    // The result is always a Decimal; a power with no real value, such as
    // (-1).power(0.5), is empty (spec "power").
    const decimal = Decimal.fromNumber(numeric.value.toNumber() ** exponent.value.toNumber())
    return decimal === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: decimal }]
  },
})
