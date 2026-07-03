import { withFrame } from '../engine/context'
import { FhirPathTypeError } from '../errors'
import type { AstNode } from '../parser/ast'
import { singleton } from '../values/collection'
import { SYSTEM_STRING, type TypedValue } from '../values/typed-value'
import { registerFunction } from './registry'

/**
 * defineVariable(name [, value]) — ballot STU. The variable joins the current
 * expression chain's scope (see EvaluationContext.variables): later links of the
 * same dot chain see it, sibling operator operands and arguments do not.
 */
registerFunction('defineVariable', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    const nameValue = singleton(evaluateNode(args[0] as AstNode, context, input))
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
        ? withFrame(context, { thisValue: input }, frameContext =>
            evaluateNode(args[1] as AstNode, frameContext, input)
          )
        : input
    context.variables.set(name, value)
    return input
  },
})
