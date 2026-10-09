import { describe, expect, it } from 'vitest'

import { compile } from '../api/compile.ts'
import { evaluate } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'

const sharedReference = { reference: '#p' }
const bundle = {
  resourceType: 'Bundle',
  entry: ['one', 'two'].map(id => ({
    fullUrl: `urn:uuid:${id}`,
    resource: {
      resourceType: 'Observation',
      id,
      subject: sharedReference,
      contained: [
        { resourceType: 'Patient', id: 'p', name: [{ family: id }], managingOrganization: { reference: '#org' } },
        { resourceType: 'Organization', id: 'org', partOf: { reference: '#' } },
      ],
    },
  })),
}
const options = { model: r4Model }

describe('resolve() element scope', () => {
  it('resolves identical fragment references in their own Bundle entries', () => {
    expect(evaluate('entry.resource.subject.resolve().name.family', bundle, options)).toEqual(['one', 'two'])
    expect(evaluate('entry.resource.subject.reference.resolve().name.family', bundle, options)).toEqual(['one', 'two'])
  })

  it('preserves the containing resource through filters, variables and projections', () => {
    expect(evaluate("entry.resource.where(id = 'two').select(subject).resolve().name.family", bundle, options)).toEqual(
      ['two']
    )
    expect(
      evaluate(
        "entry.resource.defineVariable('observations').first().select(%observations.subject.resolve().name.family)",
        bundle,
        options
      )
    ).toEqual(['one', 'two'])
  })

  it('resolves siblings and the container from a contained resource', () => {
    expect(
      evaluate('entry.resource.subject.resolve().managingOrganization.resolve().partOf.resolve().id', bundle, options)
    ).toEqual(['one', 'two'])
    expect(
      evaluate('entry.resource.contained.ofType(Patient).managingOrganization.resolve().id', bundle, options)
    ).toEqual(['org', 'org'])
  })

  it('retains the Bundle and contained scope across resolution hops', () => {
    expect(
      evaluate(
        "'urn:uuid:two'.resolve().subject.resolve().managingOrganization.resolve().partOf.resolve().id",
        bundle,
        options
      )
    ).toEqual(['two'])
    const linked = {
      ...bundle,
      entry: [
        ...bundle.entry,
        { resource: { resourceType: 'Observation', id: 'third', derivedFrom: [{ reference: 'Observation/two' }] } },
      ],
    }
    expect(
      evaluate(
        "entry.resource.where(id = 'third').derivedFrom.resolve().subject.resolve().name.family",
        linked,
        options
      )
    ).toEqual(['two'])
  })

  it('also tracks raw navigation without a model', () => {
    expect(evaluate('entry.resource.subject.resolve().name.family', bundle)).toEqual(['one', 'two'])
    expect(evaluate('entry.children().subject.resolve().name.family', bundle)).toEqual(['one', 'two'])
  })

  it('tracks children() and descendants()', () => {
    expect(evaluate('entry.resource.children().ofType(Reference).resolve().name.family', bundle, options)).toEqual([
      'one',
      'two',
    ])
    const single = { resourceType: 'Bundle', entry: [bundle.entry[0]] }
    expect(evaluate('descendants().ofType(Reference).resolve().ofType(Patient).name.family', single, options)).toEqual([
      'one',
    ])
  })

  it('tracks references under complex and primitive extensions', () => {
    const resource = {
      resourceType: 'Patient',
      contained: [{ resourceType: 'Organization', id: 'org', name: 'Clinic' }],
      extension: [{ url: 'org', valueReference: { reference: '#org' } }],
      _birthDate: { extension: [{ url: 'org', valueReference: { reference: '#org' } }] },
    }
    for (const path of [
      "extension('org')",
      "birthDate.extension('org')",
      'birthDate.extension',
      'birthDate.children()',
    ]) {
      expect(evaluate(`${path}.value.resolve().name`, resource, options)).toEqual(['Clinic'])
    }
  })

  it('retains provenance when evaluateTyped results are reused as vars', () => {
    const references = compile('entry.resource.subject').evaluateTyped(bundle, options)
    expect(evaluate('%refs.resolve().name.family', {}, { ...options, vars: { refs: references } })).toEqual([
      'one',
      'two',
    ])
    expect(references[0]).toStrictEqual({ type: 'FHIR.Reference', value: sharedReference })
  })

  it('uses the originating environment resource instead of the evaluation root', () => {
    expect(
      evaluate('%observation.subject.resolve().name.family', bundle.entry[0]!.resource, {
        ...options,
        env: { observation: bundle.entry[1]!.resource },
      })
    ).toEqual(['two'])
  })

  it('does not borrow contained resources from another entry', () => {
    const resource = {
      resourceType: 'Bundle',
      contained: [{ resourceType: 'Patient', id: 'p' }],
      entry: [{ resource: { resourceType: 'Observation', subject: sharedReference } }],
    }
    expect(evaluate('entry.resource.subject.resolve()', resource, options)).toEqual([])
    expect(evaluate("'#p'.resolve()", undefined, options)).toEqual([])
    expect(evaluate("'Patient/p'.resolve()", undefined, options)).toEqual([])
    expect(
      evaluate(
        'entry.resource.subject.resolve()',
        {
          resourceType: 'Bundle',
          entry: [{ resource: { resourceType: 'Observation', subject: sharedReference, contained: [null] } }],
        },
        options
      )
    ).toEqual([])
  })
})
