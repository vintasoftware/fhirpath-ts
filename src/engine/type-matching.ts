import { FhirPathTypeError } from '../errors.ts'
import {
  resolveByInput,
  SYSTEM_TYPE_LOCAL_NAMES,
  type UnsatisfiedInput,
  unsatisfiedInput,
} from '../values/type-compat.ts'
import { OBJECT_TYPE, systemTypeOf, type TypedValue, typeLocalName } from '../values/typed-value.ts'
import type { EvaluationContext, HostFunction, HostSingleFunction } from './context.ts'

// `Quantity` is left out: FHIR's Quantity is a complex type whose subtypes
// (Age, Duration, ...) `as` and `ofType` return, as `is` does.
const SYSTEM_PRIMITIVE_NAMES_LOWER = new Set(
  [...SYSTEM_TYPE_LOCAL_NAMES].filter(name => name !== 'Quantity').map(name => name.toLowerCase())
)

/** True when an unqualified name may mean a System primitive and requires exact `as`/`ofType` matching. */
function isSystemAmbiguousName(name: string): boolean {
  return SYSTEM_PRIMITIVE_NAMES_LOWER.has(name.toLowerCase())
}

/**
 * Does an item satisfy a type specifier, for the `is`, `ofType`, or `as` test?
 * Resolution order per spec "Models": the context model's types first, then the
 * System namespace. `is` always walks subtypes; `ofType` and `as` do too, except
 * when the requested name aliases a System primitive, where the official
 * inheritance tests pin an exact match instead (see isSystemAmbiguousName).
 *
 * `as` also casts: a FHIR primitive with a value matches the System type it
 * converts to (FHIR R4 FHIRPath page: `Patient.name.given.as(System.string)` is
 * valid). `is` and `ofType` keep the type identity, so a FHIR string is not a
 * System.String there (testType14).
 */
export function itemMatchesType(
  context: EvaluationContext,
  item: TypedValue,
  parts: string[],
  mode: 'is' | 'ofType' | 'as'
): boolean {
  const exact = mode !== 'is'
  const cast = mode === 'as'
  if (parts.length === 2 && parts[0] === 'System') {
    // System type names are case-sensitive, so `System.STRING` is not `System.String`
    // (the lowercase fallback in matchesSystemType is only for unqualified names).
    const systemName = parts[1] as string
    if (systemName === 'Any') {
      return item.type.startsWith('System.')
    }
    return item.type === `System.${systemName}` || (cast && convertsTo(item, systemName))
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
  // A name the model does not define falls back to the System namespace.
  if (cast && SYSTEM_TYPE_LOCAL_NAMES.has(name) && convertsTo(item, name)) {
    return true
  }
  // Dynamic fallback: resource and complex types match on their local name. The
  // internal Object marker never answers a type question — `ofType(Object)` is not
  // a way to select untyped values.
  return item.type !== OBJECT_TYPE && typeLocalName(item.type) === name
}

/**
 * Selects a host function by focus type. Same-name overloads use registration
 * order. If none accepts the focus, one error lists all accepted input types.
 */
export function resolveHostCall(
  name: string,
  host: HostFunction,
  context: EvaluationContext,
  input: TypedValue[]
): HostSingleFunction {
  if (!('overloads' in host)) {
    // `unsatisfiedInput` handles an undeclared input too. Returning first is
    // what stops the many host functions that declare no types from walking the
    // focus at all.
    if (host.inputTypes === undefined) {
      return host
    }
    const unsatisfied = unsatisfiedInput(context.model, host.inputTypes, focusTypes(input))
    if (unsatisfied === undefined) {
      return host
    }
    throw wrongFocus(name, unsatisfied)
  }
  const resolution = resolveByInput(
    context.model,
    host.overloads,
    overload => overload.inputTypes,
    input.map(item => item.type)
  )
  if ('resolved' in resolution) {
    return resolution.resolved
  }
  throw wrongFocus(name, resolution.unsatisfied)
}

function wrongFocus(name: string, { wanted, found }: UnsatisfiedInput): FhirPathTypeError {
  return new FhirPathTypeError(
    `Function '${name}' expects ${wanted.join(' | ')} as input, but the focus is ${found.join(' | ')}`
  )
}

/** The focus's type names, read one at a time. A valid call stops at the first item that fits. */
function* focusTypes(input: TypedValue[]): Iterable<string> {
  for (const item of input) {
    yield item.type
  }
}

/** True when a single-part type name resolves in the model or the System namespace. */
export function isKnownTypeName(context: EvaluationContext, parts: string[]): boolean {
  if (parts.length === 2) {
    return parts[0] === 'System'
      ? SYSTEM_TYPE_LOCAL_NAMES.has(parts[1] as string)
      : parts[0] === context.model?.namespace
  }
  const name = parts[0] as string
  if (context.model?.resolveType(name) !== undefined) {
    return true
  }
  return SYSTEM_TYPE_LOCAL_NAMES.has(name)
}

/** True when a FHIR primitive with a value converts to `System.<systemName>`. */
function convertsTo(item: TypedValue, systemName: string): boolean {
  return item.value !== undefined && systemTypeOf(item) === `System.${systemName}`
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
