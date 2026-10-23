import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TerminologyProvider } from '../../src/index.ts'
import type { MedplumClientLike } from '../../src/terminology/medplum.ts'
import { fhirClient } from '../../src/terminology/medplum.ts'
import { evaluate, medplumServices, smartFormsFhirpath } from './smart-forms-fhirpath.ts'
import { readTemplatePath } from './template-path.ts'

const response = {
  resourceType: 'QuestionnaireResponse',
  id: 'current',
  status: 'completed',
  item: [{ linkId: 'name', answer: [{ valueString: 'Ada' }, { valueString: 'Ada' }] }],
}
const typed = { resolveInternalTypes: false }
const sync = (fhirData: unknown, path: string, env: Record<string, unknown> = {}, options = {}) => {
  const result = evaluate(fhirData, path, env, undefined, options)
  if (result instanceof Promise) throw new Error('expected a synchronous result')
  return result
}

describe('Smart Forms call shapes', () => {
  it('takes fhirpath.js argument order with the R4 model fixed', () => {
    expect(sync(response, 'item.answer.value')).toEqual(['Ada', 'Ada'])
    expect(sync(response, 'item.answer.value.ofType(string)')).toEqual(['Ada', 'Ada'])
    expect(sync({}, '%weight / (%height / 100).power(2)', { weight: [60], height: [200] })).toEqual([15])
    expect(sync(response, 'false')).toEqual([false])
    expect(sync(response, '0')).toEqual([0])
    expect(sync(response, '@2026-10-08')).toEqual(['2026-10-08'])
    expect(sync(response, '{}')).toEqual([])
  })

  it('types a detached fragment from the host-declared base', () => {
    const item = { linkId: 'weight', answer: [{ valueDecimal: 77.3 }] }
    const resource = { resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [item] }
    const path = (expression: string) => ({ base: 'QuestionnaireResponse.item', expression })
    expect(evaluate(item, path('answer.value'), { resource })).toEqual([77.3])
    expect(evaluate(item, path('%resource.status'), { resource })).toEqual(['in-progress'])
  })

  it('keeps resource types when reading an array in the population environment', () => {
    const conditions = [{ resourceType: 'Condition', onsetDateTime: '2015-02-12T23:00:00-03:00' }]
    expect(sync({}, '%conditions.onset.ofType(FHIR.dateTime).toDate()', { conditions })).toEqual(['2015-02-12'])
  })
})

describe('typed results between calls', () => {
  it('preserves duplicate primitive results and their FHIR type', () => {
    const contexts = sync(response, 'item.answer.value', {}, typed)
    expect(contexts).toHaveLength(2)
    expect(contexts.map(context => sync(context, 'ofType(FHIR.string)'))).toEqual([['Ada'], ['Ada']])
    expect(sync(contexts[0], 'ofType(System.String)')).toEqual([])
    expect(sync(contexts[0], '%resource.id')).toEqual(['current'])
  })

  it('preserves choice navigation and %context inside nested selections', () => {
    const contexts = sync(response, 'item', {}, typed)
    expect(sync(contexts, 'answer.value')).toEqual(['Ada', 'Ada'])
    expect(sync(contexts, 'answer.select(%context.linkId)')).toEqual(['name', 'name'])
    expect(sync(contexts, "'%context'")).toEqual(['%context'])
  })

  it('reads the resource scope of the response each context came from', () => {
    const comparison = { ...response, id: 'previous' }
    const current = sync(response, 'item', {}, typed)
    const previous = sync(comparison, 'item', {}, typed)
    expect(sync(previous, '%resource.id')).toEqual(['previous'])
    expect(sync(current, '%rootResource.id')).toEqual(['current'])
    // The environment still overrides it, as in fhirpath.js: a comparison pass must bind its own response.
    expect(sync(previous, '%resource.id', { resource: response })).toEqual(['current'])
    expect(() => sync([...current, ...previous], 'count()')).toThrow(/different owning resources/)
  })

  it('carries typed values through environment variables', () => {
    const items = sync(response, 'item', {}, typed)
    expect(sync({}, '%items.answer.value', { items })).toEqual(['Ada', 'Ada'])
    expect(sync({}, '%item.answer.value.ofType(FHIR.string)', { item: items[0] })).toEqual(['Ada', 'Ada'])
    // Plain JSON copies lose the choice type, as they do in fhirpath.js.
    expect(sync({}, '%items.answer.value', { items: structuredClone(items) })).toEqual([])
  })
})

