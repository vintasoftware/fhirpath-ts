import type { TypedValue } from '../values/typed-value.ts'

interface ElementOrigin {
  parent: TypedValue
  name: string
}

// Track wrappers, not JSON objects: the same answer or reference object can be
// used in several resources. Keeping a result alive keeps its own ancestry.
const origins = new WeakMap<TypedValue, ElementOrigin>()

export function childValue(value: TypedValue, parent: TypedValue, name: string): TypedValue {
  origins.set(value, { parent, name })
  return value
}

export function elementOrigin(value: TypedValue): ElementOrigin | undefined {
  return origins.get(value)
}

export function* ancestors(value: TypedValue): Generator<TypedValue> {
  let current: TypedValue | undefined = value
  while (current !== undefined) {
    yield current
    current = origins.get(current)?.parent
  }
}
