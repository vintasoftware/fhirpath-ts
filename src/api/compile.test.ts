import { describe, expect, it } from 'vitest'
import { cachedCompile, createParseCache, DEFAULT_PARSE_CACHE_SIZE } from './compile.ts'

describe('cachedCompile', () => {
  it('returns the same CompiledExpression instance for a repeated expression', () => {
    const cache = createParseCache()
    const first = cachedCompile('Patient.name.given', cache)
    const second = cachedCompile('Patient.name.given', cache)
    expect(second).toBe(first)
  })

  it('keeps caches independent from one another', () => {
    const a = createParseCache()
    const b = createParseCache()
    expect(cachedCompile('Patient.active', a)).not.toBe(cachedCompile('Patient.active', b))
  })

  it('evicts the least recently used expression past capacity', () => {
    const cache = createParseCache(1)
    const first = cachedCompile('a', cache)
    cachedCompile('b', cache) // evicts 'a'
    expect(cachedCompile('a', cache)).not.toBe(first) // re-parsed after eviction
  })

  it('returns an already-compiled expression untouched', () => {
    const cache = createParseCache()
    const compiled = cachedCompile('Patient.id', cache)
    expect(cachedCompile(compiled, cache)).toBe(compiled)
  })

  it('defaults the capacity to Firely-matching 500', () => {
    expect(DEFAULT_PARSE_CACHE_SIZE).toBe(500)
  })
})
