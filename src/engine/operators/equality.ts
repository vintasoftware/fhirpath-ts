import { Temporal } from '../../values/datetime'
import { asNumeric } from '../../values/numeric'
import { compareQuantities, quantitiesEquivalent } from '../../values/quantity'
import { compareTemporal } from '../../values/temporal-compare'
import {
  type QuantityValue,
  SYSTEM_BOOLEAN,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  type TypedValue,
} from '../../values/typed-value'
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
  if (a.type === SYSTEM_QUANTITY && b.type === SYSTEM_QUANTITY) {
    const comparison = compareQuantities(a.value as QuantityValue, b.value as QuantityValue)
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
  if (a.type === SYSTEM_QUANTITY && b.type === SYSTEM_QUANTITY) {
    return quantitiesEquivalent(a.value as QuantityValue, b.value as QuantityValue)
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
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return (
      keysA.length === keysB.length &&
      keysA.every(key => deepEquivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    )
  }
  return a === b
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
