import { FhirPathTypeError } from '../errors.ts'
import type { ElementInfo, ModelProvider } from '../model/provider.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { isFhirQuantityType, toFhirQuantity } from '../values/quantity.ts'
import {
  FHIR_PRIMITIVE_TO_SYSTEM,
  type QuantityValue,
  SYSTEM_QUANTITY,
  systemTypeOf,
  type TypedValue,
} from '../values/typed-value.ts'

/** The FHIR element a JSON property of a value is. */
export interface JsonElement {
  /** The JSON property name: `effectiveDateTime` for the choice element `effective`. */
  key: string
  /**
   * The element's type, as a local name: `dateTime`, `Reference`, a backbone
   * path such as `Patient.contact`, or `Resource`. An element the model types
   * as a System type, such as `Resource.id`, has its FHIR primitive, `string`.
   */
  type: string
  isCollection: boolean
  /** True for a FHIR primitive, whose `id` and extensions go in the `_key` sibling. */
  isPrimitive: boolean
}

/** The FHIR primitive a System type stands for where the model types an element with one (`Resource.id`). */
const SYSTEM_TO_FHIR: Readonly<Record<string, string>> = {
  'System.String': 'string',
  'System.Boolean': 'boolean',
  'System.Integer': 'integer',
  'System.Decimal': 'decimal',
  'System.Date': 'date',
  'System.DateTime': 'dateTime',
  'System.Time': 'time',
}

/** A type as a local FHIR name: the namespace dropped, and a System type as its FHIR primitive. */
function fhirLocalName(model: ModelProvider, type: string): string {
  const prefix = `${model.namespace}.`
  return type.startsWith(prefix) ? type.slice(prefix.length) : (SYSTEM_TO_FHIR[type] ?? type)
}

function isPrimitiveName(name: string): boolean {
  return Object.hasOwn(FHIR_PRIMITIVE_TO_SYSTEM, name)
}

/**
 * The choice element whose JSON keys start with `key`'s stem, such as
 * `value[x]` for `valueQuantity`, with that stem; undefined when no prefix of
 * `key` that ends before a capital letter is a choice element of `type`. The
 * suffix need not name one of the choice's types.
 */
export function choiceElementOfKey(
  model: ModelProvider,
  type: string,
  key: string
): { name: string; info: ElementInfo } | undefined {
  for (let position = 1; position < key.length; position++) {
    if (!/[A-Z]/.test(key[position] as string)) {
      continue
    }
    const name = key.slice(0, position)
    const info = model.getElement(type, name)
    if (info?.isChoice === true) {
      return { name, info }
    }
  }
  return undefined
}

/**
 * The element that the JSON property `key` of a value of type `type` is, or
 * undefined when the type has no such element. `key` is a JSON name without
 * the leading `_` of a primitive's sibling: `effectiveDateTime` resolves the
 * choice element `effective[x]`, and a choice stem alone is not a JSON name.
 */
export function jsonElement(model: ModelProvider, type: string, key: string): JsonElement | undefined {
  const owner = fhirLocalName(model, type)
  const direct = model.getElement(owner, key)
  if (direct !== undefined) {
    const elementType = direct.types[0]
    return direct.isChoice || elementType === undefined
      ? undefined
      : element(model, key, elementType, direct.isCollection)
  }
  const choice = choiceElementOfKey(model, owner, key)
  const suffix = choice === undefined ? undefined : key.slice(choice.name.length)
  const choiceType = choice?.info.types.find(candidate => capitalized(candidate) === suffix)
  return choice === undefined || choiceType === undefined
    ? undefined
    : element(model, key, choiceType, choice.info.isCollection)
}

function element(model: ModelProvider, key: string, type: string, isCollection: boolean): JsonElement {
  const local = fhirLocalName(model, type)
  return { key, type: local, isCollection, isPrimitive: isPrimitiveName(local) }
}

function capitalized(type: string): string {
  return `${type[0]?.toUpperCase() ?? ''}${type.slice(1)}`
}

const VALUE_PATTERNS = new Map<string, RegExp>()

/**
 * True when `text` matches the value pattern of the FHIR primitive `primitive`
 * whole (ModelProvider.valuePattern), and when the model gives none.
 */
export function matchesValuePattern(model: ModelProvider, primitive: string, text: string): boolean {
  const pattern = model.valuePattern?.(primitive)
  if (pattern === undefined) {
    return true
  }
  let regex = VALUE_PATTERNS.get(pattern)
  if (regex === undefined) {
    regex = new RegExp(`^(?:${pattern})$`)
    VALUE_PATTERNS.set(pattern, regex)
  }
  return regex.test(text)
}

