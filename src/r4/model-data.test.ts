import { describe, expect, it } from 'vitest'

import { R4_RESOURCES_COMPACT } from './generated/resources-data.ts'
import { CompactTypeTable, decodeCompactTypes, encodeCompactTypes, type GeneratedType } from './model-data.ts'

/** Exercises every feature of the compact format: bases, flags, targets, empty tables. */
const SAMPLE: Record<string, GeneratedType> = {
  Base: { e: {} },
  Thing: {
    b: 'Base',
    e: {
      name: { t: ['string'] },
      part: { t: ['Thing.part'], a: 1 },
      value: { t: ['boolean', 'dateTime'], c: 1 },
      owner: { t: ['Reference'], r: ['Patient', 'Organization'] },
      links: { t: ['Reference'], a: 1, r: ['Thing'] },
    },
  },
  'Thing.part': { b: 'BackboneElement', e: { code: { t: ['System.String'] } } },
}

describe('compact model encoding', () => {
  it('round-trips through encode and decode', () => {
    expect(decodeCompactTypes(encodeCompactTypes(SAMPLE))).toEqual(SAMPLE)
  })

  it('rejects names that collide with the format delimiters', () => {
    expect(() => encodeCompactTypes({ 'a|b': { e: {} } })).toThrow(/reserved/)
    expect(() => encodeCompactTypes({ ok: { e: { 'x;y': { t: ['string'] } } } })).toThrow(/reserved/)
    expect(() => encodeCompactTypes({ ok: { e: { x: { t: ['a,b'] } } } })).toThrow(/reserved/)
  })

  it('serves lazy lookups with per-type caching', () => {
    const table = new CompactTypeTable(encodeCompactTypes(SAMPLE))
    expect(table.get('Nope')).toBeUndefined()
    const thing = table.get('Thing')
    expect(thing?.b).toBe('Base')
    expect(thing?.e['value']).toEqual({ t: ['boolean', 'dateTime'], c: 1 })
    expect(thing?.e['links']).toEqual({ t: ['Reference'], a: 1, r: ['Thing'] })
    expect(table.get('Thing')).toBe(thing)
    expect(table.get('Base')).toEqual({ e: {} })
  })

  it('round-trips the generated resource table', () => {
    const decoded = decodeCompactTypes(R4_RESOURCES_COMPACT)
    expect(encodeCompactTypes(decoded)).toBe(R4_RESOURCES_COMPACT)
    expect(decoded['Patient']?.e['deceased']).toEqual({ t: ['boolean', 'dateTime'], c: 1 })
  })
})
