import { describe, expect, it } from 'vitest'
import type { ModelProvider } from '../model/provider'
import { parse } from '../parser/parser'
import { toCollection, toTypedValue } from '../values/typed-value'
import { createContext, withFrame } from './context'
import { evaluateNode } from './evaluator'

describe('withFrame', () => {
  it('binds $this, $index, and $total for the body only', () => {
    const context = createContext({ root: toCollection('root') })
    const result = withFrame(
      context,
      { thisValue: toCollection('inner'), index: 3, total: toCollection(10) },
      inner => ({
        thisValue: evaluateNode(parse('$this'), inner, []),
        index: evaluateNode(parse('$index'), inner, []),
        total: evaluateNode(parse('$total'), inner, []),
      })
    )
    expect(result.thisValue.map(item => item.value)).toEqual(['inner'])
    expect(result.index.map(item => item.value)).toEqual([3])
    expect(result.total.map(item => item.value)).toEqual([10])
    expect(evaluateNode(parse('$this'), context, []).map(item => item.value)).toEqual(['root'])
  })

  it('inner frames inherit $index and $total from enclosing frames', () => {
    const context = createContext({ root: [] })
    const values = withFrame(context, { thisValue: [], index: 1, total: toCollection(5) }, outer =>
      withFrame(outer, { thisValue: toCollection('x') }, inner => ({
        index: evaluateNode(parse('$index'), inner, []),
        total: evaluateNode(parse('$total'), inner, []),
      }))
    )
    expect(values.index.map(item => item.value)).toEqual([1])
    expect(values.total.map(item => item.value)).toEqual([5])
  })
})

describe('model-aware root identifiers', () => {
  const model: ModelProvider = {
    namespace: 'FHIR',
    resolveType: name => (name === 'Resource' || name === 'Patient' ? `FHIR.${name}` : undefined),
    getElement: () => undefined,
    isSubtypeOf: (type, base) => type === base || (type === 'FHIR.Patient' && base === 'FHIR.Resource'),
  }

  it('matches supertypes through the model', () => {
    const patient = toTypedValue({ resourceType: 'Patient', id: 'x' })
    const context = createContext({ root: [patient], model })
    expect(evaluateNode(parse('Resource.id'), context, [patient]).map(item => item.value)).toEqual(['x'])
    expect(evaluateNode(parse('Observation.id'), context, [patient])).toEqual([])
  })
})
