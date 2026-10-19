import { describe, expect, it } from 'vitest'

import { compile } from '../api/compile.ts'
import { evaluate, evaluateAsync } from '../api/evaluate.ts'
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

const patient = {
  resourceType: 'Patient',
  id: 'p',
  managingOrganization: { reference: '#org' },
  contained: [{ resourceType: 'Organization', id: 'org', name: 'ACME' }],
}

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

  it('gives a resolved contained resource its path inside the Bundle entry', () => {
    expect(evaluate('entry.resource.subject.resolve().pathname()', bundle, options)).toEqual([
      'Bundle.entry[0].resource[0].contained[0]',
      'Bundle.entry[1].resource[0].contained[0]',
    ])
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

describe('external references via options.resolver', () => {
  const registry: Record<string, unknown> = {
    'https://ehr.example.org/Organization/acme': { resourceType: 'Organization', id: 'acme', name: 'ACME Remote' },
    'Practitioner/dr-a': { resourceType: 'Practitioner', id: 'dr-a' },
  }
  function stubResolver() {
    const calls: string[] = []
    const resolver = async (reference: string) => {
      calls.push(reference)
      return registry[reference]
    }
    return { calls, resolver }
  }
  const subject = {
    ...patient,
    managingOrganization: { reference: 'https://ehr.example.org/Organization/acme' },
    generalPractitioner: [{ reference: 'Practitioner/dr-a' }],
  }

  it('resolves absolute and relative references through the resolver', async () => {
    const { calls, resolver } = stubResolver()
    await expect(
      evaluateAsync('Patient.managingOrganization.resolve().name', subject, { ...options, resolver })
    ).resolves.toEqual(['ACME Remote'])
    await expect(
      evaluateAsync('Patient.generalPractitioner.resolve().id', subject, { ...options, resolver })
    ).resolves.toEqual(['dr-a'])
    expect(calls).toEqual(['https://ehr.example.org/Organization/acme', 'Practitioner/dr-a'])
  })

  it('local resolution wins: contained and Bundle references never reach the resolver', async () => {
    const { calls, resolver } = stubResolver()
    await expect(
      evaluateAsync('Patient.managingOrganization.resolve().name', patient, { ...options, resolver })
    ).resolves.toEqual(['ACME'])
    // Fragment misses are internal by definition, so they stay empty too.
    await expect(evaluateAsync("'#missing'.resolve()", patient, { ...options, resolver })).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  it('requests independent references together', async () => {
    const started: number[] = []
    let inFlight = 0
    const resolver = async (reference: string) => {
      started.push(++inFlight)
      await null
      inFlight--
      return registry[reference]
    }
    await expect(
      evaluateAsync('(Patient.managingOrganization | Patient.generalPractitioner).resolve().id', subject, {
        ...options,
        resolver,
      })
    ).resolves.toEqual(['acme', 'dr-a'])
    expect(started).toEqual([1, 2])
  })

  it('asks the resolver once per distinct reference', async () => {
    const { calls, resolver } = stubResolver()
    await expect(
      evaluateAsync(
        'Patient.managingOrganization.resolve().name | Patient.managingOrganization.resolve().id',
        subject,
        { ...options, resolver }
      )
    ).resolves.toEqual(['ACME Remote', 'acme'])
    expect(calls).toEqual(['https://ehr.example.org/Organization/acme'])
  })

  it('unresolvable and non-resource answers are empty', async () => {
    const { resolver } = stubResolver()
    await expect(evaluateAsync("'Patient/elsewhere'.resolve()", subject, { ...options, resolver })).resolves.toEqual([])
    const stringResolver = async () => 'not a resource'
    await expect(
      evaluateAsync('Patient.generalPractitioner.resolve()', subject, { ...options, resolver: stringResolver })
    ).resolves.toEqual([])
    for (const value of [null, {}, [], { resourceType: 42 }]) {
      await expect(
        evaluateAsync('Patient.generalPractitioner.resolve()', subject, {
          ...options,
          resolver: async () => value,
        })
      ).resolves.toEqual([])
    }
  })

  it('leaves external references empty under sync evaluate(), which refuses a resolver', () => {
    expect(evaluate('Patient.generalPractitioner.resolve()', subject, options)).toEqual([])
    expect(evaluate('Patient.managingOrganization.resolve().name', patient, options)).toEqual(['ACME'])
    // The types keep the resolver off sync options; an untyped caller is told where it belongs.
    const untyped = { ...options, resolver: stubResolver().resolver } as typeof options
    expect(() => evaluate('Patient.managingOrganization.resolve().name', patient, untyped)).toThrow(
      'options.resolver is only accepted by evaluateAsync() and evaluateTypedAsync()'
    )
  })

  it('resolver failures propagate', async () => {
    const failing = () => Promise.reject(new Error('fhir server unreachable'))
    await expect(
      evaluateAsync('Patient.generalPractitioner.resolve()', subject, { ...options, resolver: failing })
    ).rejects.toThrow('fhir server unreachable')
  })

  it('without a resolver, external references stay empty under evaluateAsync()', async () => {
    await expect(evaluateAsync('Patient.generalPractitioner.resolve()', subject, options)).resolves.toEqual([])
  })

  it('retains resource scope across external and contained resolution hops', async () => {
    const calls: string[] = []
    const resolver = async (reference: string) => {
      calls.push(reference)
      if (reference === 'Patient/remote')
        return {
          resourceType: 'Patient',
          id: 'remote',
          managingOrganization: { reference: '#local' },
          contained: [{ resourceType: 'Organization', id: 'local', partOf: { reference: 'Organization/network' } }],
        }
      if (reference === 'Organization/network')
        return {
          resourceType: 'Organization',
          id: 'network',
          partOf: { reference: '#division' },
          contained: [{ resourceType: 'Organization', id: 'division', partOf: { reference: '#' } }],
        }
      return undefined
    }
    const expression =
      "'Patient/remote'.resolve().managingOrganization.resolve().partOf.resolve().partOf.resolve().partOf.resolve().id"
    await expect(evaluateAsync(expression, bundle, { ...options, resolver })).resolves.toEqual(['network'])
    expect(calls).toEqual(['Patient/remote', 'Organization/network'])
  })

  it("resolves an external resource's references through the resolver, not the input Bundle", async () => {
    const input = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        {
          fullUrl: 'https://local.example/Organization/network',
          resource: { resourceType: 'Organization', id: 'network', name: 'local network' },
        },
      ],
    }
    const calls: string[] = []
    const resolver = async (reference: string) => {
      calls.push(reference)
      if (reference === 'https://remote.example/Patient/p')
        return { resourceType: 'Patient', id: 'p', managingOrganization: { reference: 'Organization/network' } }
      if (reference === 'Organization/network')
        return { resourceType: 'Organization', id: 'network', name: 'remote network' }
      return undefined
    }
    const expression = "'https://remote.example/Patient/p'.resolve().managingOrganization.resolve().name"
    await expect(evaluateAsync(expression, input, { ...options, resolver })).resolves.toEqual(['remote network'])
    expect(calls).toEqual(['https://remote.example/Patient/p', 'Organization/network'])
    // The input's own references still resolve within it.
    await expect(
      evaluateAsync("'Organization/network'.resolve().name", input, { ...options, resolver })
    ).resolves.toEqual(['local network'])
  })

  it('passes the server base of the resource that holds a relative reference', async () => {
    const input = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        {
          fullUrl: 'https://local.example/fhir/Patient/1',
          resource: {
            resourceType: 'Patient',
            id: '1',
            generalPractitioner: [{ reference: 'Practitioner/x' }],
            managingOrganization: { reference: 'https://remote.example/Patient/p' },
          },
        },
      ],
    }
    const calls: [string, string | undefined][] = []
    const resolver = async (reference: string, base: string | undefined) => {
      calls.push([reference, base])
      if (reference === 'https://remote.example/Patient/p')
        return { resourceType: 'Patient', id: 'p', link: [{ other: { reference: 'Patient/q' } }] }
      if (reference === 'Patient/q')
        return { resourceType: 'Patient', id: 'q', link: [{ other: { reference: 'Patient/r' } }] }
      return undefined
    }
    await evaluateAsync(
      "entry.resource.generalPractitioner.resolve() | entry.resource.managingOrganization.resolve().link.other.resolve().link.other.resolve() | 'Patient/z'.resolve()",
      input,
      { ...options, resolver }
    )
    expect(calls).toEqual([
      ['Practitioner/x', 'https://local.example/fhir'],
      ['https://remote.example/Patient/p', undefined],
      ['Patient/z', undefined],
      ['Patient/q', 'https://remote.example'],
      ['Patient/r', 'https://remote.example'],
    ])
  })

  it('keeps Bundle-contained and Bundle entry resolution local with a resolver configured', async () => {
    const { calls, resolver } = stubResolver()
    await expect(
      evaluateAsync('entry.resource.subject.resolve().name.family', bundle, { ...options, resolver })
    ).resolves.toEqual(['one', 'two'])
    await expect(
      evaluateAsync("'urn:uuid:two'.resolve().subject.resolve().name.family", bundle, { ...options, resolver })
    ).resolves.toEqual(['two'])
    expect(calls).toEqual([])
  })

  it('supports typed async variables and preserves static Reference targets', async () => {
    const resource = { resourceType: 'Observation' as const, subject: { reference: 'Patient/remote' } }
    const resolver = async () => ({ resourceType: 'Patient', name: [{ given: ['Ada'] }] })
    const expression = compile('subject.resolve().ofType(Patient).name.given', 'Observation')
    await expect(expression.evaluateAsync(resource, { ...options, strict: true, resolver })).resolves.toEqual(['Ada'])
    await expect(
      evaluateAsync('%patient.name.given', resource, {
        ...options,
        strict: true,
        resolver,
        vars: { patient: 'subject.resolve().ofType(Patient)' },
      })
    ).resolves.toEqual(['Ada'])
    await expect(
      compile('subject.resolve().noSuchField', 'Observation').evaluateAsync(resource, {
        ...options,
        strict: true,
        resolver,
      })
    ).rejects.toThrow('Strict evaluation failed')
  })
})
