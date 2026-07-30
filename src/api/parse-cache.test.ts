import { beforeEach, describe, expect, it, vi } from 'vitest'

// The parse cache exists to avoid re-parsing, and nothing about a return value
// reveals whether a parse happened — so these tests count calls to the parser.
vi.mock('../parser/parser.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../parser/parser.ts')>()
  return { ...actual, parse: vi.fn(actual.parse) }
})

import { parse } from '../parser/parser.ts'
import type { Patient } from '../r4/generated/type-maps.ts'
import { compile, createCachedCompiler } from './compile.ts'
import { FhirPathEngine } from './engine.ts'
import { evaluate } from './evaluate.ts'

const patient: Patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  name: [{ family: 'Chalmers', given: ['Peter'] }],
}

const parses = vi.mocked(parse)

beforeEach(() => {
  parses.mockClear()
})

describe('createCachedCompiler', () => {
  it('reuses the parse of a repeated expression', () => {
    const compileCached = createCachedCompiler()
    const first = compileCached('Patient.name.given')
    expect(compileCached('Patient.name.given')).toBe(first)
    expect(parses).toHaveBeenCalledTimes(1)
  })

  it('keeps compilers independent from one another', () => {
    expect(createCachedCompiler()('Patient.active')).not.toBe(createCachedCompiler()('Patient.active'))
    expect(parses).toHaveBeenCalledTimes(2)
  })

  it('caches nothing at capacity 0', () => {
    const compileCached = createCachedCompiler(0)
    const first = compileCached('Patient.active')
    expect(compileCached('Patient.active')).not.toBe(first)
    expect(parses).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used expression past capacity', () => {
    const compileCached = createCachedCompiler(1)
    const first = compileCached('a')
    compileCached('b') // evicts 'a'
    expect(compileCached('a')).not.toBe(first)
    expect(parses).toHaveBeenCalledTimes(3)
  })

  it('returns an already-compiled expression untouched, without parsing', () => {
    const compiled = compile('Patient.id')
    parses.mockClear()
    expect(createCachedCompiler()(compiled)).toBe(compiled)
    expect(parses).not.toHaveBeenCalled()
  })

  it('rejects a capacity that is not a non-negative integer', () => {
    expect(() => createCachedCompiler(-1)).toThrow('non-negative integer')
    expect(() => createCachedCompiler(1.5)).toThrow('non-negative integer')
  })
})

describe('FhirPathEngine parse cache', () => {
  it('parses a repeated expression once', () => {
    const engine = new FhirPathEngine()
    engine.evaluate('Patient.name.given', patient)
    engine.evaluate('Patient.name.given', patient)
    expect(parses).toHaveBeenCalledTimes(1)
  })

  it('does not share parses between engines', () => {
    new FhirPathEngine().evaluate('Patient.active', patient)
    new FhirPathEngine().evaluate('Patient.active', patient)
    expect(parses).toHaveBeenCalledTimes(2)
  })

  it('does not share parses with the free evaluate()', () => {
    evaluate('Patient.id', patient)
    new FhirPathEngine().evaluate('Patient.id', patient)
    expect(parses).toHaveBeenCalledTimes(2)
  })

  it('serves every method from the one engine-owned cache', () => {
    const engine = new FhirPathEngine()
    // The same expression text through all five paths: one parse for all of them.
    engine.evaluate('name.exists()', patient)
    engine.evaluateTyped('name.exists()', patient)
    engine.filter([patient], 'name.exists()')
    engine.project(patient, { named: 'name.exists()' })
    engine.checkConstraints(patient, [{ key: 'p-1', expression: 'name.exists()' }])
    expect(parses).toHaveBeenCalledTimes(1)
  })

  it('honors cacheSize on the paths that take expressions indirectly', () => {
    const engine = new FhirPathEngine({ cacheSize: 0 })
    engine.filter([patient], 'active')
    engine.filter([patient], 'active')
    engine.project(patient, { family: 'name.family' })
    engine.project(patient, { family: 'name.family' })
    engine.checkConstraints(patient, [{ key: 'p-1', expression: 'id.exists()' }])
    engine.checkConstraints(patient, [{ key: 'p-1', expression: 'id.exists()' }])
    expect(parses).toHaveBeenCalledTimes(6)
  })

  it('evicts past a configured capacity', () => {
    const engine = new FhirPathEngine({ cacheSize: 1 })
    engine.evaluate('Patient.active', patient)
    engine.evaluate('Patient.id', patient) // evicts 'Patient.active'
    engine.evaluate('Patient.active', patient)
    expect(parses).toHaveBeenCalledTimes(3)
  })

  it('rejects a cacheSize that is not a non-negative integer', () => {
    expect(() => new FhirPathEngine({ cacheSize: -1 })).toThrow('non-negative integer')
    expect(() => new FhirPathEngine({ cacheSize: 1.5 })).toThrow('non-negative integer')
  })

  it('bypasses the cache for expressions compiled up front', () => {
    const engine = new FhirPathEngine()
    const bound = engine.compile('Patient.name.family')
    bound.evaluate(patient)
    bound.evaluate(patient)
    expect(parses).toHaveBeenCalledTimes(1) // parsed by compile(), never re-parsed
    engine.evaluate('Patient.name.family', patient)
    expect(parses).toHaveBeenCalledTimes(2) // and it did not populate the cache
  })

  it('stays correct with caching off, where every expression is re-parsed', () => {
    const engine = new FhirPathEngine({ cacheSize: 0 })
    expect(engine.evaluate('Patient.name.given', patient)).toEqual(['Peter'])
    expect(engine.evaluate('Patient.name.family', patient)).toEqual(['Chalmers'])
    expect(engine.evaluate('Patient.name.given', patient)).toEqual(['Peter'])
    expect(engine.filter([patient], 'active')).toEqual([patient])
    expect(engine.project(patient, { given: 'name.given.first()' })).toEqual({ given: 'Peter' })
    expect(engine.checkConstraints(patient, [{ key: 'p-1', expression: 'name.exists()' }]).valid).toBe(true)
  })
})
