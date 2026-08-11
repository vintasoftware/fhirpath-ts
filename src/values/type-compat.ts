/** Shared, conservative type compatibility for runtime dispatch and static checks. */
import type { ModelProvider } from '../model/provider.ts'
import { FHIR_PRIMITIVE_TO_SYSTEM, typeLocalName } from './typed-value.ts'

/** Behavior families used by the static checks. */
export type ValueKind = 'Boolean' | 'String' | 'Numeric' | 'Temporal' | 'Quantity' | 'Complex'

export function valueKindOfTypeName(canonical: string): ValueKind {
  const system = canonical.startsWith('System.') ? canonical : FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(canonical)]
  switch (system) {
    case 'System.Boolean':
      return 'Boolean'
    case 'System.String':
      return 'String'
    case 'System.Integer':
    case 'System.Long':
    case 'System.Decimal':
      return 'Numeric'
    case 'System.Date':
    case 'System.DateTime':
    case 'System.Time':
      return 'Temporal'
    case 'System.Quantity':
      return 'Quantity'
    default:
      return canonical === 'FHIR.Quantity' || typeLocalName(canonical) === 'Quantity' ? 'Quantity' : 'Complex'
  }
}

/** The behavior kind shared by every known candidate type. */
export function commonValueKind(types: readonly string[] | undefined): ValueKind | undefined {
  if (types === undefined || types.length === 0) {
    return undefined
  }
  let found: ValueKind | undefined
  for (const type of types) {
    const next = valueKindOfTypeName(type)
    if (found !== undefined && found !== next) {
      return undefined
    }
    found = next
  }
  return found
}

/**
 * Resolves a focus type through its full name, then its local name. Unknown names
 * return undefined so callers can skip claims the model cannot support.
 */
export function canonicalFocusType(model: ModelProvider, raw: string): string | undefined {
  if (raw.startsWith('System.')) {
    return raw
  }
  return model.resolveType(raw) ?? model.resolveType(typeLocalName(raw))
}

/** True when every `type` value is a `base` value, including FHIR-primitive → System subtyping. */
function typeSatisfies(model: ModelProvider, type: string, base: string): boolean {
  if (type === base || model.isSubtypeOf(type, base)) {
    return true
  }
  return base.startsWith('System.') && FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(type)] === base
}

/**
 * Returns whether one value may have both types. Compatible value kinds and
 * either direction of the model hierarchy count. The model check must still run
 * when kinds differ because `SimpleQuantity` and `Quantity` use different kinds.
 */
export function typesOverlap(model: ModelProvider, a: string, b: string): boolean {
  const kind = valueKindOfTypeName(a)
  if (kind !== 'Complex' && kind === valueKindOfTypeName(b)) {
    return true
  }
  return typeSatisfies(model, a, b) || typeSatisfies(model, b, a)
}

/**
 * The proof that a call is on the wrong focus: `wanted` lists the declared
 * types and `found` lists the focus types, both as canonical names with
 * duplicates removed. Callers report those two lists and add nothing of their
 * own.
 */
export interface UnsatisfiedInput {
  wanted: string[]
  found: string[]
}

/**
 * Returns proof only when every known focus type is incompatible with every
 * declared input type. Missing models, unknown types, empty focus, and any
 * matching type remain allowed. Runtime dispatch and the analyzer share this
 * decision and report it in their own way.
 */
export function unsatisfiedInput(
  model: ModelProvider | undefined,
  declared: readonly string[] | undefined,
  focus: Iterable<string>
): UnsatisfiedInput | undefined {
  if (model === undefined || declared === undefined) {
    return undefined
  }
  const wanted = declared
    .map(type => canonicalFocusType(model, type))
    .filter((type): type is string => type !== undefined)
  if (wanted.length === 0) {
    return undefined
  }
  const found = new Set<string>()
  for (const type of focus) {
    const canonical = canonicalFocusType(model, type)
    if (canonical === undefined || wanted.some(want => typesOverlap(model, canonical, want))) {
      return undefined
    }
    found.add(canonical)
  }
  return found.size === 0 ? undefined : { wanted, found: [...found] }
}

/** Either the declaration a call resolves to, or the proof that none of them fits. */
export type InputResolution<T> = { resolved: T } | { unsatisfied: UnsatisfiedInput }

/**
 * Selects the first same-name declaration accepted by the focus. If none fits,
 * the result combines their expected and found types into one error. Unknown or
 * empty focus selects the first declaration; registration prevents ambiguous
 * known focus types.
 */
export function resolveByInput<T>(
  model: ModelProvider | undefined,
  candidates: readonly T[],
  declaredTypesOf: (candidate: T) => readonly string[] | undefined,
  focus: readonly string[]
): InputResolution<T> {
  const misses: UnsatisfiedInput[] = []
  for (const candidate of candidates) {
    const miss = unsatisfiedInput(model, declaredTypesOf(candidate), focus)
    if (miss === undefined) {
      return { resolved: candidate }
    }
    misses.push(miss)
  }
  return {
    unsatisfied: {
      wanted: [...new Set(misses.flatMap(miss => miss.wanted))],
      found: [...new Set(misses.flatMap(miss => miss.found))],
    },
  }
}
