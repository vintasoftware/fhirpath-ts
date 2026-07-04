import type { ModelProvider } from '../model/provider.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { FHIR_PRIMITIVE_TO_SYSTEM, type TypedValue, toTypedValue } from '../values/typed-value.ts'

export function isFhirPrimitiveType(typeName: string): boolean {
  return FHIR_PRIMITIVE_TO_SYSTEM[typeName] !== undefined
}

/**
 * Read one element with model knowledge: choice elements resolve their suffixed
 * JSON key, primitives parse into System values (dates become Temporal, decimals
 * become Decimal) and carry their `_field` sibling for extension/id access.
 * Undefined when the model does not know the element.
 */
export function readModelProperty(model: ModelProvider, item: TypedValue, name: string): TypedValue[] | undefined {
  const metadata = readPrimitiveMetadata(item, name)
  if (metadata !== undefined) {
    return metadata
  }
  const info = model.getElement(item.type, name)
  if (!info) {
    return undefined
  }
  const container = item.value
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return []
  }
  const record = container as Record<string, unknown>
  if (info.isChoice) {
    for (const typeName of info.types) {
      const key = name + typeName.charAt(0).toUpperCase() + typeName.slice(1)
      if (record[key] !== undefined && record[key] !== null) {
        return convertValues(record[key], record[`_${key}`], typeName)
      }
      // A choice primitive may be present through its `_field` sibling alone,
      // e.g. { _valueString: { extension: [...] } } with no valueString.
      const sibling = record[`_${key}`]
      if (sibling !== undefined && sibling !== null && isFhirPrimitiveType(typeName)) {
        return convertValues(undefined, sibling, typeName)
      }
    }
    return []
  }
  const raw = record[name]
  if (raw === undefined || raw === null) {
    // A primitive may be present through its `_field` sibling alone.
    const sibling = record[`_${name}`]
    if (sibling !== undefined && sibling !== null && isFhirPrimitiveType(info.types[0] as string)) {
      return convertValues(undefined, sibling, info.types[0] as string)
    }
    return []
  }
  return convertValues(raw, record[`_${name}`], info.types[0] as string)
}

/** `id` and `extension` on an already-navigated primitive come from its `_field` sibling. */
function readPrimitiveMetadata(item: TypedValue, name: string): TypedValue[] | undefined {
  if (item.primitiveElement === undefined || (name !== 'id' && name !== 'extension')) {
    return undefined
  }
  const metadata = item.primitiveElement as Record<string, unknown>
  const value = metadata[name]
  if (value === undefined || value === null) {
    return []
  }
  if (name === 'id') {
    return [{ type: 'System.String', value }]
  }
  return (Array.isArray(value) ? value : [value]).map(extension => ({
    type: 'FHIR.Extension',
    value: extension,
  }))
}

function convertValues(raw: unknown, sibling: unknown, typeName: string): TypedValue[] {
  if (Array.isArray(raw) || Array.isArray(sibling)) {
    // The value and _name arrays align by index and either may be the longer one:
    // a tail entry present only in _name is still an element (with extensions).
    const values = Array.isArray(raw) ? raw : []
    const siblings = Array.isArray(sibling) ? sibling : []
    const result: TypedValue[] = []
    for (let index = 0; index < Math.max(values.length, siblings.length); index++) {
      const converted = convertSingle(values[index], siblings[index], typeName)
      if (converted) {
        result.push(converted)
      }
    }
    return result
  }
  const converted = convertSingle(raw, sibling, typeName)
  return converted ? [converted] : []
}

function convertSingle(raw: unknown, sibling: unknown, typeName: string): TypedValue | undefined {
  if ((raw === undefined || raw === null) && (sibling === undefined || sibling === null)) {
    return undefined
  }
  // Element ids and primitive value elements carry System types directly.
  if (typeName.startsWith('System.')) {
    return raw === undefined || raw === null ? undefined : { type: typeName, value: raw }
  }
  const systemType = FHIR_PRIMITIVE_TO_SYSTEM[typeName]
  if (systemType === undefined) {
    // Complex, backbone, or resource element.
    if (raw === undefined || raw === null) {
      return undefined
    }
    if (typeName === 'Resource' || typeName === 'DomainResource') {
      return toTypedValue(raw)
    }
    return { type: `FHIR.${typeName}`, value: raw }
  }
  // FHIR primitives keep their FHIR type (the official type() and is() tests rely
  // on it) while the value itself parses into the System representation.
  const typed: TypedValue = { type: `FHIR.${typeName}`, value: parsePrimitive(raw, systemType) }
  if (sibling !== undefined && sibling !== null) {
    typed.primitiveElement = sibling
  }
  return typed
}

function parsePrimitive(raw: unknown, systemType: string): unknown {
  if (raw === undefined || raw === null) {
    return undefined
  }
  switch (systemType) {
    case 'System.Date': {
      return typeof raw === 'string' ? (Temporal.parseDate(raw) ?? raw) : raw
    }
    case 'System.DateTime': {
      return typeof raw === 'string' ? (Temporal.parseDateTime(raw) ?? raw) : raw
    }
    case 'System.Time': {
      return typeof raw === 'string' ? (Temporal.parseTime(raw) ?? raw) : raw
    }
    case 'System.Decimal': {
      const parsed = typeof raw === 'number' ? Decimal.fromNumber(raw) : Decimal.fromString(String(raw))
      return parsed ?? raw
    }
    /* v8 ignore next 3 -- R4 has no integer64 elements; kept for R5 model reuse */
    case 'System.Long': {
      return typeof raw === 'number' ? BigInt(raw) : raw
    }
    default:
      return raw
  }
}
