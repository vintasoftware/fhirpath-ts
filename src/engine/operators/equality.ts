import { Temporal } from '../../values/datetime.ts'
import { asNumeric } from '../../values/numeric.ts'
import {
  coerceQuantityPair,
  compareQuantities,
  promoteQuantity,
  quantitiesEquivalent,
  quantityEqualityKey,
} from '../../values/quantity.ts'
import { compareTemporal, temporalEqualityKey } from '../../values/temporal-compare.ts'
import {
  SYSTEM_BOOLEAN,
  SYSTEM_STRING,
  systemTypeOf,
  type TypedValue,
  typeLocalName,
} from '../../values/typed-value.ts'
import type { BinaryOperatorTable } from './index.ts'

/**
 * Single-item `=` semantics (spec "= (Equals)"). Undefined means empty: date/time values
 * whose precisions differ, or quantities whose units cannot be compared yet.
 */
export function pairEquals(a: TypedValue, b: TypedValue): boolean | undefined {
  if (a.value === undefined || b.value === undefined) {
    // Valueless primitives (extension-only _field elements) never equal anything.
    return false
  }
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
  const quantityPair = coerceQuantityPair(a, b)
  if (quantityPair) {
    const comparison = compareQuantities(quantityPair[0], quantityPair[1])
    return comparison === undefined ? undefined : comparison === 0
  }
  if (systemTypeOf(a) === SYSTEM_STRING && systemTypeOf(b) === SYSTEM_STRING) {
    return a.value === b.value
  }
  if (systemTypeOf(a) === SYSTEM_BOOLEAN && systemTypeOf(b) === SYSTEM_BOOLEAN) {
    return a.value === b.value
  }
  if (isComplex(a) && isComplex(b)) {
    return deepEquals(a.value, b.value)
  }
  return false
}

/**
 * Items indexed for `=` (`pairEquals`) lookups, in insertion order. `=` is not
 * transitive (an untyped object deep-equals a FHIR Quantity that equals another
 * by unit conversion), so a lookup index keeps every item; only deduplication
 * drops one, through `add`. Most items answer through `equalityKey` in constant
 * time; an object without a key is compared one by one, against objects only.
 */
export class EqualityIndex {
  readonly items: TypedValue[] = []
  private readonly keys = new Set<string>()
  /** Every item with an object value, keyed or not. */
  private readonly objects: TypedValue[] = []
  /** Items with an object value and no key. */
  private readonly unkeyedObjects: TypedValue[] = []

  constructor(items: Iterable<TypedValue> = []) {
    for (const item of items) {
      this.insert(item)
    }
  }

  /** True when an item `=` to this one is present. */
  has(item: TypedValue): boolean {
    return this.find(item, equalityKey(item))
  }

  /** Inserts the item unless an item `=` to it is present; true when inserted. */
  add(item: TypedValue): boolean {
    const key = equalityKey(item)
    if (this.find(item, key)) {
      return false
    }
    this.store(item, key)
    return true
  }

  /** Inserts the item without looking for an equal one. */
  insert(item: TypedValue): void {
    this.store(item, equalityKey(item))
  }

  private find(item: TypedValue, key: string | undefined): boolean {
    // pairEquals compares an object with a primitive as unequal, so only objects need a scan.
    if (key === undefined) {
      return isComplex(item) && this.objects.some(existing => pairEquals(existing, item) === true)
    }
    return (
      this.keys.has(key) ||
      (isComplex(item) && this.unkeyedObjects.some(existing => pairEquals(existing, item) === true))
    )
  }

  private store(item: TypedValue, key: string | undefined): void {
    if (key !== undefined) {
      this.keys.add(key)
    }
    if (isComplex(item)) {
      this.objects.push(item)
      if (key === undefined) {
        this.unkeyedObjects.push(item)
      }
    }
    this.items.push(item)
  }
}

/** Duplicate elimination with `=` semantics: `distinct()`, `|`, `union()`, and `intersect()`. */
export function distinctItems(input: Iterable<TypedValue>): TypedValue[] {
  const distinct = new EqualityIndex()
  for (const item of input) {
    distinct.add(item)
  }
  return distinct.items
}

/**
 * A key that decides `pairEquals` on its own: two keyed items are equal exactly
 * when their keys are the same. A number takes the key of a Quantity with unit
 * '1', which it equals. Undefined for complex values, compared by deep equality,
 * and for valueless items, which equal nothing.
 */
function equalityKey(item: TypedValue): string | undefined {
  if (item.value === undefined) {
    return undefined
  }
  if (item.value instanceof Temporal) {
    return `t${temporalEqualityKey(item.value)}`
  }
  const quantity = promoteQuantity(item)
  if (quantity) {
    return `q${quantityEqualityKey(quantity)}`
  }
  const type = systemTypeOf(item)
  if (type === SYSTEM_STRING || type === SYSTEM_BOOLEAN) {
    return `${type}|${String(item.value)}`
  }
  return undefined
}

/** Single-item `~` semantics (spec "~ (Equivalent)"). Never empty. */
export function pairEquivalent(a: TypedValue, b: TypedValue): boolean {
  if (a.value === undefined || b.value === undefined) {
    // Two valueless primitives are equivalent; a valueless one never matches a value.
    return a.value === undefined && b.value === undefined
  }
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
  const quantityPair = coerceQuantityPair(a, b)
  if (quantityPair) {
    return quantitiesEquivalent(quantityPair[0], quantityPair[1])
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
  if (systemTypeOf(a) === SYSTEM_STRING && systemTypeOf(b) === SYSTEM_STRING) {
    return normalizeString(a.value as string) === normalizeString(b.value as string)
  }
  if (systemTypeOf(a) === SYSTEM_BOOLEAN && systemTypeOf(b) === SYSTEM_BOOLEAN) {
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
  // "Normalizing whitespace" (spec "~ (Equivalent)") makes tab/newline/space interchangeable;
  // it does not trim or collapse runs — 'a  b' and 'a b' stay different.
  return value.replace(/\s/g, ' ').toLowerCase()
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
    // Equality compares every child element, `id` included (spec "= (Equals)"),
    // but not the `_field` siblings that carry primitive extensions in JSON.
    const keysA = Object.keys(a).filter(isElementKey)
    const keysB = Object.keys(b).filter(isElementKey)
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
    // Equivalence also ignores element ids.
    const keysA = Object.keys(a).filter(isValueKey)
    const keysB = Object.keys(b).filter(isValueKey)
    return (
      keysA.length === keysB.length &&
      keysA.every(key => deepEquivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    )
  }
  return a === b
}

/** Excludes a complex value's `_field` (primitive extension) siblings from comparison. */
function isElementKey(key: string): boolean {
  return !key.startsWith('_')
}

/** Excludes a complex value's `id` and `_field` siblings from comparison. */
function isValueKey(key: string): boolean {
  return key !== 'id' && isElementKey(key)
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

export const equalityOperators = {
  '=': (_context, left, right) => wrap(collectionEquals(left, right)),
  '!=': (_context, left, right) => {
    const result = collectionEquals(left, right)
    return wrap(result === undefined ? undefined : !result)
  },
  '~': (_context, left, right) => wrap(collectionEquivalent(left, right)),
  '!~': (_context, left, right) => wrap(!collectionEquivalent(left, right)),
} satisfies BinaryOperatorTable
