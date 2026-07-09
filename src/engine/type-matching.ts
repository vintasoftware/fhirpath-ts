import { OBJECT_TYPE, type TypedValue, typeLocalName } from '../values/typed-value.ts'
import type { EvaluationContext } from './context.ts'

const SYSTEM_LOCAL_NAMES = new Set([
  'Any',
  'Boolean',
  'String',
  'Integer',
  'Long',
  'Decimal',
  'Date',
  'DateTime',
  'Time',
  'Quantity',
])

const SYSTEM_LOCAL_NAMES_LOWER = new Set([...SYSTEM_LOCAL_NAMES].map(name => name.toLowerCase()))

/**
 * Does the requested type name alias a System type (`string`, `boolean`, ...)? This
 * is the narrow case the official suite pins `as`/`ofType` to an exact match on
 * (`Patient.gender.as(string)` is empty even though `code` is a subtype of `string`,
 * per testFHIRPathAsFunction11's "Contested: code type is a subtype of string").
 * Structural FHIR names (`DomainResource`, `Element`, `Resource`, ...) are never
 * ambiguous this way, so they keep normal subtype matching for `as`/`ofType` too.
 */
function isSystemAmbiguousName(name: string): boolean {
  return SYSTEM_LOCAL_NAMES_LOWER.has(name.toLowerCase())
}

/**
 * Does an item satisfy a type specifier? Shared by `is`/`as`/`ofType()` and the
 * static analyzer. Resolution order per spec §10.1: the context model's types
 * first, then the System namespace. `is` always walks subtypes; `as`/`ofType`
 * do too, except when the requested name aliases a System primitive, where the
 * official inheritance tests pin an exact match instead (see isSystemAmbiguousName).
 */
export function itemMatchesType(
  context: EvaluationContext,
  item: TypedValue,
  parts: string[],
  options?: { exact?: boolean }
): boolean {
  const exact = options?.exact === true
  if (parts.length === 2 && parts[0] === 'System') {
    // FHIR-typed values do not answer System-qualified questions (testType14).
    // System type names are case-sensitive, so `System.STRING` is not `System.String`
    // (the lowercase fallback in matchesSystemType is only for unqualified names).
    const systemName = parts[1] as string
    return systemName === 'Any' ? item.type.startsWith('System.') : item.type === `System.${systemName}`
  }
  const model = context.model
  if (parts.length === 2) {
    if (model && parts[0] === model.namespace) {
      const typeName = parts[1] as string
      const canonical = model.resolveType(typeName)
      if (canonical === undefined) {
        return false
      }
      return exact && isSystemAmbiguousName(typeName)
        ? item.type === canonical
        : model.isSubtypeOf(item.type, canonical)
    }
    return item.type === parts.join('.')
  }
  const name = parts[0] as string
  // System-typed values answer from the System namespace.
  if (item.type.startsWith('System.')) {
    return matchesSystemType(item, name)
  }
  if (model) {
    const canonical = model.resolveType(name)
    if (canonical !== undefined) {
      return exact && isSystemAmbiguousName(name) ? item.type === canonical : model.isSubtypeOf(item.type, canonical)
    }
  }
  // Dynamic fallback: resource and complex types match on their local name. The
  // internal Object marker never answers a type question — `ofType(Object)` is not
  // a way to select untyped values.
  return item.type !== OBJECT_TYPE && typeLocalName(item.type) === name
}

/** True when a single-part type name resolves in the model or the System namespace. */
export function isKnownTypeName(context: EvaluationContext, parts: string[]): boolean {
  if (parts.length === 2) {
    return parts[0] === 'System' ? SYSTEM_LOCAL_NAMES.has(parts[1] as string) : parts[0] === context.model?.namespace
  }
  const name = parts[0] as string
  if (context.model?.resolveType(name) !== undefined) {
    return true
  }
  return SYSTEM_LOCAL_NAMES.has(name)
}

function matchesSystemType(item: TypedValue, name: string): boolean {
  if (name === 'Any') {
    return true
  }
  const local = typeLocalName(item.type)
  if (local === name) {
    return true
  }
  // Lowercase FHIR spellings (`boolean`, `dateTime`) reach the System twin.
  return local.toLowerCase() === name.toLowerCase()
}
