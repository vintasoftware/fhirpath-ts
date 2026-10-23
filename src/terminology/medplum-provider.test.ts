import { describe, expect, it } from 'vitest'

import { evaluateAsync } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'
import { type MedplumClientLike, medplumResolver, medplumTerminology } from './medplum.ts'

/**
 * A stand-in for Medplum's client: answers come from `answers`, keyed by
 * method and URL, and a `{ status, outcome }` answer is thrown the way
 * `MedplumClient` throws an `OperationOutcomeError`.
 */
function fakeClient(answers: Record<string, unknown>) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const answer = (method: string, url: URL | string, body?: unknown) => {
    const key = `${method} ${String(url).replace('https://medplum.test/fhir/R4/', '')}`
    calls.push({ method, url: String(url), ...(body !== undefined && { body }) })
    if (!(key in answers)) throw new Error(`No answer for ${key}`)
    const found = answers[key] as { outcome?: unknown } | undefined
    if (found !== null && typeof found === 'object' && 'outcome' in found) {
      return Promise.reject(Object.assign(new Error('outcome'), { outcome: found.outcome }))
    }
    return Promise.resolve(found)
  }
  const client: MedplumClientLike = {
    fhirUrl: (...path) => new URL(path.join('/'), 'https://medplum.test/fhir/R4/'),
    get: url => answer('GET', url),
    post: (url, body) => answer('POST', url, body),
  }
  return { client, calls }
}

const notFound = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] } }
const invalid = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] } }
const weightProperty = (value: number) => ({
  name: 'property',
  part: [
    { name: 'code', valueCode: 'itemWeight' },
    { name: 'value', valueDecimal: value },
  ],
})
const scores = 'http://example.org/CodeSystem/scores'
const ordinal = (valueDecimal: number) => [
  { url: 'http://hl7.org/fhir/StructureDefinition/ordinalValue', valueDecimal },
]
const codeSystemBundle = (version?: string) => ({
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'CodeSystem',
        url: scores,
        ...(version && { version }),
        status: 'active',
        content: 'complete',
        concept: [
          { code: 'often', display: 'Often', extension: ordinal(3) },
          { code: 'rarely', concept: [{ code: 'never', extension: ordinal(0) }] },
          { code: 'unscored' },
        ],
      },
    },
  ],
})
const observation = (...codings: object[]) => ({
  resourceType: 'Observation',
  status: 'final',
  code: { coding: codings },
})

