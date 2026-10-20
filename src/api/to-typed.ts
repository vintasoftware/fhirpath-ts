import { FhirPathTypeError } from '../errors.ts'
import { brandTyped } from '../fhir/element-origin.ts'
import { convertSingle } from '../fhir/model-navigation.ts'
import { childrenOf } from '../functions/tree.ts'
import type { ModelProvider } from '../model/provider.ts'
import { toTypedValue, type TypedValue } from '../values/typed-value.ts'

/** Where `toTyped()` finds the value: the resource that holds it, so the value keeps its ancestry. */
export interface ToTypedOptions {
  in?: unknown
}

/**
 * Type a JSON value as `type`. With `options.in`, the value is found by object
 * identity inside that resource, so it is attached: `%resource`, `resolve()`,
 * `weight()`, and `pathname()` see the resource around it. Without it, the
 * value is unattached.
 */
export function toTyped(
  value: unknown,
  type: string,
  model: ModelProvider | undefined,
  options: ToTypedOptions | undefined
): TypedValue[] {
  if (model === undefined) {
    throw new FhirPathTypeError('toTyped() needs an engine with a model')
  }
  const declared = model.resolveType(type)
  if (declared === undefined) {
    throw new FhirPathTypeError(`toTyped(): unknown type '${type}'`)
  }
  const typed = options?.in === undefined ? unattached(value, declared, model) : locate(value, options.in, model)
  if (typed === undefined || !model.isSubtypeOf(typed.type, declared)) {
    throw new FhirPathTypeError(`toTyped(): the value is ${typed?.type ?? 'empty'}, not ${declared}`)
  }
  return brandTyped([typed])
}

function unattached(value: unknown, declared: string, model: ModelProvider): TypedValue | undefined {
  // A resource states its own type; the check against `declared` follows.
  if (typeof (value as { resourceType?: unknown } | null)?.resourceType === 'string') return toTypedValue(value)
  return convertSingle(value, undefined, declared.slice(model.namespace.length + 1))
}

/** The one typed value in `resource` whose JSON value is `value`. */
function locate(value: unknown, resource: unknown, model: ModelProvider): TypedValue {
  if (typeof value !== 'object' || value === null) {
    throw new FhirPathTypeError(
      'toTyped(): a primitive cannot be found by identity; reach it with evaluateTyped() on the resource'
    )
  }
  const root = toTypedValue(resource)
  if (typeof (resource as { resourceType?: unknown } | null)?.resourceType !== 'string') {
    throw new FhirPathTypeError("toTyped(): 'in' must be a resource")
  }
  const found: TypedValue[] = []
  const pending = [root]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.value === value) found.push(node)
    pending.push(...childrenOf(node, model))
  }
  if (found.length === 0) {
    throw new FhirPathTypeError("toTyped(): the value is not inside the resource given as 'in'")
  }
  if (found.length > 1) {
    throw new FhirPathTypeError(
      "toTyped(): the value appears more than once in the resource given as 'in'; reach it with evaluateTyped()"
    )
  }
  return found[0] as TypedValue
}
