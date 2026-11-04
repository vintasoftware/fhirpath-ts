import { forEachCollecting, requestAsync } from '../engine/async.ts'
import { ancestors, childValue, owningResource, rootResourceOf } from '../fhir/element-origin.ts'
import { serverBase } from '../fhir/reference-resolver.ts'
import { toTypedValue, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

/**
 * Resources the host's resolver returned, with the server base each came from
 * (undefined when unknown). They own their navigation: a reference inside one
 * never resolves against the input's Bundle, whose entries may share its
 * relative ids but live on another server.
 */
const externalBases = new WeakMap<TypedValue, string | undefined>()

/**
 * Try the originating resource and Bundle before the host's external resolver.
 * Local results retain their position for pathname() and subsequent resolve()
 * calls; external results start a new resource scope.
 */
registerFunction('resolve', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const result: TypedValue[] = []
    // Each reference resolves on its own, so external requests start together.
    forEachCollecting(input, item => {
      const reference = typeof item.value === 'string' ? item.value : record(item.value)?.['reference']
      if (typeof reference !== 'string') return
      if (reference.startsWith('#')) {
        const resolved = resolveFragment(reference, item, context.root[0])
        if (resolved !== undefined) result.push(resolved)
        return
      }
      const scope = referenceScope(item, context.root[0])
      const resolved = scope.bundle === undefined ? undefined : resolveInBundle(reference, scope.bundle)
      if (resolved !== undefined) {
        result.push(resolved)
        return
      }
      const services = context.async
      const resolver = services?.resolver
      if (services === undefined || resolver === undefined) return
      const base = isAbsolute(reference) ? undefined : scope.base
      const external = requestAsync(services, `resolve|${JSON.stringify([reference, base])}`, () =>
        resolver(reference, base)
      )
      if (typeof record(external)?.['resourceType'] !== 'string') return
      const resource = toTypedValue(external)
      externalBases.set(resource, base ?? serverBase(reference))
      result.push(resource)
    })
    return result
  },
})

function resolveFragment(reference: string, item: TypedValue, root: TypedValue | undefined): TypedValue | undefined {
  const owner = owningResource(item)
  // References from contained resources address their container or siblings.
  const scope = owner === undefined ? root : rootResourceOf(owner)
  if (scope === undefined) return undefined
  if (reference === '#') return scope
  const contained = record(scope.value)?.['contained']
  if (!Array.isArray(contained)) return undefined
  const index = contained.findIndex(value => record(value)?.['id'] === reference.slice(1))
  return index === -1 ? undefined : childValue(toTypedValue(contained[index]), scope, 'contained', index)
}

/**
 * Where a reference is written: the Bundle it resolves in, and the server base
 * of the resource that holds it. Inside a Bundle that is the entry's fullUrl,
 * or else the base the Bundle itself was fetched from (for `signature.who`, or
 * an entry without a fullUrl); outside one, the base its fetched resource came
 * from. A literal or a reference in the input resolves in the input Bundle,
 * with no known base.
 */
function referenceScope(
  item: TypedValue,
  root: TypedValue | undefined
): { bundle: TypedValue | undefined; base: string | undefined } {
  let previous: TypedValue | undefined
  for (const node of ancestors(item)) {
    if (record(node.value)?.['resourceType'] === 'Bundle') {
      // An entry, when the reference sits in one, names its resource's own base.
      const fullUrl = previous === undefined ? undefined : record(previous.value)?.['fullUrl']
      const entryBase = typeof fullUrl === 'string' ? serverBase(fullUrl) : undefined
      return { bundle: node, base: entryBase ?? externalBases.get(node) }
    }
    previous = node
  }
  if (previous !== undefined && externalBases.has(previous)) {
    return { bundle: undefined, base: externalBases.get(previous) }
  }
  return { bundle: root, base: undefined }
}

function isAbsolute(reference: string): boolean {
  return reference.includes('://') || reference.startsWith('urn:')
}

function resolveInBundle(reference: string, bundle: TypedValue): TypedValue | undefined {
  const scope = record(bundle.value)
  if (scope?.['resourceType'] !== 'Bundle' || !Array.isArray(scope['entry'])) return undefined
  const absolute = isAbsolute(reference)
  for (const [index, entry] of scope['entry'].entries()) {
    const fields = record(entry)
    const resource = record(fields?.['resource'])
    if (resource === undefined) continue
    // Relative references require the resource's type/id, not a fullUrl suffix.
    if (
      (absolute && fields?.['fullUrl'] === reference) ||
      (!absolute && `${String(resource['resourceType'])}/${String(resource['id'])}` === reference)
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