const STRING_TYPES = new Set([
  'string',
  'markdown',
  'xhtml',
  'code',
  'id',
  'uri',
  'url',
  'canonical',
  'oid',
  'uuid',
  'base64Binary',
])
const TEMPORAL_TYPES = new Set(['date', 'dateTime', 'instant', 'time'])
const INTEGER_TYPES = new Set(['integer', 'unsignedInt', 'positiveInt'])

/**
 * A typed value as the FHIR JSON of an element of type `target`, such as
 * `dateTime`, `Reference`, or `Patient.contact`. A string fills a string-like
 * or temporal element when it has that type's format; a date, date-time, or
 * time fills a temporal element, `string`, or `markdown` in the same case; a
 * number fills `decimal`, or an integer type within its range; a FHIR value
 * fills its own type, a supertype, `Element`, and a resource also `Resource`
 * and `DomainResource`; a FHIRPath Quantity fills `Quantity` and its profiles
 * with a UCUM code. A complex value is copied, so the result shares nothing
 * with the data. A primitive's `id` and extensions are not carried. Throws a
 * FhirPathTypeError that names the types, never the value.
 */
export function toFhirJson(model: ModelProvider, value: TypedValue, target: string): unknown {
  const targetType = fhirLocalName(model, target)
  return isPrimitiveName(targetType) ? primitiveJson(model, value, targetType) : complexJson(model, value, targetType)
}

function primitiveJson(model: ModelProvider, value: TypedValue, target: string): unknown {
  const source = systemTypeOf(value)
  const raw = value.value
  switch (source) {
    case 'System.String':
      if (STRING_TYPES.has(target) || TEMPORAL_TYPES.has(target)) {
        return formatted(model, String(raw), target)
      }
      break
    case 'System.Boolean':
      if (target === 'boolean') {
        return raw
      }
      break
    case 'System.Integer':
    case 'System.Long':
    case 'System.Decimal':
      return numberJson(raw, source, target)
    case 'System.Date':
    case 'System.DateTime':
    case 'System.Time':
      if (TEMPORAL_TYPES.has(target) || target === 'string' || target === 'markdown') {
        return formatted(model, raw instanceof Temporal ? raw.toString() : String(raw), target)
      }
      break
  }
  throw refused(value, target)
}

function numberJson(raw: unknown, source: string, target: string): number {
  const number = raw instanceof Decimal ? raw.toNumber() : typeof raw === 'bigint' ? Number(raw) : raw
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new FhirPathTypeError(`A ${source} value that is not a finite number cannot be written as ${target}`)
  }
  if (target === 'decimal') {
    return number
  }
  if (!INTEGER_TYPES.has(target)) {
    throw new FhirPathTypeError(`A ${source} value cannot be written as ${target}`)
  }
  if (!Number.isSafeInteger(number) || number > 2147483647 || number < -2147483648) {
    throw new FhirPathTypeError(`A ${source} value that is not a 32-bit integer cannot be written as ${target}`)
  }
  if ((target === 'unsignedInt' && number < 0) || (target === 'positiveInt' && number < 1)) {
    throw new FhirPathTypeError(`A ${source} value out of the range of ${target} cannot be written`)
  }
  return number
}

function formatted(model: ModelProvider, text: string, target: string): string {
  if (!matchesValuePattern(model, target, text) || (TEMPORAL_TYPES.has(target) && !isCalendarDay(text))) {
    throw new FhirPathTypeError(`The value does not have the format of a FHIR ${target}`)
  }
  return text
}

/** False for a day the calendar does not have, such as 2023-02-29; the format patterns accept those. */
function isCalendarDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match === null) {
    return true
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
  return day <= days
}

function complexJson(model: ModelProvider, value: TypedValue, target: string): unknown {
  if (value.type === SYSTEM_QUANTITY && isFhirQuantityType(target)) {
    return toFhirQuantity(value.value as QuantityValue)
  }
  const prefix = `${model.namespace}.`
  if (!value.type.startsWith(prefix) || isPrimitiveName(value.type.slice(prefix.length))) {
    throw refused(value, target)
  }
  const fits =
    value.type.slice(prefix.length) === target ||
    target === 'Element' ||
    ((target === 'Resource' || target === 'DomainResource') && isResourceJson(value.value)) ||
    model.isSubtypeOf(value.type, model.resolveType(target) ?? `${prefix}${target}`)
  if (!fits) {
    throw refused(value, target)
  }
  return copyJson(value.value)
}

/** A deep copy of JSON. Not `structuredClone`: some hosts, such as Medplum's bot runtime, do not have it. */
function copyJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyJson)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)]))
  }
  return value
}

function refused(value: TypedValue, target: string): FhirPathTypeError {
  return new FhirPathTypeError(`A ${value.type} value cannot be written to an element of type ${target}`)
}

function isResourceJson(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { resourceType?: unknown }).resourceType === 'string'
  )
}
