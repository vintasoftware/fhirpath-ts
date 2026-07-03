import type { ElementInfo, ModelProvider } from '../model/provider'
import { Temporal } from '../values/datetime'
import { Decimal } from '../values/decimal'
import { type TypedValue, toTypedValue } from '../values/typed-value'

/** FHIR primitive type names to their System twins (FHIR spec "types" page). */
const PRIMITIVE_TO_SYSTEM: Readonly<Record<string, string>> = {
  boolean: 'System.Boolean',
  integer: 'System.Integer',
  positiveInt: 'System.Integer',
  unsignedInt: 'System.Integer',
  integer64: 'System.Long',
  decimal: 'System.Decimal',
  date: 'System.Date',
  dateTime: 'System.DateTime',
  instant: 'System.DateTime',
  time: 'System.Time',
  string: 'System.String',
  code: 'System.String',
  id: 'System.String',
  markdown: 'System.String',
  uri: 'System.String',
  url: 'System.String',
  canonical: 'System.String',
  oid: 'System.String',
  uuid: 'System.String',
  base64Binary: 'System.String',
  xhtml: 'System.String',
}

export function isFhirPrimitiveType(typeName: string): boolean {
  return PRIMITIVE_TO_SYSTEM[typeName] !== undefined
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
        return convertValues(record[key], record[`_${key}`], typeName, info)
      }
    }
    return []
  }
  const raw = record[name]
  if (raw === undefined || raw === null) {
    // A primitive may be present through its `_field` sibling alone.
    const sibling = record[`_${name}`]
    if (sibling !== undefined && sibling !== null && isFhirPrimitiveType(info.types[0] as string)) {
      return convertValues(undefined, sibling, info.types[0] as string, info)
    }
    return []
  }
  return convertValues(raw, record[`_${name}`], info.types[0] as string, info)
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

function convertValues(raw: unknown, sibling: unknown, typeName: string, info: ElementInfo): TypedValue[] {
  if (Array.isArray(raw) || (raw === undefined && Array.isArray(sibling))) {
    const values = Array.isArray(raw) ? raw : new Array((sibling as unknown[]).length).fill(undefined)
    const siblings = Array.isArray(sibling) ? sibling : []
    const result: TypedValue[] = []
    values.forEach((element, index) => {
      const converted = convertSingle(element, siblings[index], typeName)
      if (converted) {
        result.push(converted)
      }
    })
    return result
  }
  if (info.isCollection && raw !== undefined && !Array.isArray(raw)) {
    // Collection element with a single JSON value still yields one item.
    const converted = convertSingle(raw, sibling, typeName)
    return converted ? [converted] : []
  }
  const converted = convertSingle(raw, sibling, typeName)
  return converted ? [converted] : []
}

function convertSingle(raw: unknown, sibling: unknown, typeName: string): TypedValue | undefined {
  if ((raw === undefined || raw === null) && (sibling === undefined || sibling === null)) {
    return undefined
  }
  const systemType = PRIMITIVE_TO_SYSTEM[typeName]
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
  const typed: TypedValue = { type: systemType, value: parsePrimitive(raw, systemType) }
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
    case 'System.Long': {
      return typeof raw === 'number' ? BigInt(raw) : raw
    }
    default:
      return raw
  }
}
