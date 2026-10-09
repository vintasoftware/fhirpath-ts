import { ancestors, childValue, elementOrigin } from '../fhir/element-origin.ts'
import { toTypedValue, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

/** Try the originating resource and Bundle before the host's external resolver. */
registerFunction('resolve', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const result: TypedValue[] = []
    for (const item of input) {
      const reference = typeof item.value === 'string' ? item.value : record(item.value)?.['reference']
      if (typeof reference !== 'string') continue
      const resolved = resolveLocal(reference, item, context.root[0])
      if (resolved !== undefined) {
        result.push(resolved)
        continue
      }
      const resolver = context.resolver
      if (resolver === undefined || reference.startsWith('#')) continue
      const external = requestAsync(context, 'resolve() of external references', `resolve|${reference}`, () =>
        resolver(reference)
      )
      if (typeof record(external)?.['resourceType'] === 'string') result.push(toTypedValue(external))
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
    const resource = Array.isArray(contained)
      ? contained.find(value => record(value)?.['id'] === reference.slice(1))
      : undefined
    return resource === undefined ? undefined : childValue(toTypedValue(resource), scope, 'contained')
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
  for (const entry of scope['entry']) {
    const fields = record(entry)
    const resource = record(fields?.['resource'])
    if (resource === undefined) continue
    // Relative references require the resource's type/id, not a fullUrl suffix.
    if (
      (isAbsolute && fields?.['fullUrl'] === reference) ||
      (!isAbsolute && `${String(resource['resourceType'])}/${String(resource['id'])}` === reference)
    ) {
      const entryNode = childValue(toTypedValue(entry), bundle, 'entry')
      return childValue(toTypedValue(resource), entryNode, 'resource')
    }
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}
import { requestAsync } from '../engine/async.ts'
