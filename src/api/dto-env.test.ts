import { describe, expect, it } from 'vitest'

import type { Observation } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { column, criteria, defineDto, dtoDefinition, type DtoEnv } from './dto.ts'
import { FhirPathEngine } from './engine.ts'

const weighed: Observation = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Weight' },
  valueQuantity: { value: 80, unit: 'kg', code: 'kg' },
  effectiveDateTime: '2026-01-05T08:30:00Z',
}

describe('a DTO env reaches its own columns and stops there', () => {
  /** The engine variable every case below checks a DTO env against. */
  const withEngineEnv = { model: r4Model, env: { site: 'engine' } }

  it('is collected from the class, with either key spelling', () => {
    class Spelled extends defineDto('Observation') {
      static env = { '%prefixed': 'yes', bare: 'also' }

      @column('%prefixed', { type: 'string', default: '' })
      prefixed!: string

      @column('%bare', { type: 'string', default: '' })
      bare!: string
    }
    // Both spellings name one variable, as everywhere else env is accepted.
    expect(dtoDefinition(Spelled).env).toEqual({ prefixed: 'yes', bare: 'also' })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Spelled] })
    expect(engine.evaluate('prefixed() | bare()', weighed)).toEqual(['yes', 'also'])
  })

  it('reads a static getter, once, for a table built rather than written out', () => {
    let built = 0
    class Computed extends defineDto('Observation') {
      static get env(): DtoEnv {
        built += 1
        return { codes: ['final', 'amended'] }
      }

      @column('%codes.where($this = %context.status).exists()', { type: 'boolean', default: false })
      known!: boolean
    }
    // The definition is collected once per class, so the getter runs once
    // however many rows or calls follow.
    expect(r4.project([weighed, weighed], Computed).map(row => row.known)).toEqual([true, true])
    expect(built).toBe(1)
  })

  it('declaring nothing and declaring an empty record are the same answer', () => {
    class Empty extends defineDto('Observation') {
      static env = {}

      @column('status', { type: 'string', default: '' })
      status!: string
    }
    // An empty record would otherwise attach an overlay that costs a copy of
    // the whole env on every call and can never change an answer.
    expect(dtoDefinition(Empty).env).toBeUndefined()
    expect(r4.project(weighed, Empty).status).toBe('final')
  })

  it('wraps the declared values once, not on every evaluation', () => {
    // A context factory is built per evaluation and resolves every registered
    // function, so an overlay rebuilt there would re-wrap a DTO's tables even
    // for expressions that never call one of its columns.
    let reads = 0
    const table = ['a', 'b']
    const counted = new Proxy(table, {
      get(target, key) {
        if (key === 'length') {
          reads += 1
        }
        return Reflect.get(target, key)
      },
    })
    class Counted extends defineDto('Observation') {
      static env = { table: counted }

      @column('%table.first()', { type: 'string', default: '' })
      head!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Counted] })
    engine.evaluate('head()', weighed)
    const wrapped = reads
    expect(wrapped).toBeGreaterThan(0)
    for (let i = 0; i < 5; i += 1) {
      engine.evaluate('1 + 1', weighed)
      engine.evaluate('head()', weighed)
    }
    expect(reads).toBe(wrapped)
  })

  it('merges down the class chain, most derived winning per name', () => {
    // Annotating the base `DtoEnv` is what lets a subclass name one entry: an
    // inferred literal type would make TypeScript demand the whole record back.
    class Base extends defineDto('Observation') {
      static env: DtoEnv = { unit: 'kg', label: 'Reading' }

      @column('%label', { type: 'string', default: '' })
      label!: string
    }
    class Derived extends Base {
      static override env = { unit: 'lb' }

      @column('%unit', { type: 'string', default: '' })
      unit!: string
    }
    // The base keeps its own view: a subclass overriding one entry changes
    // nothing for the class it extends.
    expect(dtoDefinition(Derived).env).toEqual({ unit: 'lb', label: 'Reading' })
    expect(dtoDefinition(Base).env).toEqual({ unit: 'kg', label: 'Reading' })
    expect(r4.project(weighed, Derived)).toMatchObject({ unit: 'lb', label: 'Reading' })
  })

  it('overriding a table in a subclass swaps it for that subclass, not for calls into the registered DTO', () => {
    class Registered extends defineDto('Observation') {
      static env = { unit: 'kg' }

      @column('%unit', { type: 'string', default: '' })
      unit!: string

      @column('unit()', { type: 'string', default: '' })
      viaCall!: string
    }
    class Stubbed extends Registered {
      static override env = { unit: 'lb' }
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Registered] })
    // A call resolves to whichever DTO the engine registered, and runs with that
    // DTO's env — the subclass is not the one registered, so `unit()` is still
    // the original's. Register the subclass in its place to swap both.
    expect(engine.project(weighed, Stubbed)).toMatchObject({ unit: 'lb', viaCall: 'kg' })
    expect(engine.project(weighed, Registered)).toMatchObject({ unit: 'kg', viaCall: 'kg' })
  })

  it('refuses a static env that is not a record of variables', () => {
    class NotARecord extends defineDto('Observation') {
      static env = ['kg']

      @column('status', { type: 'string', default: '' })
      status!: string
    }
    expect(() => r4.project(weighed, NotARecord)).toThrow(
      "DTO NotARecord declares a static 'env' that is not a record of variables"
    )

    // The blame follows the declaration, not the class being projected: naming
    // the subclass would point at the file with nothing to fix in it.
    class Inherited extends NotARecord {
      @column('id', { type: 'string', default: '' })
      id!: string
    }
    expect(() => r4.project(weighed, Inherited)).toThrow(
      "DTO NotARecord declares a static 'env' that is not a record of variables"
    )

    // Nothing to declare is not a mistake: a DTO that computes its table and
    // comes up with none reads like one that never declared env at all.
    class NoneAfterAll extends defineDto('Observation') {
      static env: DtoEnv | undefined = undefined

      @column('status', { type: 'string', default: '' })
      status!: string
    }
    expect(dtoDefinition(NoneAfterAll).env).toBeUndefined()
    expect(r4.project(weighed, NoneAfterAll).status).toBe('final')
  })

  it('lays over the caller env for the call and leaves it as it was', () => {
    class Sited extends defineDto('Observation') {
      static env = { site: 'dto' }

      @column('%site', { type: 'string', default: '' })
      site!: string
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Sited] })
    // Inside the body the DTO's value wins; outside it, before and after the
    // same call, the engine's is untouched.
    expect(engine.evaluate('%site.combine(site()).combine(%site)', weighed)).toEqual(['engine', 'dto', 'engine'])
  })

  it('leaves every name the DTO does not declare to the caller', () => {
    class Partial extends defineDto('Observation') {
      static env = { own: 'mine' }

      @column("%site.combine(%own).combine(%loinc).combine(%context.status).join('/')", {
        type: 'string',
        default: '',
      })
      seen!: string
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Partial] })
    // The engine env, the built-in constants, and %context all stay the
    // caller's; only `own` is added.
    expect(engine.evaluate('seen()', weighed)).toEqual(['engine/mine/http://loinc.org/final'])
  })

  it('reaches a per-call name the caller supplies, and keeps its own where they collide', () => {
    class Requested extends defineDto('Observation') {
      static env = { site: 'dto' }

      @column("%requestId.combine(%site).join('/')", { type: 'string', default: '' })
      tagged!: string
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Requested] })
    // A per-call name the DTO never declared is readable in the body...
    expect(engine.evaluate('tagged()', weighed, { env: { requestId: 'r-1' } })).toEqual(['r-1/dto'])
    // ...but where both name it, the DTO's own value is what its column meant.
    expect(engine.evaluate('tagged()', weighed, { env: { requestId: 'r-2', site: 'call' } })).toEqual(['r-2/dto'])
  })

  it('gives each DTO its own overlay when one column calls another DTO', () => {
    class Inner extends defineDto('CodeableConcept') {
      static env = { source: 'inner', innerOnly: 'yes' }

      @column("%source.combine(%outerOnly).join('/')", { type: 'string', default: '' })
      sourced!: string
    }
    class Outer extends defineDto('Observation') {
      static env = { source: 'outer', outerOnly: 'reachable' }

      @column("code.sourced().combine(%source).join('/')", { type: 'string', default: '' })
      chained!: string

      @column('%innerOnly', { type: 'string', default: '' })
      borrowed!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Inner, Outer] })
    // Inner's body sees its own %source, and Outer's %outerOnly through the
    // caller env it inherits; back in Outer, %source is Outer's again.
    expect(engine.evaluate('chained()', weighed)).toEqual(['inner/reachable/outer'])
    // The overlay lasts exactly as long as the body it belongs to, so Inner's
    // private name is undefined in Outer — the spec's answer for a name nothing
    // declares, not an empty one.
    expect(() => engine.evaluate('borrowed()', weighed)).toThrow('Undefined environment variable %innerOnly')
  })

  it('travels with a criteria, and with each member of an overloaded name', () => {
    class Concepts extends defineDto('CodeableConcept') {
      static env = { wanted: 'Weight' }

      @column('%wanted', { type: 'string', default: '' })
      wantedLabel!: string
    }
    class Codings extends defineDto('Coding') {
      static env = { wanted: 'Body weight' }

      @column('%wanted', { type: 'string', default: '' })
      wantedLabel!: string
    }
    class Flags extends defineDto('Observation') {
      static env = { finalStatus: 'final' }

      @criteria('status = %finalStatus')
      isFinal!: boolean
    }
    const coded: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Weight', coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Concepts, Codings, Flags] })
    // One name, two bodies, two envs — the focus picks both together.
    expect(engine.evaluate('code.wantedLabel()', coded)).toEqual(['Weight'])
    expect(engine.evaluate('code.coding.wantedLabel()', coded)).toEqual(['Body weight'])
    // And the criteria rule and the overlay apply to the same call.
    expect(engine.evaluate('isFinal()', weighed)).toEqual([true])
    expect(engine.evaluate('isFinal()', { resourceType: 'Observation' })).toEqual([false])
  })

  it('is in scope for a body reached through a var, and beside %rowIndex when projecting', () => {
    class Reported extends defineDto('DiagnosticReport') {
      static env = { fallback: 'unread' }

      @column('(conclusion | %fallback).first()', { type: 'string', default: '' })
      summary!: string
    }
    class Row extends defineDto('DiagnosticReport', { vars: { text: 'summary()' } }) {
      @column("%rowIndex.toString().combine(%text).join(':')", { type: 'string', default: '' })
      line!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Reported] })
    // The var body calls the column, whose own env resolves there too, and the
    // row numbering the projection adds is still the caller env the body reads.
    expect(engine.project([{ resourceType: 'DiagnosticReport' }, { resourceType: 'DiagnosticReport' }], Row)).toEqual([
      expect.objectContaining({ line: '0:unread' }),
      expect.objectContaining({ line: '1:unread' }),
    ])
  })

  it('does not weaken the recursion guard', () => {
    class Looping extends defineDto('Observation') {
      static env = { marker: 'x' }

      @column("%marker.combine(loops()).join('')", { type: 'string', default: '' })
      loops!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Looping] })
    expect(() => engine.evaluate('loops()', weighed)).toThrow(
      "Expression-defined function 'loops' calls itself, directly or through another function"
    )
  })
})
