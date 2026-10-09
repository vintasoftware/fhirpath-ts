import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { convertSingle } from '../fhir/model-navigation.ts'
import type { ElementInfo, ModelProvider } from '../model/provider.ts'
import type { AstNode, InstanceSelectorNode } from '../parser/ast.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { integerLiteral } from '../values/numeric.ts'
import { isFhirQuantityType, toFhirQuantity } from '../values/quantity.ts'
import {
  FHIR_PRIMITIVE_TO_SYSTEM,
  OBJECT_TYPE,
  type QuantityValue,
  SYSTEM_BOOLEAN,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_LONG,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  SYSTEM_TIME,
  systemTypeOf,
  systemTypeOfName,
  type TypedValue,
  typeLocalName,
} from '../values/typed-value.ts'
import { type EvaluationContext, forkVariables } from './context.ts'

/** The type an instance selector builds, or why the name names none. */
export type InstanceType = { type: string; primitive: boolean; resource: boolean } | { error: string }

/**
 * Resolve an instance selector's type name. With a model, the name must be one
 * of its types, optionally prefixed with the model's namespace. Without a
 * model, any name works and an unqualified name gets the FHIR namespace, as
 * resource values do. System types have literals instead.
 */
export function resolveInstanceType(model: ModelProvider | undefined, parts: readonly string[]): InstanceType {
  const text = parts.join('.')
  if (parts[0] === 'System') {
    return { error: `An instance selector builds a model type, but '${text}' is a System type` }
  }
  if (model === undefined) {
    const type = parts.length === 1 ? `FHIR.${text}` : text
    return { type, primitive: isFhirPrimitive(type), resource: false }
  }
  const local =
    parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === model.namespace ? parts[1] : undefined
  const type = local === undefined ? undefined : model.resolveType(local)
  if (type === undefined) {
    return { error: `Unknown type '${text}'` }
  }
  const resourceBase = model.resolveType('Resource')
  return {
    type,
    primitive: isFhirPrimitive(type),
    resource: resourceBase !== undefined && model.isSubtypeOf(type, resourceBase),
  }
}

function isFhirPrimitive(type: string): boolean {
  return type.startsWith('FHIR.') && FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(type)] !== undefined
}

/**
 * The definition of a selector element. A primitive's `value` takes the System
 * type the runtime reads that primitive as: the R4 model declares
 * `unsignedInt.value` and `positiveInt.value` as System.String, though their
 * values are integers.
 */
export function selectorElement(model: ModelProvider, type: string, name: string): ElementInfo | undefined {
  const info = model.getElement(type, name)
  const system =
    info !== undefined && name === 'value' && isFhirPrimitive(type)
      ? FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(type)]
      : undefined
  return system === undefined || info === undefined ? info : { ...info, types: [system] }
}

/** The FHIR primitive named after each System type: a System.String fills a `string` choice. */
const PRIMITIVE_FOR_SYSTEM: Readonly<Record<string, string>> = {
  'System.Boolean': 'boolean',
  'System.String': 'string',
  'System.Integer': 'integer',
  'System.Long': 'integer64',
  'System.Decimal': 'decimal',
  'System.Date': 'date',
  'System.DateTime': 'dateTime',
  'System.Time': 'time',
}

/** Implicit conversions (spec "Conversion") a value may take to fit an element. */
const IMPLICIT_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'System.Integer': ['System.Decimal', 'System.Long'],
  'System.Date': ['System.DateTime'],
}

/**
 * The declared element type that takes a value of `valueType`, or undefined
 * when none does. For a choice element it picks the type, and so the JSON key.
 * In order: the value's own type, a model supertype (`SimpleQuantity` into
 * `Quantity`), a FHIR quantity type for a System.Quantity, a primitive with the
 * same System type (preferring the one named after it, `string` for
 * System.String), then a primitive the value converts to implicitly. An
 * untyped object fills an element with one complex type. The runtime and the
 * analyzer both decide with this function.
 */
