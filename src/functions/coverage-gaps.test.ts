import { describe, expect, it } from 'vitest'
import { evaluate } from '../api/evaluate.ts'
import type { ModelProvider } from '../model/provider.ts'

// Focused cases for branches the broader suites do not reach.
describe('remaining branch coverage', () => {
  it('empty arguments propagate through encode/decode/escape/unescape', () => {
    expect(evaluate("'a'.encode({})")).toEqual([])
    expect(evaluate("'a'.decode({})")).toEqual([])
    expect(evaluate("'a'.escape({})")).toEqual([])
    expect(evaluate("'a'.unescape({})")).toEqual([])
    expect(evaluate("'a'.replace({}, 'x')")).toEqual([])
    expect(evaluate("'a'.replaceMatches({}, 'x')")).toEqual([])
    expect(evaluate("'a'.matches({})")).toEqual([])
    expect(evaluate("'a'.matchesFull({})")).toEqual([])
    expect(evaluate("'a'.split({})")).toEqual([])
    expect(evaluate("'a'.startsWith({})")).toEqual([])
    expect(evaluate("'a'.endsWith({})")).toEqual([])
    expect(evaluate("'a'.contains({})")).toEqual([])
    expect(evaluate("'a'.lastIndexOf({})")).toEqual([])
    expect(evaluate("'ab'.substring(0, {})")).toEqual([])
  })

  it('json escaping covers newlines and backslashes', () => {
    expect(evaluate(String.raw`'a\nb'.escape('json')`)).toEqual([String.raw`a\nb`])
    expect(evaluate(String.raw`'a\\b'.escape('json')`)).toEqual([String.raw`a\\b`])
  })

  it('trace with a non-string label falls back to an empty name', () => {
    const traced: string[] = []
    const trace = (name: string): void => {
      traced.push(name)
    }
    expect(evaluate('trace(1)', 5, { trace })).toEqual([5])
    expect(traced).toEqual([''])
  })

  it('children skips underscore keys and null array slots', () => {
    const resource = {
      resourceType: 'Patient',
      birthDate: '1974-12-25',
      _birthDate: { extension: [{ url: 'x' }] },
      given: ['A', null],
    }
    expect(evaluate('children()', resource)).toEqual(['1974-12-25', 'A'])
  })

  it('deep equality distinguishes arrays from objects and unequal keys', () => {
    const input = { resourceType: 'Basic', a: { x: [1, 2] }, b: { x: { y: 1 } }, c: { x: [1, 2], z: 1 } }
    expect(evaluate('a = b', input)).toEqual([false])
    expect(evaluate('a = c', input)).toEqual([false])
    expect(evaluate('a ~ b', input)).toEqual([false])
    expect(evaluate('a != b', input)).toEqual([true])
  })

  it('collections containing dates with mixed precision are empty for =', () => {
    expect(evaluate('(@2012 | 1) = (@2012-01 | 1)')).toEqual([])
  })

  it('unary minus on a non-numeric singleton after empty check', () => {
    expect(evaluate('-{}')).toEqual([])
    expect(evaluate("+(4 'mg')")).toEqual([{ value: 4, unit: 'mg' }])
  })

  it('as() returns empty on type mismatch and ofType handles empty input', () => {
    expect(evaluate("'a'.as(Integer)")).toEqual([])
    expect(evaluate('{}.ofType(Integer)')).toEqual([])
  })

  it('model-qualified type names resolve through the ModelProvider', () => {
    const model: ModelProvider = {
      namespace: 'FHIR',
      resolveType: name => (name === 'Patient' || name === 'Resource' ? `FHIR.${name}` : undefined),
      getElement: () => undefined,
      isSubtypeOf: (type, base) => type === base || (type === 'FHIR.Patient' && base === 'FHIR.Resource'),
    }
    const patient = { resourceType: 'Patient', id: 'p' }
    expect(evaluate('$this is FHIR.Patient', patient, { model })).toEqual([true])
    expect(evaluate('$this is FHIR.Resource', patient, { model })).toEqual([true])
    expect(evaluate('$this is FHIR.Unknown', patient, { model })).toEqual([false])
    expect(evaluate('$this is Resource', patient, { model })).toEqual([true])
    expect(evaluate('$this is Integer', patient, { model })).toEqual([false])
    expect(evaluate('1 is Integer', patient, { model })).toEqual([true])
  })

  it('two-part names without a model match the literal type', () => {
    const patient = { resourceType: 'Patient', id: 'p' }
    expect(evaluate('$this is FHIR.Patient', patient)).toEqual([true])
    expect(evaluate('$this is FHIR.Encounter', patient)).toEqual([false])
  })

  it('System-qualified names never match complex values', () => {
    const patient = { resourceType: 'Patient', id: 'p' }
    expect(evaluate('$this is System.Quantity', patient)).toEqual([false])
  })

  it('join with an empty-collection separator uses no separator', () => {
    expect(evaluate("('a' | 'b').join({})")).toEqual(['ab'])
  })

  it('substring clamps a length that runs past the end', () => {
    expect(evaluate("'abcdef'.substring(2, 100)")).toEqual(['cdef'])
  })
})
