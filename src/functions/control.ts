import type { AstNode } from '../parser/ast'
import { booleanSingleton } from '../values/collection'
import { registerFunction } from './registry'

registerFunction('iif', {
  minArity: 2,
  maxArity: 3,
  evaluate: (context, input, args, evaluateNode) => {
    const criterion = booleanSingleton(evaluateNode(args[0] as AstNode, context, input))
    // Only the selected branch is evaluated (spec §5.5.1: iif is lazy).
    if (criterion === true) {
      return evaluateNode(args[1] as AstNode, context, input)
    }
    if (args.length === 3) {
      return evaluateNode(args[2] as AstNode, context, input)
    }
    return []
  },
})
