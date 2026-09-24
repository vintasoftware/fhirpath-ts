import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Observation } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { defineDto, dtoDefinition, type DtoOptions } from './dto.ts'
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

  it('is read from the defineDto options, with either key spelling', () => {
    class Spelled extends defineDto('Observation', { env: { '%prefixed': 'yes', bare: 'also' } }) {
      prefixed = this.column('%prefixed', { type: 'string', default: '' })

      bare = this.column('%bare', { type: 'string', default: '' })
    }
    // Both spellings name one variable, as everywhere else env is accepted.
    expect(dtoDefinition(Spelled).env).toEqual({ prefixed: 'yes', bare: 'also' })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Spelled] })
    expect(engine.evaluate('prefixed() | bare()', weighed)).toEqual(['yes', 'also'])
  })

  it('declaring nothing and declaring an empty record are the same answer', () => {
    class Empty extends defineDto('Observation', { env: {} }) {
      status = this.column('status', { type: 'string', default: '' })
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
    class Counted extends defineDto('Observation', { env: { table: counted } }) {
      head = this.column('%table.first()', { type: 'string', default: '' })
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

  it('reaches the columns of every subclass', () => {
    class Base extends defineDto('Observation', { env: { unit: 'kg', label: 'Reading' } }) {
      label = this.column('%label', { default: '' })
    }
    class Derived extends Base {
      unit = this.column('%unit', { default: '' })
    }
    expect(dtoDefinition(Derived).env).toEqual({ unit: 'kg', label: 'Reading' })
    expect(r4.project(weighed, Derived)).toMatchObject({ unit: 'kg', label: 'Reading' })
    expectTypeOf(r4.project(weighed, Derived).unit).toEqualTypeOf<string>()
  })

  it('varies per class through a factory that forwards its options', () => {
    // A subclass cannot change the env its base columns were inferred against,
    // so variants of one row shape come from a function that calls defineDto.
    function unitRow<const Options extends DtoOptions>(options: Options) {
      return class UnitRow extends defineDto('Observation', options) {}
    }
    class Kilograms extends unitRow({ env: { unit: 'kg' } }) {
      unit = this.column('%unit', { default: '' })
    }
    class Pounds extends unitRow({ env: { unit: '[lb_av]', factor: 2.2 } }) {
      unit = this.column('%unit', { default: '' })

      factor = this.column('%factor', { default: 1 })
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Kilograms] })
    expect(engine.project(weighed, Kilograms).unit).toBe('kg')
    expect(engine.project(weighed, Pounds)).toMatchObject({ unit: '[lb_av]', factor: 2.2 })
    expectTypeOf(engine.project(weighed, Pounds).factor).toEqualTypeOf<number>()
  })

  it('refuses options it could never apply', () => {
    // A JavaScript caller or a cast can still pass a list.
    expect(() => defineDto('Observation', { env: ['kg'] as unknown as Record<string, unknown> })).toThrow(
      "defineDto('Observation'): 'env' must be a record of variables, the same shape as EvaluateOptions.env"
    )
    // The DTO's own value always wins, so a caller value under the same name
    // would be silently ignored. Either spelling names the same variable.
    expect(() => defineDto('Observation', { env: { '%site': 'dto' }, callerEnv: ['site'] })).toThrow(
      "defineDto('Observation'): callerEnv names 'site', which the DTO's own env already binds"
    )
    expect(() =>
      defineDto('Observation', { env: { site: 'dto' }, callerEnv: { '%site': { type: 'string' } } })
    ).toThrow("callerEnv names 'site'")
  })

  it('lays over the caller env for the call and leaves it as it was', () => {
    class Sited extends defineDto('Observation', { env: { site: 'dto' } }) {
      site = this.column('%site', { type: 'string', default: '' })
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Sited] })
    // Inside the body the DTO's value wins; outside it, before and after the
    // same call, the engine's is untouched.
    expect(engine.evaluate('%site.combine(site()).combine(%site)', weighed)).toEqual(['engine', 'dto', 'engine'])
  })

  it('leaves every name the DTO does not declare to the caller', () => {
    class Partial extends defineDto('Observation', { env: { own: 'mine' } }) {
      seen = this.column("%site.combine(%own).combine(%loinc).combine(%context.status).join('/')", {
        type: 'string',
        default: '',
      })
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Partial] })
    // The engine env, the built-in constants, and %context all stay the
    // caller's; only `own` is added.
    expect(engine.evaluate('seen()', weighed)).toEqual(['engine/mine/http://loinc.org/final'])
  })

  it('reaches a per-call name the caller supplies, and keeps its own where they collide', () => {
    class Requested extends defineDto('Observation', { env: { site: 'dto' } }) {
      tagged = this.column("%requestId.combine(%site).join('/')", { type: 'string', default: '' })
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Requested] })
    // A per-call name the DTO never declared is readable in the body...
    expect(engine.evaluate('tagged()', weighed, { env: { requestId: 'r-1' } })).toEqual(['r-1/dto'])
    // ...but where both name it, the DTO's own value is what its column meant.
    expect(engine.evaluate('tagged()', weighed, { env: { requestId: 'r-2', site: 'call' } })).toEqual(['r-2/dto'])
  })

  it('gives each DTO its own overlay when one column calls another DTO', () => {
    class Inner extends defineDto('CodeableConcept', { env: { source: 'inner', innerOnly: 'yes' } }) {
      sourced = this.column("%source.combine(%outerOnly).join('/')", { type: 'string', default: '' })
    }
    class Outer extends defineDto('Observation', { env: { source: 'outer', outerOnly: 'reachable' } }) {
      chained = this.column("code.sourced().combine(%source).join('/')", { type: 'string', default: '' })

      borrowed = this.column('%innerOnly', { type: 'string', default: '' })
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
    class Concepts extends defineDto('CodeableConcept', { env: { wanted: 'Weight' } }) {
      wantedLabel = this.column('%wanted', { type: 'string', default: '' })
    }
    class Codings extends defineDto('Coding', { env: { wanted: 'Body weight' } }) {
      wantedLabel = this.column('%wanted', { type: 'string', default: '' })
    }
    class Flags extends defineDto('Observation', { env: { finalStatus: 'final' } }) {
      isFinal = this.criteria('status = %finalStatus')
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
    class Reported extends defineDto('DiagnosticReport', { env: { fallback: 'unread' } }) {
      summary = this.column('(conclusion | %fallback).first()', { type: 'string', default: '' })
    }
    class Row extends defineDto('DiagnosticReport', { vars: { text: 'summary()' } }) {
      line = this.column("%rowIndex.toString().combine(%text).join(':')", { type: 'string', default: '' })
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
    class Looping extends defineDto('Observation', { env: { marker: 'x' } }) {
      loops = this.column("%marker.combine(loops()).join('')", { type: 'string', default: '' })
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Looping] })
    expect(() => engine.evaluate('loops()', weighed)).toThrow(
      "Expression-defined function 'loops' calls itself, directly or through another function"
    )
  })
})