describe('medplumTerminology()', () => {
  it('posts each operation as a Parameters resource and returns the answer', async () => {
    const { client, calls } = fakeClient({
      'POST ValueSet/$expand': { resourceType: 'ValueSet', expansion: { contains: [{ code: 'a' }] } },
      'POST ValueSet/$validate-code': {
        resourceType: 'Parameters',
        parameter: [{ name: 'result', valueBoolean: true }],
      },
      'POST CodeSystem/$validate-code': {
        resourceType: 'Parameters',
        parameter: [{ name: 'result', valueBoolean: false }],
      },
      'POST CodeSystem/$subsumes': {
        resourceType: 'Parameters',
        parameter: [{ name: 'outcome', valueCode: 'subsumes' }],
      },
      'POST ConceptMap/$translate': { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] },
    })
    const provider = medplumTerminology(client)
    await expect(provider.expand?.('urn:vs', 'count=10')).resolves.toMatchObject({ resourceType: 'ValueSet' })
    await expect(provider.validateVS?.('urn:vs', { system: 'urn:cs', code: 'a' })).resolves.toMatchObject({
      parameter: [{ name: 'result', valueBoolean: true }],
    })
    await expect(provider.validateCS?.('urn:cs', 'a')).resolves.toMatchObject({
      parameter: [{ name: 'result', valueBoolean: false }],
    })
    // Medplum's $subsumes takes codes only; a Coding's version goes in `version`.
    await expect(
      provider.subsumes?.('urn:cs', { system: 'urn:cs', version: '2', code: 'parent' }, 'child')
    ).resolves.toBe('subsumes')
    await expect(
      provider.translate?.({ resourceType: 'ConceptMap' }, { coding: [{ code: 'a' }] })
    ).resolves.toMatchObject({
      resourceType: 'Parameters',
    })
    await expect(provider.subsumes?.('urn:cs', 'parent', 'child')).resolves.toBe('subsumes')
    expect(calls.map(call => call.body)).toEqual([
      {
        resourceType: 'Parameters',
        parameter: [
          { name: 'url', valueUri: 'urn:vs' },
          { name: 'count', valueString: '10' },
        ],
      },
      {
        resourceType: 'Parameters',
        parameter: [
          { name: 'url', valueUri: 'urn:vs' },
          { name: 'coding', valueCoding: { system: 'urn:cs', code: 'a' } },
        ],
      },
      {
        resourceType: 'Parameters',
        parameter: [
          { name: 'url', valueUri: 'urn:cs' },
          { name: 'code', valueCode: 'a' },
        ],
      },
      {
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: 'urn:cs' },
          { name: 'version', valueString: '2' },
          { name: 'codeA', valueCode: 'parent' },
          { name: 'codeB', valueCode: 'child' },
        ],
      },
      {
        resourceType: 'Parameters',
        parameter: [
          { name: 'conceptMap', resource: { resourceType: 'ConceptMap' } },
          { name: 'codeableConcept', valueCodeableConcept: { coding: [{ code: 'a' }] } },
        ],
      },
      {
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: 'urn:cs' },
          { name: 'codeA', valueCode: 'parent' },
          { name: 'codeB', valueCode: 'child' },
        ],
      },
    ])
    expect(calls.every(call => call.url.startsWith('https://medplum.test/fhir/R4/'))).toBe(true)
    await expect(
      provider.subsumes?.(
        'urn:cs',
        { system: 'urn:cs', version: '1', code: 'a' },
        { system: 'urn:cs', version: '2', code: 'b' }
      )
    ).rejects.toThrow('one version of urn:cs, not 1 and 2')
  })

  it('leaves existence to $lookup when the CodeSystem resource lists no concepts, as an imported one does', async () => {
    const imported = {
      resourceType: 'Bundle',
      entry: [{ resource: { resourceType: 'CodeSystem', url: scores, content: 'complete' } }],
    }
    const { client } = fakeClient({
      'POST CodeSystem/$lookup': {
        resourceType: 'Parameters',
        parameter: [{ name: 'display', valueString: 'Unscored' }],
      },
      [`GET CodeSystem?url=${encodeURIComponent(scores)}`]: imported,
    })
    const options = { model: r4Model, terminology: medplumTerminology(client) }
    await expect(
      evaluateAsync('code.coding.weight()', observation({ system: scores, code: 'unscored' }), options)
    ).resolves.toEqual([])
    const missing = fakeClient({
      'POST CodeSystem/$lookup': notFound,
      [`GET CodeSystem?url=${encodeURIComponent(scores)}`]: imported,
    })
    await expect(
      evaluateAsync('code.coding.weight()', observation({ system: scores, code: 'missing' }), {
        model: r4Model,
        terminology: medplumTerminology(missing.client),
      })
    ).rejects.toThrow('weight() cannot resolve the CodeSystem')
  })

  it('answers undefined for what the server does not have, and keeps other failures', async () => {
    const { client } = fakeClient({
      'POST ValueSet/$expand': invalid,
      'POST CodeSystem/$lookup': notFound,
      'POST CodeSystem/$subsumes': { outcome: { resourceType: 'OperationOutcome', issue: [{ code: 'throttled' }] } },
    })
    const provider = medplumTerminology(client)
    await expect(provider.expand?.('urn:missing')).resolves.toBeUndefined()
    await expect(provider.lookup?.({ system: 'urn:cs', code: 'x' })).resolves.toBeUndefined()
    await expect(provider.subsumes?.('urn:cs', 'a', 'b')).rejects.toThrow('outcome')
  })

  it('returns the $lookup answer as is when it carries the weight property, or no weight was asked for', async () => {
    const answer = {
      resourceType: 'Parameters',
      parameter: [{ name: 'display', valueString: 'Often' }, weightProperty(3)],
    }
    const { client, calls } = fakeClient({ 'POST CodeSystem/$lookup': answer })
    const provider = medplumTerminology(client)
    await expect(provider.lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')).resolves.toBe(answer)
    await expect(provider.lookup?.({ system: scores, code: 'often' })).resolves.toBe(answer)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body).toEqual({
      resourceType: 'Parameters',
      parameter: [
        { name: 'coding', valueCoding: { system: scores, code: 'often' } },
        { name: 'property', valueCode: 'itemWeight' },
      ],
    })
  })

  it('reads an R4 ordinalValue extension from the CodeSystem resource when $lookup reports no weight', async () => {
    const { client, calls } = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [{ name: 'display', valueString: 'Often' }] },
      [`GET CodeSystem?url=${encodeURIComponent(scores)}`]: codeSystemBundle(),
    })
    const provider = medplumTerminology(client)
    await expect(provider.lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')).resolves.toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'display', valueString: 'Often' }, weightProperty(3)],
    })
    // Nested concepts count; a concept without the extension is a confirmed absence; the resource is read once.
    await expect(provider.lookup?.({ system: scores, code: 'never' }, 'property=itemWeight')).resolves.toMatchObject({
      parameter: [{ name: 'display', valueString: 'Often' }, weightProperty(0)],
    })
    await expect(provider.lookup?.({ system: scores, code: 'unscored' }, 'property=itemWeight')).resolves.toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'display', valueString: 'Often' }],
    })
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1)
  })

  it('builds the answer from the resource when $lookup does not know the concept, by the Coding version', async () => {
    const { client, calls } = fakeClient({
      'POST CodeSystem/$lookup': notFound,
      [`GET CodeSystem?url=${encodeURIComponent(scores)}`]: codeSystemBundle('2'),
    })
    const provider = medplumTerminology(client)
    await expect(
      provider.lookup?.({ system: scores, code: 'often', version: '2' }, 'property=itemWeight')
    ).resolves.toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'name', valueString: scores }, weightProperty(3)],
    })
    await expect(
      provider.lookup?.({ system: scores, code: 'unscored', version: '2' }, 'property=itemWeight')
    ).resolves.toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'name', valueString: scores }],
    })
    // A code neither $lookup nor the resource knows is unavailable, which weight() reports as an error.
    await expect(
      provider.lookup?.({ system: scores, code: 'absent', version: '2' }, 'property=itemWeight')
    ).resolves.toBeUndefined()
    // Neither $lookup nor the resource knows the version: the lookup is unavailable.
    await expect(
      provider.lookup?.({ system: scores, code: 'often', version: '3' }, 'property=itemWeight')
    ).resolves.toBeUndefined()
    await expect(provider.lookup?.('often', 'property=itemWeight')).resolves.toBeUndefined()
    expect(calls.filter(call => call.method === 'GET').map(call => call.url)).toEqual([
      `https://medplum.test/fhir/R4/CodeSystem?url=${encodeURIComponent(scores)}`,
    ])
    // Medplum selects the code system version from the `version` parameter only.
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({
      resourceType: 'Parameters',
      parameter: [
        { name: 'coding', valueCoding: { system: scores, code: 'often', version: '2' } },
        { name: 'version', valueString: '2' },
        { name: 'property', valueCode: 'itemWeight' },
      ],
    })
  })

  it('sends a Coding version as the version parameter of CodeSystem $validate-code', async () => {
    const { client, calls } = fakeClient({
      'POST CodeSystem/$validate-code': {
        resourceType: 'Parameters',
        parameter: [{ name: 'result', valueBoolean: true }],
      },
    })
    await medplumTerminology(client).validateCS?.(scores, { system: scores, code: 'often', version: '2' })
    await medplumTerminology(client).validateCS?.(scores, { system: scores, code: 'often', version: '2' }, 'version=3')
    expect(calls.map(call => (call.body as { parameter: unknown[] }).parameter.slice(2))).toEqual([
      [{ name: 'version', valueString: '2' }],
      [{ name: 'version', valueString: '3' }],
    ])
  })

  it('selects the CodeSystem version $lookup answered with for a Coding without one', async () => {
    const versions = {
      resourceType: 'Bundle',
      entry: [1, 5].map(weight => ({
        resource: {
          resourceType: 'CodeSystem',
          url: scores,
          version: `v${weight}`,
          status: 'active',
          content: 'complete',
          concept: [{ code: 'often', extension: ordinal(weight) }],
        },
      })),
    }
    const search = `GET CodeSystem?url=${encodeURIComponent(scores)}`
    const answered = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [{ name: 'version', valueString: 'v5' }] },
      [search]: versions,
    })
    await expect(
      medplumTerminology(answered.client).lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    ).resolves.toMatchObject({ parameter: [{ name: 'version', valueString: 'v5' }, weightProperty(5)] })
    const unanswered = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [] },
      [search]: versions,
    })
    await expect(
      medplumTerminology(unanswered.client).lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    ).rejects.toThrow('finds different weights')
  })

  it('reads every search page before selecting a version', async () => {
    const page = (weight: number, next?: string) => ({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'CodeSystem',
            url: scores,
            version: `v${weight}`,
            status: 'active',
            content: 'complete',
            concept: [{ code: 'often', extension: ordinal(weight) }],
          },
        },
      ],
      ...(next && { link: [{ relation: 'next', url: `https://medplum.test/fhir/R4/${next}` }] }),
    })
    const search = `CodeSystem?url=${encodeURIComponent(scores)}`
    const pages = { [`GET ${search}`]: page(1, `${search}&_offset=1`), [`GET ${search}&_offset=1`]: page(5) }
    const answered = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [{ name: 'version', valueString: 'v5' }] },
      ...pages,
    })
    await expect(
      medplumTerminology(answered.client).lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    ).resolves.toMatchObject({ parameter: [{ name: 'version', valueString: 'v5' }, weightProperty(5)] })
    expect(answered.calls.filter(call => call.method === 'GET')).toHaveLength(2)
    const unanswered = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [] },
      ...pages,
    })
    await expect(
      medplumTerminology(unanswered.client).lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    ).rejects.toThrow('finds different weights')
    const elsewhere = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [] },
      [`GET ${search}`]: { ...page(1), link: [{ relation: 'next', url: 'https://other.test/fhir/CodeSystem?page=2' }] },
    })
    await expect(
      medplumTerminology(elsewhere.client).lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    ).rejects.toThrow('outside the FHIR base')
    const answers: Record<string, unknown> = {
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [{ name: 'version', valueString: 'v5' }] },
      ...pages,
      [`GET ${search}&_offset=1`]: notFound,
    }
    const recovering = medplumTerminology(fakeClient(answers).client)
    const options = { model: r4Model, terminology: recovering }
    const often = observation({ system: scores, code: 'often' })
    await expect(evaluateAsync('code.coding.weight()', often, options)).rejects.toThrow('outcome')
    answers[`GET ${search}&_offset=1`] = page(5)
    await expect(evaluateAsync('code.coding.weight()', often, options)).resolves.toEqual([5])
  })

  it('fails on a malformed CodeSystem weight instead of dropping the score', async () => {
    const malformed = codeSystemBundle()
    const resource = malformed.entry[0]?.resource as { concept: { extension?: unknown }[] }
    resource.concept[0] = {
      ...resource.concept[0],
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/ordinalValue', valueString: '3' }],
    }
    const { client } = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [] },
      [`GET CodeSystem?url=${encodeURIComponent(scores)}`]: malformed,
    })
    await expect(
      medplumTerminology(client).lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    ).rejects.toThrow('weight() requires a numeric valueDecimal')
  })

  it('reads the CodeSystem again after a failed read', async () => {
    let reads = 0
    const client: MedplumClientLike = {
      fhirUrl: (...path) => new URL(path.join('/'), 'https://medplum.test/fhir/R4/'),
      get: () => (++reads === 1 ? Promise.reject(new Error('503')) : Promise.resolve(codeSystemBundle())),
      post: () => Promise.resolve({ resourceType: 'Parameters', parameter: [] }),
    }
    const provider = medplumTerminology(client)
    const lookup = () => provider.lookup?.({ system: scores, code: 'often' }, 'property=itemWeight')
    await expect(lookup()).rejects.toThrow('503')
    await expect(lookup()).resolves.toMatchObject({ parameter: [weightProperty(3)] })
    await expect(lookup()).resolves.toMatchObject({ parameter: [weightProperty(3)] })
    expect(reads).toBe(2)
  })

  it('scores Codings through weight() with contained CodeSystems ahead of the server', async () => {
    const { client, calls } = fakeClient({
      'POST CodeSystem/$lookup': { resourceType: 'Parameters', parameter: [] },
      [`GET CodeSystem?url=${encodeURIComponent(scores)}`]: codeSystemBundle(),
    })
    const input = {
      ...observation(
        { system: scores, code: 'often' },
        { system: scores, code: 'never' },
        { system: 'urn:local', code: 'x' }
      ),
      contained: [
        {
          resourceType: 'CodeSystem',
          url: 'urn:local',
          status: 'active',
          content: 'complete',
          concept: [{ code: 'x', extension: ordinal(10) }],
        },
      ],
    }
    const options = { model: r4Model, terminology: medplumTerminology(client) }
    await expect(evaluateAsync('code.coding.weight()', input, options)).resolves.toEqual([3, 0, 10])
    await expect(
      evaluateAsync('code.coding.weight()', observation({ system: scores, code: 'unscored' }), options)
    ).resolves.toEqual([])
    expect(
      calls.filter(call => call.body !== undefined).map(call => (call.body as { parameter: unknown[] }).parameter[0])
    ).toEqual([
      { name: 'coding', valueCoding: { system: scores, code: 'often' } },
      { name: 'coding', valueCoding: { system: scores, code: 'never' } },
      { name: 'coding', valueCoding: { system: scores, code: 'unscored' } },
    ])
    await expect(
      evaluateAsync('code.coding.weight()', observation({ system: 'urn:unknown', code: 'x' }), {
        model: r4Model,
        terminology: medplumTerminology(
          fakeClient({
            'POST CodeSystem/$lookup': notFound,
            'GET CodeSystem?url=urn%3Aunknown': { resourceType: 'Bundle' },
          }).client
        ),
      })
    ).rejects.toThrow('weight() cannot resolve the CodeSystem')
  })
})

