import type { AstNode } from '../parser/ast'
import { booleanSingleton, wrapBoolean } from '../values/collection'
import { registerFunction } from './registry'

registerFunction('not', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const value = booleanSingleton(input)
    return wrapBoolean(value === undefined ? undefined : !value)
  },
})

registerFunction('trace', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    const name = evaluateNode(args[0] as AstNode, context, input)
    const label = typeof name[0]?.value === 'string' ? (name[0].value as string) : ''
    const traced = args.length === 2 ? evaluateNode(args[1] as AstNode, context, input) : input
    context.trace(label, traced)
    return input
  },
})
