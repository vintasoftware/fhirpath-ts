import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { validateNarrative } from '../fhir/html-checks.ts'
import { singleton, wrapBoolean } from '../values/collection.ts'
import { calendarToUcumLoose, compareQuantities, promoteQuantity } from '../values/quantity.ts'
import { SYSTEM_QUANTITY, SYSTEM_STRING, systemTypeOf, type TypedValue, toTypedValue } from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

/** extension(url): extensions of each item, including primitive `_field` extensions. */
registerFunction('extension', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const urlValue = singleton(evaluateNode(argAt(args, 0), context, input))
    if (urlValue === undefined) {
      return []
    }
    if (systemTypeOf(urlValue) !== SYSTEM_STRING) {
      throw new FhirPathTypeError('extension() expects a String url argument')
    }
    const url = urlValue.value as string
    const result: TypedValue[] = []
    for (const item of input) {
      for (const extension of extensionsOf(item)) {
        if ((extension as { url?: unknown }).url === url) {
          result.push({ type: 'FHIR.Extension', value: extension })
        }
      }
    }
    return result
  },
})

function extensionsOf(item: TypedValue): unknown[] {
  const containers: unknown[] = [item.value, item.primitiveElement]
  const result: unknown[] = []
  for (const container of containers) {
    if (typeof container === 'object' && container !== null) {
      const extensions = (container as { extension?: unknown }).extension
      if (Array.isArray(extensions)) {
        result.push(...extensions)
      }
    }
  }
  return result
}

/**
 * True when the input holds a single primitive with an actual value; a multi-item
 * input is "not a single value" (FHIR spec wording), so false — not an error.
 */
registerFunction('hasValue', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length === 0) {
      return []
    }
    if (input.length > 1) {
      return wrapBoolean(false)
    }
    const item = input[0] as TypedValue
    return wrapBoolean(
      systemTypeOf(item) !== undefined &&
        item.type !== SYSTEM_QUANTITY &&
        item.value !== undefined &&
        item.value !== null
    )
  },
})

registerFunction('getValue', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length !== 1) {
      return []
    }
    const item = input[0] as TypedValue
    if (systemTypeOf(item) === undefined || item.value === undefined) {
      return []
    }
    return [{ type: systemTypeOf(item) as string, value: item.value }]
  },
})

/**
 * Sync resolve() against the evaluation root: contained references (`#id`) and
 * Bundle-internal references (by fullUrl or type/id). References are resolved
 * relative to the root resource — per-item re-rooting to a containing resource is
 * not done yet, so a `#id` that lives inside a Bundle entry resolves to empty
 * rather than reaching into that entry's `contained`. Never touches the network:
 * external references quietly resolve to nothing (the async story is a deferred
 * feature, see the README).
 */
registerFunction('resolve', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const result: TypedValue[] = []
    const scope = context.root[0]?.value as ResolveScope | undefined
    for (const item of input) {
      const reference = referenceStringOf(item)
      if (reference === undefined) {
        continue
      }
      const resolved = resolveReference(reference, scope)
      if (resolved !== undefined) {
        result.push(toTypedValue(resolved))
      }
    }
    return result
  },
})

function referenceStringOf(item: TypedValue): string | undefined {
  if (typeof item.value === 'string') {
    return item.value
  }
  if (typeof item.value === 'object' && item.value !== null) {
    const reference = (item.value as { reference?: unknown }).reference
    return typeof reference === 'string' ? reference : undefined
  }
  return undefined
}

interface BundleEntry {
  fullUrl?: unknown
  resource?: { resourceType?: unknown; id?: unknown }
}

interface ResolveScope {
  resourceType?: unknown
  contained?: unknown
  entry?: unknown
}

function resolveReference(reference: string, scope: ResolveScope | undefined): unknown {
  if (!scope) {
    return undefined
  }
  if (reference.startsWith('#')) {
    const id = reference.slice(1)
    if (id === '') {
      return scope
    }
    if (Array.isArray(scope.contained)) {
      return scope.contained.find(resource => (resource as { id?: unknown } | null)?.id === id)
    }
    return undefined
  }
  if (scope.resourceType === 'Bundle' && Array.isArray(scope.entry)) {
    const isAbsolute = reference.includes('://') || reference.startsWith('urn:')
    for (const entry of scope.entry) {
      if (!isObject(entry)) {
        continue
      }
      const { fullUrl, resource } = entry as BundleEntry
      // Absolute references match a fullUrl exactly. Relative references
      // (Type/id) match a resource's own type/id — a fullUrl suffix match alone
      // would wrongly resolve Patient/123 against a different base whose resource
      // id is not 123, so the resource must confirm the type/id.
      if (isAbsolute && fullUrl === reference) {
        return resource
      }
      if (resource && `${String(resource.resourceType)}/${String(resource.id)}` === reference) {
        return resource
      }
    }
  }
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate narrative xhtml against the FHIR rules (real implementation, not a stub). */
registerFunction('htmlChecks', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    return wrapBoolean(typeof item.value === 'string' && validateNarrative(item.value))
  },
})

/** Quantities are comparable when their units share a dimension (FHIR R5 addition). */
registerFunction('comparable', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const left = singleton(input)
    const right = singleton(evaluateNode(argAt(args, 0), context, input))
    if (left === undefined || right === undefined) {
      return []
    }
    const a = promoteQuantity(left)
    const b = promoteQuantity(right)
    if (!(a && b)) {
      throw new FhirPathTypeError('comparable() expects Quantity operands')
    }
    // Dimensions decide comparability, so calendar durations count as their
    // loose UCUM twins: 1 year.comparable(1 second) is true.
    return wrapBoolean(compareQuantities(calendarToUcumLoose(a), calendarToUcumLoose(b)) !== undefined)
  },
})

/**
 * Base-StructureDefinition conformance only: the url must name a core resource type.
 * Real profile validation is a deferred feature (README register).
 */
registerFunction('conformsTo', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    const urlValue = singleton(evaluateNode(argAt(args, 0), context, input))
    const url = typeof urlValue?.value === 'string' ? urlValue.value : ''
    const match = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/([A-Za-z]+)$/.exec(url)
    if (!match) {
      throw new FhirPathRuntimeError(`conformsTo() only supports base StructureDefinition urls, got '${url}'`)
    }
    const resourceType = (item.value as { resourceType?: unknown } | undefined)?.resourceType
    return wrapBoolean(resourceType === match[1])
  },
})

/** Deferred features (see the README register): registered so they fail with a clear message. */
function unsupported(name: string, minArity: number, maxArity: number, reason: string): void {
  registerFunction(name, {
    minArity,
    maxArity,
    evaluate: () => {
      throw new FhirPathRuntimeError(`${name}() is not supported in v1: ${reason}`)
    },
  })
}

unsupported('memberOf', 1, 1, 'terminology functions need a terminology service')
unsupported('subsumes', 1, 1, 'terminology functions need a terminology service')
unsupported('subsumedBy', 1, 1, 'terminology functions need a terminology service')
unsupported('slice', 2, 2, 'profile slicing needs profile definitions')
unsupported('elementDefinition', 0, 0, 'element definitions need profile definitions')
unsupported('checkModifiers', 0, 1, 'modifier checking needs profile definitions')
unsupported('weight', 0, 0, 'item weights need code-system lookups')
