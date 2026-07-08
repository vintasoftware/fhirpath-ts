import { describe, expect, it } from 'vitest'

import { FhirPathTypeError } from '../errors.ts'
import { type FhirPathFunction, lookupFunction, registerFunction } from './registry.ts'

const stub = (minArity: number, maxArity: number): FhirPathFunction => ({
  minArity,
  maxArity,
  evaluate: () => [],
})

describe('function registry', () => {
  it('resolves registered functions within their arity range', () => {
    registerFunction('registryTestFn', stub(1, 2))
    expect(lookupFunction('registryTestFn', 1)).toBeDefined()
    expect(lookupFunction('registryTestFn', 2)).toBeDefined()
  })

  it('rejects duplicate registrations', () => {
    registerFunction('registryDuplicate', stub(0, 0))
    expect(() => registerFunction('registryDuplicate', stub(0, 0))).toThrow(
      "FHIRPath function 'registryDuplicate' is registered twice"
    )
  })

  it('rejects unknown functions', () => {
    expect(() => lookupFunction('nope', 0)).toThrow(FhirPathTypeError)
    expect(() => lookupFunction('nope', 0)).toThrow("Unrecognized function 'nope'")
  })

  it('rejects out-of-range argument counts with a readable message', () => {
    registerFunction('registryRange', stub(1, 2))
    expect(() => lookupFunction('registryRange', 0)).toThrow("Function 'registryRange' expects 1 to 2 arguments, got 0")
    registerFunction('registryOne', stub(1, 1))
    expect(() => lookupFunction('registryOne', 3)).toThrow("Function 'registryOne' expects 1 argument, got 3")
    registerFunction('registryTwo', stub(2, 2))
    expect(() => lookupFunction('registryTwo', 0)).toThrow("Function 'registryTwo' expects 2 arguments, got 0")
  })
})
