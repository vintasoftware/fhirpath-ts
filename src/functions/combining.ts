import { unionCollections } from '../engine/operators/collections.ts'
import { argAt, registerFunction } from './registry.ts'

registerFunction('union', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) =>
    unionCollections(input, evaluateNode(argAt(args, 0), context, input)),
})

registerFunction('combine', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => [...input, ...evaluateNode(argAt(args, 0), context, input)],
})