describe('medplumResolver()', () => {
  it('reads references on the client server and resolves references to other servers to nothing', async () => {
    const patient = { resourceType: 'Patient', id: 'p', name: [{ given: ['Ada'] }] }
    const { client, calls } = fakeClient({
      'GET Patient/p': patient,
      'GET Patient/missing': notFound,
    })
    const resolver = medplumResolver(client)
    await expect(resolver('Patient/p', undefined)).resolves.toEqual(patient)
    await expect(resolver('Patient/p', 'https://medplum.test/fhir/R4')).resolves.toEqual(patient)
    await expect(resolver('https://medplum.test/fhir/R4/Patient/p', undefined)).resolves.toEqual(patient)
    await expect(resolver('Patient/missing', undefined)).resolves.toBeUndefined()
    await expect(resolver('Patient/p', 'https://other.test/fhir')).resolves.toBeUndefined()
    await expect(resolver('https://other.test/fhir/Patient/p', undefined)).resolves.toBeUndefined()
    await expect(resolver('https://medplum.test.other.test/fhir/R4/Patient/p', undefined)).resolves.toBeUndefined()
    await expect(resolver('urn:uuid:5d1b9c2e-0000-4000-8000-000000000000', undefined)).resolves.toBeUndefined()
    // Only literal reads: no search or operation URL built from the data.
    await expect(resolver('Patient?identifier=urn:mrn|123', undefined)).resolves.toBeUndefined()
    await expect(resolver('Patient/p/$everything', undefined)).resolves.toBeUndefined()
    expect(calls.map(call => call.url)).toEqual([
      'https://medplum.test/fhir/R4/Patient/p',
      'https://medplum.test/fhir/R4/Patient/p',
      'https://medplum.test/fhir/R4/Patient/p',
      'https://medplum.test/fhir/R4/Patient/missing',
    ])
    const input = { resourceType: 'Observation', subject: { reference: 'Patient/p' } }
    await expect(evaluateAsync('subject.resolve().name.given', input, { model: r4Model, resolver })).resolves.toEqual([
      'Ada',
    ])
  })
})
