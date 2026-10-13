import type { EvaluationContext } from '../engine/context.ts'
import { elementOrigin } from '../fhir/element-origin.ts'
import { printIdentifier } from '../parser/printer.ts'
import { SYSTEM_STRING, type TypedValue } from '../values/typed-value.ts'
import { argAt, booleanArgument, registerFunction } from './registry.ts'

/**
 * pathname([short]): the path of each input item inside the input resource,
 * written with element names and indexers only, such as
 * `Observation.component[0].code[0].coding[0]`. Every element gets an indexer
 * unless `short` is true; then an element that is not an array, in the
 * instance or in the model, has none. An item that navigation did not read
 * from the input resource (a computed value, an env value) has no path and is
 * left out. A root without a `resourceType` gives paths relative to it.
 */
registerFunction('pathname', {
  minArity: 0,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const short =
      args.length === 1 && booleanArgument('pathname', evaluateNode(argAt(args, 0), context, input)) === true
    const roots = new Set(context.root)
    const result: TypedValue[] = []
    for (const item of input) {
      const path = pathOf(context, roots, item, short)
      if (path !== undefined) {
        result.push({ type: SYSTEM_STRING, value: path })
      }
    }
    return result
  },
})

function pathOf(
  context: EvaluationContext,
  roots: ReadonlySet<TypedValue>,
  item: TypedValue,
  short: boolean
): string | undefined {
  const segments: string[] = []
  let current = item
  let origin = elementOrigin(current)
  while (origin !== undefined) {
    const { parent, name, index } = origin
    segments.push(printIdentifier(name) + indexer(context, parent, name, index, short))
    current = parent
    origin = elementOrigin(current)
  }
  if (!roots.has(current)) {
    return undefined
  }
  const resourceType = (current.value as { resourceType?: unknown } | null | undefined)?.resourceType
  if (typeof resourceType === 'string') {
    segments.push(printIdentifier(resourceType))
  } else if (segments.length === 0) {
    // A root that is not a resource has no name to stand for it.
    return undefined
  }
  return segments.reverse().join('.')
}

function indexer(
  context: EvaluationContext,
  parent: TypedValue,
  name: string,
  index: number | undefined,
  short: boolean
): string {
  if (!short) {
    return `[${index ?? 0}]`
  }
  if (index === undefined || context.model?.getElement(parent.type, name)?.isCollection === false) {
    return ''
  }
  return `[${index}]`
}