describe('synchronous and Promise results', () => {
  const provider = (results: Record<string, boolean>): TerminologyProvider => ({
    validateVS: async (_valueSet, coded) => ({
      resourceType: 'Parameters',
      parameter: [{ name: 'result', valueBoolean: results[(coded as { code: string }).code] ?? false }],
    }),
  })
  const observation = { resourceType: 'Observation', code: { coding: [{ system: 'urn:test', code: 'a' }] } }

  it('returns an array for a local expression under async: true, and a Promise only when a service is needed', async () => {
    const calls: string[] = []
    const engine = smartFormsFhirpath(() => {
      calls.push('services')
      return { terminology: provider({ a: true }) }
    })
    const options = { async: true, terminologyUrl: 'https://tx.test/fhir' }
    const local = engine.evaluate(observation, 'code.coding.code', {}, undefined, options)
    expect(local).toEqual(['a'])
    expect(local).not.toBeInstanceOf(Promise)
    const remote = engine.evaluate(observation, "code.coding.memberOf('urn:vs')", {}, undefined, options)
    expect(remote).toBeInstanceOf(Promise)
    await expect(remote).resolves.toEqual([true])
    expect(calls).toEqual(['services'])
    await expect(engine.evaluate(observation, '1 + 1', {}, undefined, { async: 'always' })).resolves.toEqual([2])
  })

  it('refuses a service without async, as fhirpath.js does', () => {
    expect(() => sync(observation, "code.coding.memberOf('urn:vs')")).toThrow(/evaluateAsync/)
  })

  it('returns a Promise for resolve() when a resolver is configured, and resolves contained references locally', async () => {
    const resolver = vi.fn(async (reference: string) => ({
      resourceType: 'Patient',
      id: reference.split('/')[1],
      name: [{ given: ['Ada'] }],
    }))
    const engine = smartFormsFhirpath(() => ({ resolver }))
    const remote = { resourceType: 'Observation', subject: { reference: 'Patient/p' } }
    // The services decide; a call without fhirServerUrl still resolves through a configured resolver.
    const result = engine.evaluate(remote, 'subject.resolve().name.given', {}, undefined, { async: true })
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toEqual(['Ada'])
    expect(resolver).toHaveBeenCalledWith('Patient/p', undefined)
    const contained = {
      resourceType: 'Observation',
      subject: { reference: '#p' },
      contained: [{ resourceType: 'Patient', id: 'p', name: [{ given: ['Bo'] }] }],
    }
    await expect(
      engine.evaluate(contained, 'subject.resolve().name.given', {}, undefined, { async: true })
    ).resolves.toEqual(['Bo'])
    expect(resolver).toHaveBeenCalledTimes(1)
    // Without a resolver, resolve() stays synchronous and external references are empty.
    const local = smartFormsFhirpath(() => ({}))
    expect(local.evaluate(remote, 'subject.resolve().name.given', {}, undefined, { async: true })).toEqual([])
    // resolve() inside an instance selector is found too.
    await expect(
      engine.evaluate(remote, 'Coding { code: subject.resolve().id }.code', {}, undefined, { async: true })
    ).resolves.toEqual(['p'])
  })

  it('returns typed results from an asynchronous evaluation too', async () => {
    const engine = smartFormsFhirpath(() => ({ terminology: provider({ a: true }) }))
    const options = { ...typed, async: true, terminologyUrl: 'https://tx.test/fhir' }
    const codings = await engine.evaluate(observation, "code.coding.where(memberOf('urn:vs'))", {}, undefined, options)
    expect(engine.evaluate(codings, 'code')).toEqual(['a'])
  })
})

