import type { Temporal } from './datetime'
import { Decimal } from './decimal'

export const SYSTEM_BOOLEAN = 'System.Boolean'
export const SYSTEM_STRING = 'System.String'
export const SYSTEM_INTEGER = 'System.Integer'
export const SYSTEM_LONG = 'System.Long'
export const SYSTEM_DECIMAL = 'System.Decimal'
export const SYSTEM_DATE = 'System.Date'
export const SYSTEM_DATETIME = 'System.DateTime'
export const SYSTEM_TIME = 'System.Time'
export const SYSTEM_QUANTITY = 'System.Quantity'

/** Placeholder type for plain objects when no model knows better. */
export const OBJECT_TYPE = 'Object'

/** A minimal Quantity value; unit algebra and UCUM conversion land in the quantity phase. */
export interface QuantityValue {
  value: Decimal
  unit: string
  /** True for calendar duration units (`4 days`), false for UCUM strings (`4 'd'`). */
  calendar: boolean
}

/**
 * A value paired with its type name, e.g. `System.Integer` or `FHIR.Patient`.
 * Runtime representations: Boolean → boolean, String → string, Integer → number,
 * Long → bigint, Decimal → Decimal, Date/DateTime/Time → Temporal,
 * Quantity → QuantityValue, complex types → raw JSON.
 */
export interface TypedValue {
  type: string
  value: unknown
}

/** The local part of a qualified type name: `System.Boolean` → `Boolean`. */
export function typeLocalName(type: string): string {
  const separator = type.lastIndexOf('.')
  return separator === -1 ? type : type.slice(separator + 1)
}

/** Wrap a raw JSON value, inferring System types where possible. */
export function toTypedValue(value: unknown): TypedValue {
  if (typeof value === 'boolean') {
    return { type: SYSTEM_BOOLEAN, value }
  }
  if (typeof value === 'string') {
    return { type: SYSTEM_STRING, value }
  }
  if (typeof value === 'bigint') {
    return { type: SYSTEM_LONG, value }
  }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      return { type: SYSTEM_INTEGER, value }
    }
    return { type: SYSTEM_DECIMAL, value: Decimal.fromNumber(value) }
  }
  if (value instanceof Decimal) {
    return { type: SYSTEM_DECIMAL, value }
  }
  if (isResource(value)) {
    return { type: `FHIR.${value.resourceType}`, value }
  }
  return { type: OBJECT_TYPE, value }
}

function isResource(value: unknown): value is { resourceType: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { resourceType?: unknown }).resourceType === 'string'
  )
}

/** Wrap an input (single value, array, or undefined) as a collection. */
export function toCollection(value: unknown): TypedValue[] {
  if (value === undefined || value === null) {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => toCollection(item))
  }
  return [toTypedValue(value)]
}

/** Unwrap for the public API: internal value objects become plain JS values. */
export function unwrap(typed: TypedValue): unknown {
  const value = typed.value
  if (value instanceof Decimal) {
    return value.toNumber()
  }
  if (isTemporal(value)) {
    return value.toString()
  }
  if (isQuantity(typed)) {
    const quantity = value as QuantityValue
    return { value: quantity.value.toNumber(), unit: quantity.unit }
  }
  return value
}

function isTemporal(value: unknown): value is Temporal {
  return typeof value === 'object' && value !== null && 'kind' in value && 'toLiteralString' in value
}

function isQuantity(typed: TypedValue): boolean {
  return typed.type === SYSTEM_QUANTITY
}
