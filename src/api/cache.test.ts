import { describe, expect, it } from 'vitest'

import { LruCache } from './cache.ts'

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<number>(2)
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('evicts the least recently used entry at capacity', () => {
    const cache = new LruCache<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('a zero-capacity cache stores nothing', () => {
    const cache = new LruCache<number>(0)
    cache.set('a', 1)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('rejects a capacity that is not a non-negative integer', () => {
    expect(() => new LruCache<number>(-1)).toThrow('non-negative integer')
    expect(() => new LruCache<number>(1.5)).toThrow('non-negative integer')
  })

  it('updating an existing key refreshes it without eviction', () => {
    const cache = new LruCache<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)
    cache.set('c', 3)
    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBeUndefined()
  })
})
