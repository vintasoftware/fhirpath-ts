import { type TypedValue, typeLocalName } from '../values/typed-value'
import type { EvaluationContext } from './context'

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

/**
 * Does an item satisfy a type specifier? Shared by `is`/`as`, `ofType()`, and later
 * the static analyzer. Resolution order per spec §10.1: the context model's types
 * first, then the System namespace; unqualified names match either.
 */
export function itemMatchesType(context: EvaluationContext, item: TypedValue, parts: string[]): boolean {
  if (parts.length === 2 && parts[0] === 'System') {
    return matchesSystemType(item, parts[1] as string)
  }
  const model = context.model
  if (parts.length === 2) {
    if (model && parts[0] === model.namespace) {
      const canonical = model.resolveType(parts[1] as string)
      return canonical !== undefined && model.isSubtypeOf(item.type, canonical)
    }
    return item.type === parts.join('.')
  }
  const name = parts[0] as string
  // System-typed values answer from the System namespace; FHIR primitive names
  // (boolean, dateTime) reach their System twins here even when a model is active.
  if (item.type.startsWith('System.')) {
    return matchesSystemType(item, name)
  }
  if (model) {
    const canonical = model.resolveType(name)
    if (canonical !== undefined) {
      return model.isSubtypeOf(item.type, canonical)
    }
  }
  // Dynamic fallback: resource and complex types match on their local name.
  return typeLocalName(item.type) === name
}

function matchesSystemType(item: TypedValue, name: string): boolean {
  if (name === 'Any') {
    return true
  }
  if (!item.type.startsWith('System.')) {
    return false
  }
  const local = typeLocalName(item.type)
  if (local === name) {
    return true
  }
  // FHIR primitive spellings (`boolean`, `dateTime`) match their System twins.
  return SYSTEM_LOCAL_NAMES.has(local) && local.toLowerCase() === name.toLowerCase()
}