export function acceptingElementType(
  model: ModelProvider,
  elementTypes: readonly string[],
  valueType: string
): string | undefined {
  const canonical = (type: string): string => (type.startsWith('System.') ? type : (model.resolveType(type) ?? type))
  const exact = elementTypes.find(type => canonical(type) === valueType)
  if (exact !== undefined) {
    return exact
  }
  const complex = elementTypes.filter(type => systemTypeOfName(type) === undefined)
  if (valueType === OBJECT_TYPE) {
    return elementTypes.length === 1 ? complex[0] : undefined
  }
  const supertype = complex.find(type => model.isSubtypeOf(valueType, canonical(type)))
  if (supertype !== undefined) {
    return supertype
  }
  if (valueType === SYSTEM_QUANTITY) {
    return complex.find(type => type === 'Quantity') ?? complex.find(isFhirQuantityType)
  }
  const system = systemTypeOfName(valueType)
  if (system === undefined) {
    return undefined
  }
  const named = PRIMITIVE_FOR_SYSTEM[system]
  return (
    elementTypes.find(type => type === named) ??
    elementTypes.find(type => systemTypeOfName(type) === system) ??
    elementTypes.find(type => IMPLICIT_TARGETS[system]?.includes(systemTypeOfName(type) ?? '') === true)
  )
}

const VALUE_PATTERNS = new Map<string, RegExp>()

/**
 * The FHIR primitive whose value pattern a written value must match: the element
 * type that took it, or the selector's own type for a primitive's `value`.
 */
export function patternedType(selectorType: string, element: string, elementType: string): string | undefined {
  if (isFhirPrimitive(`FHIR.${typeLocalName(elementType)}`) && !elementType.startsWith('System.')) {
    return elementType
  }
  return element === 'value' && isFhirPrimitive(selectorType) ? selectorType : undefined
}

/**
 * Why a JSON `value` written as the FHIR primitive `primitive` breaks that type's
 * value pattern (ModelProvider.valuePattern), or undefined. The message names the
 * element, type, and pattern, never the value, which may be patient data.
 */
export function valuePatternMessage(
  model: ModelProvider,
  primitive: string,
  value: unknown,
  element: string,
  owner: string
): string | undefined {
  const pattern = model.valuePattern?.(primitive)
  if (pattern === undefined || value === undefined || value === null) {
    return undefined
  }
  let regex = VALUE_PATTERNS.get(pattern)
  if (regex === undefined) {
    regex = new RegExp(`^(?:${pattern})$`)
    VALUE_PATTERNS.set(pattern, regex)
  }
  return regex.test(String(value))
    ? undefined
    : `Element '${element}' of ${owner} does not match the ${typeLocalName(primitive)} pattern ${pattern}`
}

/**
 * The System type and FHIR JSON of a literal element value, as the runtime writes
 * it, so the analyzer can check its pattern: strings, booleans, numbers with an
 * optional sign, dates, and times. Undefined for any other expression.
 */
export function literalValue(node: AstNode): { type: string; json: unknown } | undefined {
  switch (node.kind) {
    case 'string':
      return { type: SYSTEM_STRING, json: node.value }
    case 'boolean':
      return { type: SYSTEM_BOOLEAN, json: node.value }
    case 'number':
      return numberLiteral(node.text, node.isDecimal, node.isLong === true, '')
    case 'unary':
      return node.operand.kind === 'number'
        ? numberLiteral(node.operand.text, node.operand.isDecimal, node.operand.isLong === true, node.operator)
        : undefined
    case 'date':
      return temporalLiteral(SYSTEM_DATE, Temporal.parseDate(node.text))
    case 'dateTime':
      return temporalLiteral(SYSTEM_DATETIME, Temporal.parseDateTime(node.text))
    case 'time':
      return temporalLiteral(SYSTEM_TIME, Temporal.parseTime(node.text))
    default:
      return undefined
  }
}

function numberLiteral(
  text: string,
  isDecimal: boolean,
  isLong: boolean,
  sign: string
): { type: string; json: unknown } {
  const type = isLong ? SYSTEM_LONG : isDecimal ? SYSTEM_DECIMAL : integerLiteral(text).type
  const signed = `${sign === '-' ? '-' : ''}${text}`
  return { type, json: type === SYSTEM_LONG ? BigInt(signed) : Number(signed) }
}

function temporalLiteral(type: string, value: Temporal | undefined): { type: string; json: unknown } | undefined {
  return value === undefined ? undefined : { type, json: value.toString() }
}

/** One element value as FHIR JSON: the value and, for a FHIR primitive, its `_field` sibling. */
interface JsonEntry {
  value: unknown
  sibling: unknown
}

function jsonEntry(item: TypedValue, elementType: string | undefined): JsonEntry {
  if (item.type === SYSTEM_QUANTITY) {
    return { value: toFhirQuantity(item.value as QuantityValue), sibling: undefined }
  }
  if (systemTypeOf(item) === undefined) {
    return { value: item.value, sibling: undefined }
  }
  const value = item.value
  const json = value instanceof Decimal ? value.toNumber() : value instanceof Temporal ? value.toString() : value
  // System-typed elements, such as `id` and a primitive's `value`, have no sibling.
  const sibling = elementType?.startsWith('System.') === true ? undefined : item.primitiveElement
  return { value: json, sibling }
}

