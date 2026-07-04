import { withFrame } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import { singleton } from '../values/collection.ts'
import { SYSTEM_STRING, type TypedValue } from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

/**
 * defineVariable(name [, value]) — ballot STU. The variable joins the current
 * expression chain's scope (see EvaluationContext.variables): later links of the
 * same dot chain see it, sibling operator operands and arguments do not.
 */
registerFunction('defineVariable', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    const nameValue = singleton(evaluateNode(argAt(args, 0), context, input))
    if (nameValue === undefined || nameValue.type !== SYSTEM_STRING) {
      throw new FhirPathTypeError('defineVariable() expects a String name')
    }
    const name = nameValue.value as string
    if (context.env.has(name)) {
      throw new FhirPathTypeError(`Cannot override the environment variable %${name}`)
    }
    if (context.variables.has(name)) {
      throw new FhirPathTypeError(`Variable %${name} is already defined in this scope`)
    }
    // The value expression evaluates against the function input, e.g.
    // Patient.name.defineVariable('n2', skip(1).first()).
    const value: TypedValue[] =
      args.length === 2
        ? withFrame(context, { thisValue: input }, frameContext => evaluateNode(argAt(args, 1), frameContext, input))
        : input
    context.variables.set(name, value)
    return input
  },
})
