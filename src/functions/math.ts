import { FhirPathTypeError } from '../errors'
import type { AstNode } from '../parser/ast'
import { singleton } from '../values/collection'
import { Decimal } from '../values/decimal'
import { asNumeric, wrapNumeric } from '../values/numeric'
import {
  type QuantityValue,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_QUANTITY,
  type TypedValue,
} from '../values/typed-value'
import { registerFunction } from './registry'

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
    if (item.type === SYSTEM_QUANTITY) {
      const quantity = item.value as QuantityValue
      return [{ type: SYSTEM_QUANTITY, value: { ...quantity, value: quantity.value.abs() } }]
    }
    const numeric = asNumeric(item)
    if (!numeric) {
      throw new FhirPathTypeError(`abs() is not defined for ${item.type}`)
    }
    const wrapped = wrapNumeric(numeric.value.abs(), numeric.kind)
    return wrapped === undefined ? [] : [wrapped]
  },
})

registerFunction('ceiling', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const numeric = numericInput('ceiling', input)
    if (!numeric) {
      return []
    }
    const wrapped = wrapNumeric(numeric.value.ceiling(), 'Integer')
    return wrapped === undefined ? [] : [wrapped]
  },
})

registerFunction('floor', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const numeric = numericInput('floor', input)
    if (!numeric) {
      return []
    }
    const wrapped = wrapNumeric(numeric.value.floor(), 'Integer')
    return wrapped === undefined ? [] : [wrapped]
  },
})

registerFunction('truncate', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const numeric = numericInput('truncate', input)
    if (!numeric) {
      return []
    }
    const wrapped = wrapNumeric(numeric.value.truncate(), 'Integer')
    return wrapped === undefined ? [] : [wrapped]
  },
})

registerFunction('round', {
  minArity: 0,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const numeric = numericInput('round', input)
    if (!numeric) {
      return []
    }
    let precision = 0
    if (args.length === 1) {
      const argument = singleton(evaluateNode(args[0] as AstNode, context, input), SYSTEM_INTEGER)
      if (argument === undefined || typeof argument.value !== 'number' || argument.value < 0) {
        throw new FhirPathTypeError('round() expects a non-negative integer precision')
      }
      precision = argument.value
    }
    return [{ type: SYSTEM_DECIMAL, value: numeric.value.round(precision) }]
  },
})

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
    const baseInput = singleton(evaluateNode(args[0] as AstNode, context, input))
    const base = baseInput === undefined ? undefined : asNumeric(baseInput)
    if (!base) {
      return []
    }
    const result = Math.log(numeric.value.toNumber()) / Math.log(base.value.toNumber())
    const decimal = Decimal.fromNumber(result)
    // NaN and infinities (log of a non-positive value, base 1) become empty.
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
    const exponentInput = singleton(evaluateNode(args[0] as AstNode, context, input))
    const exponent = exponentInput === undefined ? undefined : asNumeric(exponentInput)
    if (!exponent) {
      return []
    }
    const result = numeric.value.toNumber() ** exponent.value.toNumber()
    const decimal = Decimal.fromNumber(result)
    if (decimal === undefined) {
      return []
    }
    // Integer ^ Integer stays an Integer when the result is whole (spec §5.7.7).
    if (numeric.item.type === SYSTEM_INTEGER && exponentInput?.type === SYSTEM_INTEGER && decimal.isInteger()) {
      const wrapped = wrapNumeric(decimal, 'Integer')
      return wrapped === undefined ? [] : [wrapped]
    }
    return [{ type: SYSTEM_DECIMAL, value: decimal }]
  },
})
