/**
 * Whether a value of one type can also be a value of another — the question both
 * halves of the input-type check ask. The runtime asks it of a call's real focus
 * (`requireHostInput`, engine/type-matching.ts) and the analyzer asks it of the
 * inferred candidates (`checkCallInput`, analyzer/analyze.ts); those two live in
 * trees that must not import each other, so the rule lives here, below both.
 *
 * Everything here is deliberately permissive: a check that cannot prove
 * incompatibility says nothing, because reporting valid code is worse than
 * missing a mistake.
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
 * The canonical model name for a type the runtime or the analyzer is holding, or
 * undefined when the model does not know it — which every caller reads as "say
 * nothing".
 *
 * The raw name is tried before its local part, because a model resolves backbone
 * paths under their full name (`Patient.contact`) and canonical names under their
 * local one (`FHIR.Patient` resolves only as `Patient`, since `resolveType` does
 * not strip its own prefix). The undefined result is what keeps the check quiet
 * for values no model describes: the `Object` placeholder, System types, and a
 * `FHIR.`-prefixed name under a model of some other namespace.
 */
export function canonicalFocusType(model: ModelProvider, raw: string): string | undefined {
  if (raw.startsWith('System.')) {
    return raw
  }
  return model.resolveType(raw) ?? model.resolveType(typeLocalName(raw))
}

/** True when every `type` value is a `base` value, including FHIR-primitive → System subtyping. */
export function typeSatisfies(model: ModelProvider, type: string, base: string): boolean {
  if (type === base || model.isSubtypeOf(type, base)) {
    return true
  }
  return base.startsWith('System.') && FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(type)] === base
}

/**
 * Can one value be both an `a` and a `b`? Either direction of the model's
 * hierarchy counts, so a declared `Quantity` accepts a `SimpleQuantity` focus and
 * the other way round.
 *
 * The kind clause covers the pairs the model cannot bridge, and only those:
 * `System.Quantity` (a quantity literal, `toQuantity()`) against `FHIR.Quantity`,
 * and sibling primitives that behave identically (`code` and `uri` are both
 * Strings). It deliberately does not gate the model check — `FHIR.SimpleQuantity`
 * has kind `Complex` while `FHIR.Quantity` has kind `Quantity`, so a kind
 * prefilter would reject a legitimate call.
 */
export function typesOverlap(model: ModelProvider, a: string, b: string): boolean {
  const kind = valueKindOfTypeName(a)
  if (kind !== 'Complex' && kind === valueKindOfTypeName(b)) {
    return true
  }
  return typeSatisfies(model, a, b) || typeSatisfies(model, b, a)
}
