import { FhirPathTypeError } from '../errors.ts'
import {
  resolveByInput,
  SYSTEM_TYPE_LOCAL_NAMES,
  type UnsatisfiedInput,
  unsatisfiedInput,
} from '../values/type-compat.ts'
import { OBJECT_TYPE, type TypedValue, typeLocalName } from '../values/typed-value.ts'
import type { EvaluationContext, HostFunction, HostSingleFunction } from './context.ts'

const SYSTEM_LOCAL_NAMES_LOWER = new Set([...SYSTEM_TYPE_LOCAL_NAMES].map(name => name.toLowerCase()))

/** True when an unqualified name may mean a System primitive and requires exact `as`/`ofType` matching. */
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
