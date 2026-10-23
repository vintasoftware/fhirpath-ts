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
    await expect(provider.subsumes?.('urn:cs', { system: 'urn:cs', code: 'parent' }, 'child')).resolves.toBe('subsumes')
    await expect(
      provider.translate?.({ resourceType: 'ConceptMap' }, { coding: [{ code: 'a' }] })
    ).resolves.toMatchObject({
      resourceType: 'Parameters',
    })
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
    ])
    expect(calls.every(call => call.url.startsWith('https://medplum.test/fhir/R4/'))).toBe(true)
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

  it('builds the answer from the resource when $lookup does not know the concept, and passes the version on', async () => {
    const { client, calls } = fakeClient({
      'POST CodeSystem/$lookup': notFound,
      [`GET CodeSystem?url=${encodeURIComponent(scores)}&version=2`]: codeSystemBundle('2'),
      [`GET CodeSystem?url=${encodeURIComponent(scores)}&version=3`]: { resourceType: 'Bundle' },
    })
    const provider = medplumTerminology(client)
    await expect(
      provider.lookup?.({ system: scores, code: 'often', version: '2' }, 'property=itemWeight')
    ).resolves.toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'name', valueString: scores }, { name: 'display', valueString: 'Often' }, weightProperty(3)],
    })
    await expect(
      provider.lookup?.({ system: scores, code: 'unscored', version: '2' }, 'property=itemWeight')
    ).resolves.toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'name', valueString: scores }],
    })
    // Neither $lookup nor the resource knows the concept or the version: the lookup is unavailable.
    await expect(
      provider.lookup?.({ system: scores, code: 'absent', version: '2' }, 'property=itemWeight')
    ).resolves.toBeUndefined()
    await expect(
      provider.lookup?.({ system: scores, code: 'often', version: '3' }, 'property=itemWeight')
    ).resolves.toBeUndefined()
    await expect(provider.lookup?.('often', 'property=itemWeight')).resolves.toBeUndefined()
    expect(calls.filter(call => call.method === 'GET').map(call => call.url)).toEqual([
      `https://medplum.test/fhir/R4/CodeSystem?url=${encodeURIComponent(scores)}&version=2`,
      `https://medplum.test/fhir/R4/CodeSystem?url=${encodeURIComponent(scores)}&version=3`,
    ])
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
  it('reads relative references from the client server or the holding resource base, and absolute ones as written', async () => {
    const patient = { resourceType: 'Patient', id: 'p', name: [{ given: ['Ada'] }] }
    const { client, calls } = fakeClient({
      'GET Patient/p': patient,
      'GET https://other.test/fhir/Patient/p': { ...patient, name: [{ given: ['Other'] }] },
      'GET https://third.test/fhir/Patient/p': { ...patient, name: [{ given: ['Third'] }] },
      'GET Patient/missing': notFound,
    })
    const resolver = medplumResolver(client)
    await expect(resolver('Patient/p', undefined)).resolves.toEqual(patient)
    await expect(resolver('Patient/p', 'https://other.test/fhir')).resolves.toMatchObject({
      name: [{ given: ['Other'] }],
    })
    await expect(resolver('https://third.test/fhir/Patient/p', 'https://other.test/fhir')).resolves.toMatchObject({
      name: [{ given: ['Third'] }],
    })
    await expect(resolver('Patient/missing', undefined)).resolves.toBeUndefined()
    expect(calls.map(call => call.url)).toEqual([
      'https://medplum.test/fhir/R4/Patient/p',
      'https://other.test/fhir/Patient/p',
      'https://third.test/fhir/Patient/p',
      'https://medplum.test/fhir/R4/Patient/missing',
    ])
    const input = { resourceType: 'Observation', subject: { reference: 'Patient/p' } }
    await expect(evaluateAsync('subject.resolve().name.given', input, { model: r4Model, resolver })).resolves.toEqual([
      'Ada',
    ])
  })
})
