import { unionCollections } from '../engine/operators/collections'
import type { AstNode } from '../parser/ast'
import { registerFunction } from './registry'

registerFunction('union', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) =>
    unionCollections(input, evaluateNode(args[0] as AstNode, context, input)),
})

registerFunction('combine', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => [...input, ...evaluateNode(args[0] as AstNode, context, input)],
})
