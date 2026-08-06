/**
 * Whether a value of one type can also be a value of another. Both halves of the
 * input-type check ask this. The engine asks it about a call's real focus (see
 * `requireHostInput` in engine/type-matching.ts), and the analyzer asks it about
 * the types it inferred (see `checkCallInput` in analyzer/analyze.ts). Those two
 * modules must not import each other, so the rule lives here, below both.
 *
 * Every answer here is deliberately permissive. When a check cannot prove that
 * two types are incompatible, it says nothing. Reporting valid code is worse
 * than missing a mistake.
 */
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

/**
 * Returns the canonical model name for a type name, or undefined when the model
 * does not know it. Every caller treats undefined as "say nothing".
 *
 * The full name is tried before its local part. A model resolves backbone paths
 * under their full name (`Patient.contact`), but canonical names only under
 * their local one, because `resolveType` does not strip its own prefix, so
 * `FHIR.Patient` resolves as `Patient`. The undefined result is what keeps the
 * check quiet for values no model describes: the `Object` placeholder, System
 * types, and a `FHIR.`-prefixed name under a model of another namespace.
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
 * Can one value be both an `a` and a `b`? Either direction of the model's
 * hierarchy counts. A declared `Quantity` accepts a `SimpleQuantity` focus, and
 * the other way round.
 *
 * The value-kind test covers the pairs the model cannot connect, and only those.
 * Those pairs are `System.Quantity` (a quantity literal, or `toQuantity()`)
 * against `FHIR.Quantity`, and sibling primitives that behave the same way, such
 * as `code` and `uri`, which are both Strings. Run the model test even when the
 * kinds differ. `FHIR.SimpleQuantity` has kind `Complex` while `FHIR.Quantity`
 * has kind `Quantity`, so testing kinds first would reject a valid call.
 */
export function typesOverlap(model: ModelProvider, a: string, b: string): boolean {
  const kind = valueKindOfTypeName(a)
  if (kind !== 'Complex' && kind === valueKindOfTypeName(b)) {
    return true
  }
  return typeSatisfies(model, a, b) || typeSatisfies(model, b, a)
}

/**
 * Decides whether a function written for the `declared` types can be running on
 * this focus. Returns undefined when the call may be valid. Returns an object
 * when the call is definitely wrong, where `wanted` lists the declared types and
 * `found` lists the focus types, both as canonical names with duplicates
 * removed. Callers report those two lists and add nothing of their own.
 *
 * This is the whole rule for both halves of the input-type check. The engine
 * passes a call's real values (`requireHostInput`) and the analyzer passes the
 * types it inferred (`checkCallInput`). They must agree on what counts as a
 * mistake, so each one only decides how to report it.
 *
 * Anything unprovable counts as valid: no model, no declaration, a declared name
 * the model rejects, a focus type the model has never heard of (the `Object`
 * placeholder, a datatype root, plain host data), a focus with no values, and
 * any focus where one type fits, since one is enough. The loop stops at that
 * first fitting type, so a valid call does not canonicalize the whole
 * collection.
 */
export function unsatisfiedInput(
  model: ModelProvider | undefined,
  declared: readonly string[] | undefined,
  focus: Iterable<string>
): { wanted: string[]; found: string[] } | undefined {
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
