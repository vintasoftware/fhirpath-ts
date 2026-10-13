import { ancestors, childValue, elementOrigin } from '../fhir/element-origin.ts'
import { toTypedValue, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

/**
 * Resolve within the originating resource and its enclosing Bundle. A resolved
 * resource records where it sits (`contained[i]` or `entry[i].resource`), so
 * `pathname()` and later `resolve()` calls see its place.
 */
registerFunction('resolve', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const result: TypedValue[] = []
    for (const item of input) {
      const reference = typeof item.value === 'string' ? item.value : record(item.value)?.['reference']
      if (typeof reference !== 'string') continue
      const resolved = resolveLocal(reference, item, context.root[0])
      if (resolved !== undefined) result.push(resolved)
    }
    return result
  },
})

function resourceOf(item: TypedValue): TypedValue | undefined {
  for (const node of ancestors(item)) {
    if (typeof record(node.value)?.['resourceType'] === 'string') return node
  }
  return undefined
}

function resolveLocal(reference: string, item: TypedValue, root: TypedValue | undefined): TypedValue | undefined {
  if (reference.startsWith('#')) {
    let scope = resourceOf(item) ?? root
    if (scope === undefined) return undefined
    // References from contained resources address their container or siblings.
    const origin = elementOrigin(scope)
    if (origin?.name === 'contained') scope = origin.parent
    if (reference === '#') return scope
    const contained = record(scope.value)?.['contained']
    if (!Array.isArray(contained)) return undefined
    const index = contained.findIndex(value => record(value)?.['id'] === reference.slice(1))
    return index === -1 ? undefined : childValue(toTypedValue(contained[index]), scope, 'contained', index)
  }
  for (const node of ancestors(item)) {
    if (record(node.value)?.['resourceType'] === 'Bundle') return resolveInBundle(reference, node)
  }
  return root === undefined ? undefined : resolveInBundle(reference, root)
}

function resolveInBundle(reference: string, bundle: TypedValue): TypedValue | undefined {
  const scope = record(bundle.value)
  if (scope?.['resourceType'] !== 'Bundle' || !Array.isArray(scope['entry'])) return undefined
  const isAbsolute = reference.includes('://') || reference.startsWith('urn:')
  for (const [index, entry] of scope['entry'].entries()) {
    const fields = record(entry)
    const resource = record(fields?.['resource'])
    if (resource === undefined) continue
    // Relative references require the resource's type/id, not a fullUrl suffix.
    if (
      (isAbsolute && fields?.['fullUrl'] === reference) ||
      (!isAbsolute && `${String(resource['resourceType'])}/${String(resource['id'])}` === reference)
    ) {
      const entryNode = childValue({ type: 'FHIR.Bundle.entry', value: entry }, bundle, 'entry', index)
      return childValue(toTypedValue(resource), entryNode, 'resource')
    }
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}
