import { unionCollections } from '../engine/operators/collections.ts'
import { booleanSingleton } from '../values/collection.ts'
import { argAt, registerFunction } from './registry.ts'

registerFunction('union', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) =>
    unionCollections(input, evaluateNode(argAt(args, 0), context, input)),
})

// The result always keeps the input's items and then `other`'s, each in order,
// which satisfies `preserveOrder` (FHIRPath 3.0.0) whatever its value.
registerFunction('combine', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(argAt(args, 0), context, input)
    if (args.length === 2) {
      booleanSingleton(evaluateNode(argAt(args, 1), context, input))
    }
    return [...input, ...other]
  },
})
