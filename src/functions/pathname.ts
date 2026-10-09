import type { EvaluationContext, HostFunction } from '../engine/context.ts'
import type { AstNode } from '../parser/ast.ts'
import { printIdentifier } from '../parser/printer.ts'
import { booleanSingleton } from '../values/collection.ts'
import { SYSTEM_STRING, type TypedValue } from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

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
    const short = args.length === 1 && booleanSingleton(evaluateNode(argAt(args, 0), context, input)) === true
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
  while (current.origin !== undefined) {
    const { parent, name, index } = current.origin
    segments.push(printIdentifier(name) + indexer(context, parent, name, index, short))
    current = parent
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

/**
 * True when evaluating `node` can call `pathname()` directly. Navigation
 * records item origins only for such evaluations; `callsPathname` caches the
 * answer per AST, since a compiled expression is evaluated many times.
 */
export function callsPathname(node: AstNode): boolean {
  let calls = pathnameCalls.get(node)
  if (calls === undefined) {
    calls = containsPathnameCall(node)
    pathnameCalls.set(node, calls)
  }
  return calls
}

const pathnameCalls = new WeakMap<AstNode, boolean>()

function containsPathnameCall(node: AstNode): boolean {
  switch (node.kind) {
    case 'call':
      return node.name === 'pathname' || node.args.some(containsPathnameCall)
    case 'dot':
    case 'binary':
      return containsPathnameCall(node.left) || containsPathnameCall(node.right)
    case 'indexer':
      return containsPathnameCall(node.target) || containsPathnameCall(node.index)
    case 'unary':
    case 'typeOp':
      return containsPathnameCall(node.operand)
    case 'instance':
      return node.elements.some(element => containsPathnameCall(element.value))
    case 'null':
    case 'boolean':
    case 'string':
    case 'number':
    case 'date':
    case 'dateTime':
    case 'time':
    case 'quantity':
    case 'identifier':
    case 'special':
    case 'external':
      return false
    /* v8 ignore start -- exhaustive fallback, unreachable for real ASTs */
    default: {
      const unreachable: never = node
      return unreachable
    }
    /* v8 ignore stop */
  }
}

/**
 * True when a host expression function's body, or a body it can call through
 * its own function table, calls `pathname()`. A call to such a function needs
 * origins on the items it receives, so the whole evaluation tracks them.
 */
export function hostFunctionsCallPathname(functions: Iterable<HostFunction>, seen = new Set<object>()): boolean {
  for (const entry of functions) {
    for (const fn of 'overloads' in entry ? entry.overloads : [entry]) {
      if (!('ast' in fn)) {
        continue
      }
      if (callsPathname(fn.ast)) {
        return true
      }
      if (fn.functions !== undefined && !seen.has(fn.functions)) {
        seen.add(fn.functions)
        if (hostFunctionsCallPathname(fn.functions.values(), seen)) {
          return true
        }
      }
    }
  }
  return false
}
