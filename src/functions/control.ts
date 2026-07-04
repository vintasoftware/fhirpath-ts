import { withFrame } from '../engine/context.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { booleanSingleton } from '../values/collection.ts'
import { argAt, registerFunction } from './registry.ts'

registerFunction('iif', {
  minArity: 2,
  maxArity: 3,
  evaluate: (context, input, args, evaluateNode) => {
    if (input.length > 1) {
      throw new FhirPathRuntimeError('iif() expects a collection with at most one item as input')
    }
    // $this is the (optional) single input item; branches evaluate lazily.
    return withFrame(context, { thisValue: input }, frameContext => {
      const criterion = booleanSingleton(evaluateNode(argAt(args, 0), frameContext, input))
      if (criterion === true) {
        return evaluateNode(argAt(args, 1), frameContext, input)
      }
      if (args.length === 3) {
        return evaluateNode(argAt(args, 2), frameContext, input)
      }
      return []
    })
  },
})
