import type { TypedValue } from '../values/typed-value.ts'

/** One step of an item's path inside its resource: the element it was read from and its position there. */
export interface ElementOrigin {
  /** The item that holds the element. */
  parent: TypedValue
  /** The element name: the FHIRPath name for a choice element (`value`), the JSON key otherwise. */
  name: string
  /** The position in the element's JSON array; undefined when the JSON value is not an array. */
  index: number | undefined
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
// A stamp of `null` marks a typed value with no parent: an evaluation's input
// or computed result, or an unattached value. The stamp is also the brand that
// tells a typed value from JSON of the same shape (`Identifier` has `type` and
// `value` too).
class Origin extends Stamp {
  #origin: ElementOrigin | null

  constructor(value: TypedValue, origin: ElementOrigin | null) {
    super(value)
    this.#origin = origin
  }

  static of(value: TypedValue): ElementOrigin | undefined {
    return #origin in value ? (value.#origin ?? undefined) : undefined
  }

  static has(value: unknown): value is TypedValue {
    return typeof value === 'object' && value !== null && #origin in value
  }
}

/** Record that `value` was read from element `name` of `parent`, at `index` when that element is an array. */
export function childValue(value: TypedValue, parent: TypedValue, name: string, index?: number): TypedValue {
  new Origin(value, { parent, name, index })
  return value
}

/**
 * Brand the values an evaluation returns, so a later evaluation takes them as
 * typed input. A value read by navigation already carries its origin.
 */
export function brandTyped(values: TypedValue[]): TypedValue[] {
  for (const value of values) {
    if (!Origin.has(value)) new Origin(value, null)
  }
  return values
}

/** True for a value an evaluation returned or `toTyped()` built, never for JSON. */
export function isTypedValue(value: unknown): value is TypedValue {
  return Origin.has(value)
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

function isResourceValue(value: TypedValue): boolean {
  const raw = value.value
  return typeof raw === 'object' && raw !== null && typeof (raw as { resourceType?: unknown }).resourceType === 'string'
}

/** The nearest resource in a value's ancestry, the value itself included: what `%resource` refers to. */
export function owningResource(value: TypedValue): TypedValue | undefined {
  for (const node of ancestors(value)) {
    if (isResourceValue(node)) return node
  }
  return undefined
}

/** `%rootResource` for an owning resource: the container of a contained resource, else the resource. */
export function rootResourceOf(resource: TypedValue): TypedValue {
  const origin = Origin.of(resource)
  return origin?.name === 'contained' ? origin.parent : resource
}
