import { describe, expect, it } from 'vitest'

import { FhirPathRuntimeError } from '../errors.ts'
import { booleanSingleton, criteriaBoolean, singleton, wrapBoolean } from './collection.ts'
import { Decimal } from './decimal.ts'
import {
  SYSTEM_BOOLEAN,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_LONG,
  SYSTEM_STRING,
  toCollection,
  toTypedValue,
  typeLocalName,
  unwrap,
} from './typed-value.ts'

describe('toTypedValue', () => {
  it('infers System types from JS values', () => {
    expect(toTypedValue(true)).toEqual({ type: SYSTEM_BOOLEAN, value: true })
    expect(toTypedValue('x')).toEqual({ type: SYSTEM_STRING, value: 'x' })
    expect(toTypedValue(5)).toEqual({ type: SYSTEM_INTEGER, value: 5 })
    expect(toTypedValue(5n)).toEqual({ type: SYSTEM_LONG, value: 5n })
  })

  it('wraps non-integer numbers as Decimal', () => {
    const typed = toTypedValue(2.5)
    expect(typed.type).toBe(SYSTEM_DECIMAL)
    expect((typed.value as Decimal).toString()).toBe('2.5')
  })

  it('passes Decimal instances through', () => {
    const value = Decimal.fromString('1.50') as Decimal
    expect(toTypedValue(value)).toEqual({ type: SYSTEM_DECIMAL, value })
  })

  it('types resources from resourceType', () => {
    expect(toTypedValue({ resourceType: 'Patient' }).type).toBe('FHIR.Patient')
    expect(toTypedValue({ family: 'X' }).type).toBe('Object')
  })
})

describe('toCollection', () => {
  it('handles undefined, single values, and arrays', () => {
    expect(toCollection(undefined)).toEqual([])
    expect(toCollection(null)).toEqual([])
    expect(toCollection('a')).toHaveLength(1)
    expect(toCollection(['a', 'b'])).toHaveLength(2)
    expect(toCollection([['a'], 'b'])).toHaveLength(2)
  })
})

describe('unwrap', () => {
  it('unwraps Decimal to number', () => {
    expect(unwrap(toTypedValue(2.5))).toBe(2.5)
  })

  it('passes plain values through', () => {
    expect(unwrap({ type: SYSTEM_STRING, value: 'x' })).toBe('x')
    const resource = { resourceType: 'Patient' }
    expect(unwrap(toTypedValue(resource))).toBe(resource)
  })
})

describe('typeLocalName', () => {
  it('takes the part after the last dot', () => {
    expect(typeLocalName('System.Boolean')).toBe('Boolean')
    expect(typeLocalName('Patient')).toBe('Patient')
  })
})

describe('singleton evaluation (§4.5)', () => {
  it('empty propagates', () => {
    expect(singleton([])).toBeUndefined()
    expect(booleanSingleton([])).toBeUndefined()
  })

  it('a single item passes through', () => {
    const item = toTypedValue(5)
    expect(singleton([item])).toBe(item)
    expect(singleton([item], SYSTEM_INTEGER)).toBe(item)
  })

  it('a single non-boolean item is true when a Boolean is expected', () => {
    expect(booleanSingleton([toTypedValue('hello')])).toBe(true)
    expect(booleanSingleton([toTypedValue(false)])).toBe(false)
  })

  it('errors on more than one item', () => {
    const items = [toTypedValue(1), toTypedValue(2)]
    expect(() => singleton(items)).toThrow(FhirPathRuntimeError)
    expect(() => singleton(items)).toThrow('at most one item')
  })

  it('errors when the type cannot satisfy the expectation', () => {
    expect(() => singleton([toTypedValue('x')], SYSTEM_INTEGER)).toThrow(FhirPathRuntimeError)
  })

  it('wrapBoolean converts undefined to empty', () => {
    expect(wrapBoolean(undefined)).toEqual([])
    expect(wrapBoolean(true)).toEqual([{ type: SYSTEM_BOOLEAN, value: true }])
  })

  it('booleanSingleton keeps empty distinct from false', () => {
    // The three-valued and/or/xor/implies tables read this undefined directly
    // (engine/operators/logic.ts). Folding it into false here would silently
    // break `{} and false`, which is false, against `{} and true`, which is
    // empty — so the criteria rule is a separate function.
    expect(booleanSingleton([])).toBeUndefined()
    expect(criteriaBoolean([])).toBe(false)
  })

  it('criteriaBoolean is total: every collection answers true or false', () => {
    expect(criteriaBoolean([toTypedValue(true)])).toBe(true)
    expect(criteriaBoolean([toTypedValue(false)])).toBe(false)
    expect(criteriaBoolean([toTypedValue('hello')])).toBe(true)
    expect(() => criteriaBoolean([toTypedValue(1), toTypedValue(2)])).toThrow('at most one item')
  })
})