describe('Medplum services', () => {
  const scores = 'http://example.org/CodeSystem/scores'
  const ordinal = (valueDecimal: number) => [
    { url: 'http://hl7.org/fhir/StructureDefinition/ordinalValue', valueDecimal },
  ]
  const codeSystemBundle = {
    resourceType: 'Bundle',
    entry: [
      {
        resource: {
          resourceType: 'CodeSystem',
          url: scores,
          status: 'active',
          content: 'complete',
          concept: [{ code: 'often', extension: ordinal(3) }],
        },
      },
    ],
  }
  const patient = { resourceType: 'Patient', id: 'p', name: [{ given: ['Ada'] }] }
  const notFound = Object.assign(new Error('not found'), {
    outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] },
  })

  it('scores answers and resolves references through one authenticated client', async () => {
    const client: MedplumClientLike = {
      fhirUrl: (...path) => new URL(path.join('/'), 'https://api.medplum.test/fhir/R4/'),
      get: vi.fn(async (url: URL | string) =>
        String(url).endsWith('Patient/p')
          ? patient
          : String(url).includes('CodeSystem?url=')
            ? codeSystemBundle
            : Promise.reject(notFound)
      ),
      post: vi.fn(async (url: URL | string) =>
        String(url).endsWith('$lookup')
          ? { resourceType: 'Parameters', parameter: [{ name: 'display', valueString: 'Often' }] }
          : Promise.reject(notFound)
      ),
    }
    const engine = smartFormsFhirpath(medplumServices(client))
    const questionnaire = { resourceType: 'Questionnaire', item: [{ linkId: 'q', type: 'choice' }] }
    const qr = {
      resourceType: 'QuestionnaireResponse',
      subject: { reference: 'Patient/p' },
      item: [{ linkId: 'q', answer: [{ valueCoding: { system: scores, code: 'often' } }] }],
    }
    const options = { async: true, terminologyUrl: 'https://ignored.test' }
    await expect(
      engine.evaluate(qr, 'item.answer.value.weight()', { questionnaire }, undefined, options)
    ).resolves.toEqual([3])
    await expect(engine.evaluate(qr, 'subject.resolve().name.given', {}, undefined, options)).resolves.toEqual(['Ada'])
    expect(vi.mocked(client.get).mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.medplum.test/fhir/R4/CodeSystem?url=${encodeURIComponent(scores)}`,
      'https://api.medplum.test/fhir/R4/Patient/p',
    ])
  })
})

describe('fhirClient()', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts operations to the server and reports an OperationOutcome failure as such', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const body = String(url).endsWith('$validate-code')
        ? { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] }
        : { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }
      return new Response(JSON.stringify(body), {
        status: String(url).endsWith('$validate-code') ? 200 : 404,
        headers: { 'Content-Type': 'application/fhir+json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = fhirClient('https://tx.test/fhir/', { Authorization: 'Bearer token' })
    await expect(
      client.post(client.fhirUrl('ValueSet', '$validate-code'), { resourceType: 'Parameters' })
    ).resolves.toMatchObject({
      resourceType: 'Parameters',
    })
    await expect(client.get(client.fhirUrl('Patient', 'missing'))).rejects.toMatchObject({
      outcome: { resourceType: 'OperationOutcome' },
    })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://tx.test/fhir/ValueSet/$validate-code',
      'https://tx.test/fhir/Patient/missing',
    ])
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer token')
    await expect(client.get('https://tx.test.other.test/fhir/Patient/p')).rejects.toThrow(/outside the FHIR base/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The base is compared after URL normalization; a failure message leaves the query out.
    const upper = fhirClient('HTTPS://TX.test:443/fhir')
    await expect(upper.get('https://tx.test/fhir/Patient?identifier=urn:mrn|123')).rejects.toThrow(
      'FHIR request to /fhir/Patient failed: 404'
    )
  })
})

describe('template JSON addresses', () => {
  it('reads primitive metadata and choice properties while keeping source object identity', () => {
    const extension = { url: 'urn:test', valueString: 'expression' }
    const fhirData = {
      resourceType: 'Patient',
      name: [{ given: ['Ada', 'Ada'], _given: [null, { extension: [extension] }] }],
      deceasedBoolean: false,
    }
    expect(readTemplatePath({ fhirData, path: 'Patient.name[0]._given[1].extension' })[0]).toBe(extension)
    expect(readTemplatePath({ fhirData, path: 'Patient.name[0].given' })).toEqual(['Ada', 'Ada'])
    expect(readTemplatePath({ fhirData, path: 'Patient.deceasedBoolean' })).toEqual([false])
    expect(readTemplatePath({ fhirData, path: 'Patient.name[9]._given' })).toEqual([])
  })

  it('refuses expressions and mismatched roots instead of interpreting them as JSON addresses', () => {
    const fhirData = { resourceType: 'Patient' }
    expect(() => readTemplatePath({ fhirData, path: 'Patient.name.first()' })).toThrow(/JSON address/)
    expect(() => readTemplatePath({ fhirData, path: 'Observation.name' })).toThrow(/does not match/)
  })
})