/** Write one element: a repeating element is always an array; `_field` holds the siblings, if any. */
function writeElement(target: Record<string, unknown>, key: string, entries: JsonEntry[], collection: boolean): void {
  const hasSiblings = entries.some(entry => entry.sibling !== undefined)
  if (collection) {
    target[key] = entries.map(entry => entry.value ?? null)
    if (hasSiblings) {
      target[`_${key}`] = entries.map(entry => entry.sibling ?? null)
    }
    return
  }
  const entry = entries[0] as JsonEntry
  if (entry.value !== undefined) {
    target[key] = entry.value
  }
  if (entry.sibling !== undefined) {
    target[`_${key}`] = entry.sibling
  }
}

/**
 * Evaluate an instance selector (spec "Instance Selector/Object Creation"). The
 * selector reads the current focus: empty gives empty, more than one item is an
 * error. Each element value evaluates against that focus in its own variable
 * scope, and an empty value leaves the element out. With a model, element names
 * and value types are checked, a repeating element becomes an array, and a
 * choice element takes the key of the value's type (`valueQuantity`). Without
 * a model, a value with several items becomes an array and keys are used as
 * written.
 */
export function evaluateInstanceSelector(
  node: InstanceSelectorNode,
  context: EvaluationContext,
  input: TypedValue[],
  evaluateNode: (node: AstNode, context: EvaluationContext, input: TypedValue[]) => TypedValue[]
): TypedValue[] {
  const model = context.model
  const resolved = resolveInstanceType(model, node.type.parts)
  if ('error' in resolved) {
    throw new FhirPathTypeError(resolved.error)
  }
  const typeName = typeLocalName(resolved.type)
  const elements = node.elements.map(element => {
    const info = model === undefined ? undefined : selectorElement(model, resolved.type, element.name)
    if (model !== undefined && info === undefined) {
      throw new FhirPathTypeError(`Element '${element.name}' is not defined on ${typeName}`)
    }
    return { element, info }
  })
  if (input.length > 1) {
    throw new FhirPathRuntimeError(`An instance selector expects at most one input item, but found ${input.length}`)
  }
  if (input.length === 0) {
    return []
  }
  const json: Record<string, unknown> = resolved.resource ? { resourceType: typeName } : {}
  for (const { element, info } of elements) {
    const values = evaluateNode(element.value, forkVariables(context), input)
    if (values.length === 0) {
      continue
    }
    writeElementValues(json, element.name, info, values, model, resolved.type)
  }
  if (!resolved.primitive) {
    return [{ type: resolved.type, value: json }]
  }
  const { value, ...metadata } = json
  const primitive = convertSingle(value, Object.keys(metadata).length > 0 ? metadata : undefined, typeName)
  return primitive === undefined ? [] : [primitive]
}

function writeElementValues(
  json: Record<string, unknown>,
  name: string,
  info: ElementInfo | undefined,
  values: TypedValue[],
  model: ModelProvider | undefined,
  selectorType: string
): void {
  const typeName = typeLocalName(selectorType)
  if (info === undefined || model === undefined) {
    writeElement(
      json,
      name,
      values.map(item => jsonEntry(item, undefined)),
      values.length > 1
    )
    return
  }
  if (!info.isCollection && values.length > 1) {
    throw new FhirPathRuntimeError(
      `Element '${name}' of ${typeName} takes one item, but its value has ${values.length} items`
    )
  }
  const entries: JsonEntry[] = []
  let chosen: string | undefined
  for (const item of values) {
    const elementType = acceptingElementType(model, info.types, item.type)
    if (elementType === undefined) {
      throw new FhirPathTypeError(
        `Element '${name}' of ${typeName} expects ${info.types.join(' | ')}, found ${item.type}`
      )
    }
    chosen = elementType
    const entry = jsonEntry(item, elementType)
    const primitive = patternedType(selectorType, name, elementType)
    const message =
      primitive === undefined ? undefined : valuePatternMessage(model, primitive, entry.value, name, typeName)
    if (message !== undefined) {
      throw new FhirPathRuntimeError(message)
    }
    entries.push(entry)
  }
  const key = info.isChoice && chosen !== undefined ? `${name}${chosen[0]?.toUpperCase()}${chosen.slice(1)}` : name
  writeElement(json, key, entries, info.isCollection)
}
