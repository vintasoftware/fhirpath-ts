import type { TypedValue } from '../values/typed-value.ts'

interface ElementOrigin {
  parent: TypedValue
  name: string
}

// A base constructor that returns its argument lets a subclass add a private
// field to an existing object. The field is invisible to Object.keys, JSON, and
// deep equality, and costs a property store; a WeakMap entry per navigated
// child would make navigation several times slower.
class Stamp {
  constructor(value: TypedValue) {
    return value
  }
}

// Track wrappers, not JSON objects: the same answer or reference object can be
// used in several resources. Keeping a result alive keeps its own ancestry.
class Origin extends Stamp {
  #origin: ElementOrigin

  constructor(value: TypedValue, origin: ElementOrigin) {
    super(value)
    this.#origin = origin
  }

  static of(value: TypedValue): ElementOrigin | undefined {
    return #origin in value ? value.#origin : undefined
  }
}

export function childValue(value: TypedValue, parent: TypedValue, name: string): TypedValue {
  new Origin(value, { parent, name })
  return value
}

export function elementOrigin(value: TypedValue): ElementOrigin | undefined {
  return Origin.of(value)
}

export function* ancestors(value: TypedValue): Generator<TypedValue> {
  let current: TypedValue | undefined = value
  while (current !== undefined) {
    yield current
    current = Origin.of(current)?.parent
  }
}
