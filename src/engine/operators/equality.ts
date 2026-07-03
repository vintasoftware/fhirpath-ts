import { Temporal } from '../../values/datetime'
import { asNumeric } from '../../values/numeric'
import { coerceQuantity, compareQuantities, quantitiesEquivalent } from '../../values/quantity'
import { compareTemporal } from '../../values/temporal-compare'
import { SYSTEM_BOOLEAN, SYSTEM_STRING, type TypedValue, typeLocalName } from '../../values/typed-value'
import { binaryOperators } from './index'

/**
 * Single-item `=` semantics (spec §6.1.1). Undefined means empty: date/time values
 * whose precisions differ, or quantities whose units cannot be compared yet.
 */
export function pairEquals(a: TypedValue, b: TypedValue): boolean | undefined {
  const numericA = asNumeric(a)
  const numericB = asNumeric(b)
  if (numericA && numericB) {
    return numericA.value.equals(numericB.value)
  }
  if (a.value instanceof Temporal && b.value instanceof Temporal) {
    const comparison = compareTemporal(a.value, b.value)
    if (comparison === 'differentPrecision') {
      return undefined
    }
    return comparison === 0
  }
  const quantityA = coerceQuantity(a)
  const quantityB = coerceQuantity(b)
  if (quantityA && quantityB) {
    const comparison = compareQuantities(quantityA, quantityB)
    return comparison === undefined ? undefined : comparison === 0
  }
  if (a.type === SYSTEM_STRING && b.type === SYSTEM_STRING) {
    return a.value === b.value
  }
  if (a.type === SYSTEM_BOOLEAN && b.type === SYSTEM_BOOLEAN) {
    return a.value === b.value
  }
  if (isComplex(a) && isComplex(b)) {
    return deepEquals(a.value, b.value)
  }
  return false
}

/** Single-item `~` semantics (spec §6.1.3). Never empty. */
export function pairEquivalent(a: TypedValue, b: TypedValue): boolean {
  const numericA = asNumeric(a)
  const numericB = asNumeric(b)
  if (numericA && numericB) {
    // Rounded to the least precise operand.
    const scale = Math.min(numericA.value.scale, numericB.value.scale)
    return numericA.value.round(scale).equals(numericB.value.round(scale))
  }
  if (a.value instanceof Temporal && b.value instanceof Temporal) {
    return compareTemporal(a.value, b.value) === 0
  }
  const quantityA = coerceQuantity(a)
  const quantityB = coerceQuantity(b)
  if (quantityA && quantityB) {
    return quantitiesEquivalent(quantityA, quantityB)
  }
  // One typed side is enough: untyped comparison values (e.g. from %env) still get
  // FHIR semantics when compared against a model-typed Coding/CodeableConcept.
  if ((typeLocalName(a.type) === 'Coding' || typeLocalName(b.type) === 'Coding') && isComplex(a) && isComplex(b)) {
    return codingEquivalent(a.value, b.value)
  }
  if (
    (typeLocalName(a.type) === 'CodeableConcept' || typeLocalName(b.type) === 'CodeableConcept') &&
    isComplex(a) &&
    isComplex(b)
  ) {
    return codeableConceptEquivalent(a.value, b.value)
  }
  if (a.type === SYSTEM_STRING && b.type === SYSTEM_STRING) {
    return normalizeString(a.value as string) === normalizeString(b.value as string)
  }
  if (a.type === SYSTEM_BOOLEAN && b.type === SYSTEM_BOOLEAN) {
    return a.value === b.value
  }
  if (isComplex(a) && isComplex(b)) {
    return deepEquivalent(a.value, b.value)
  }
  return false
}

/** FHIR equivalence for Coding: system and code only (display and id do not matter). */
function codingEquivalent(a: unknown, b: unknown): boolean {
  const codingA = a as { system?: unknown; code?: unknown }
  const codingB = b as { system?: unknown; code?: unknown }
  return codingA.system === codingB.system && codingA.code === codingB.code
}

/** FHIR equivalence for CodeableConcept: any pair of equivalent codings. */
function codeableConceptEquivalent(a: unknown, b: unknown): boolean {
  const codingsA = ((a as { coding?: unknown[] }).coding ?? []) as unknown[]
  const codingsB = ((b as { coding?: unknown[] }).coding ?? []) as unknown[]
  return codingsA.some(one => codingsB.some(other => codingEquivalent(one, other)))
}

function isComplex(item: TypedValue): boolean {
  return typeof item.value === 'object' && item.value !== null && !(item.value instanceof Temporal)
}

function normalizeString(value: string): string {
  return value
    .trim()
    .replace(/[\s\r\n\t]+/g, ' ')
    .toLowerCase()
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEquals(item, b[index]))
    )
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return (
      keysA.length === keysB.length &&
      keysA.every(key => deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    )
  }
  return a === b
}

function deepEquivalent(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return normalizeString(a) === normalizeString(b)
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEquivalent(item, b[index]))
    )
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    // Equivalence on FHIR complex values ignores element ids and primitive metadata.
    const keysA = Object.keys(a).filter(equivalenceKey)
    const keysB = Object.keys(b).filter(equivalenceKey)
    return (
      keysA.length === keysB.length &&
      keysA.every(key => deepEquivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    )
  }
  return a === b
}

function equivalenceKey(key: string): boolean {
  return key !== 'id' && !key.startsWith('_')
}

/** Collection `=`: empty operand → empty; different lengths → false; ordered pairwise. */
export function collectionEquals(left: TypedValue[], right: TypedValue[]): boolean | undefined {
  if (left.length === 0 || right.length === 0) {
    return undefined
  }
  if (left.length !== right.length) {
    return false
  }
  let result = true
  for (let i = 0; i < left.length; i++) {
    const pair = pairEquals(left[i] as TypedValue, right[i] as TypedValue)
    if (pair === undefined) {
      return undefined
    }
    result = result && pair
  }
  return result
}

/** Collection `~`: both empty → true; order-independent multiset matching. */
export function collectionEquivalent(left: TypedValue[], right: TypedValue[]): boolean {
  if (left.length === 0 && right.length === 0) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  const used = new Array<boolean>(right.length).fill(false)
  for (const item of left) {
    let matched = false
    for (let i = 0; i < right.length; i++) {
      if (!used[i] && pairEquivalent(item, right[i] as TypedValue)) {
        used[i] = true
        matched = true
        break
      }
    }
    if (!matched) {
      return false
    }
  }
  return true
}

function wrap(value: boolean | undefined): TypedValue[] {
  return value === undefined ? [] : [{ type: SYSTEM_BOOLEAN, value }]
}

binaryOperators.set('=', (_context, left, right) => wrap(collectionEquals(left, right)))
binaryOperators.set('!=', (_context, left, right) => {
  const result = collectionEquals(left, right)
  return wrap(result === undefined ? undefined : !result)
})
binaryOperators.set('~', (_context, left, right) => wrap(collectionEquivalent(left, right)))
binaryOperators.set('!~', (_context, left, right) => wrap(!collectionEquivalent(left, right)))
