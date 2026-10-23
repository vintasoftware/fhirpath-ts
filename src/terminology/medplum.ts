import type { ReferenceResolver } from '../fhir/reference-resolver.ts'
import type { TerminologyProvider } from './provider.ts'

/**
 * The part of Medplum's `MedplumClient` these providers use. Any authenticated
 * client satisfies it, and so does a test double. The providers go through
 * the client's FHIR operations only, so Medplum's transport, headers, and
 * token refresh stay with the client.
 */
export interface MedplumClientLike {
  /** `fhirUrl('CodeSystem', '$lookup')` is the FHIR URL of that operation on the client's server. */
  fhirUrl(...path: string[]): URL
  get(url: URL | string): Promise<unknown>
  post(url: URL | string, body?: unknown, contentType?: string): Promise<unknown>
}

/** A `MedplumClient` failure carries the server's OperationOutcome; this is what the providers read of it. */
interface OutcomeError {
  outcome?: { resourceType?: unknown; issue?: { code?: unknown }[] }
}

/** The OperationOutcome codes Medplum answers an unknown value set, code system, or concept with. */
const CANNOT_ANSWER = new Set(['not-found', 'invalid'])

const FHIR_JSON = 'application/fhir+json'

/** The weight extensions an R4 CodeSystem concept may carry, in FHIR's and SDC's spellings. */
const WEIGHT_EXTENSION_URLS = new Set([
  'http://hl7.org/fhir/StructureDefinition/ordinalValue',
  'http://hl7.org/fhir/StructureDefinition/itemWeight',
])

interface Coding {
  system?: unknown
  version?: unknown
  code?: unknown
}

interface Parameter {
  name?: unknown
  part?: Parameter[]
  [valueX: string]: unknown
}

interface Parameters {
  resourceType?: unknown
  parameter?: Parameter[]
}

interface Concept {
  code?: unknown
  display?: unknown
  extension?: { url?: unknown; valueDecimal?: unknown }[]
  concept?: Concept[]
}

interface CodeSystem {
  resourceType?: unknown
  url?: unknown
  version?: unknown
  content?: unknown
  concept?: Concept[]
}

/**
 * True for the failure Medplum's client raises when the server cannot answer
 * an operation: an unknown value set (400, `invalid`), or an unknown code
 * system or concept (404, `not-found`). Any other failure, such as an expired
 * session or rate limiting, stays an error, so it cannot read as "no weight"
 * or "not a member".
 */
function cannotAnswer(error: unknown): boolean {
  const outcome = (error as OutcomeError | null)?.outcome
  if (outcome?.resourceType !== 'OperationOutcome' || !Array.isArray(outcome.issue) || outcome.issue.length === 0) {
    return false
  }
  return outcome.issue.every(issue => typeof issue.code === 'string' && CANNOT_ANSWER.has(issue.code))
}

/** The server's answer, or undefined for an operation it cannot answer. */
async function answerOf<T>(request: Promise<unknown>): Promise<T | undefined> {
  try {
    return (await request) as T
  } catch (error) {
    if (cannotAnswer(error)) return undefined
    throw error
  }
}

const resourceParameter = (name: string, value: unknown): Parameter =>
  typeof value === 'string' ? { name: 'url', valueUri: value } : { name, resource: value }

function codedParameter(coded: unknown): Parameter {
  if (typeof coded === 'string') return { name: 'code', valueCode: coded }
  return 'coding' in (coded as object)
    ? { name: 'codeableConcept', valueCodeableConcept: coded }
    : { name: 'coding', valueCoding: coded }
}

const codeOf = (coded: unknown): unknown => (typeof coded === 'string' ? coded : (coded as Coding).code)

/** The API's URL-encoded parameter string as Parameters entries. */
const extra = (params: string | undefined): Parameter[] =>
  [...new URLSearchParams(params ?? '')].map(([name, value]) =>
    name === 'property' ? { name, valueCode: value } : { name, valueString: value }
  )

function hasProperty(answer: Parameters | undefined, code: string): boolean {
  return (answer?.parameter ?? []).some(
    parameter =>
      parameter.name === 'property' &&
      (parameter.part ?? []).some(part => part.name === 'code' && part['valueCode'] === code)
  )
}

function* concepts(list: Concept[] | undefined): Generator<Concept> {
  for (const concept of list ?? []) {
    yield concept
    yield* concepts(concept.concept)
  }
}

function extensionWeight(concept: Concept): unknown {
  return concept.extension?.find(extension => WEIGHT_EXTENSION_URLS.has(String(extension.url)))?.valueDecimal
}

/**
 * A `TerminologyProvider` over Medplum's terminology operations: `ValueSet/$expand`,
 * `CodeSystem/$lookup`, `ValueSet/$validate-code`, `CodeSystem/$validate-code`,
 * `CodeSystem/$subsumes`, and `ConceptMap/$translate`, each posted as a
 * Parameters resource. `subsumes` passes codes within the system and returns
 * the outcome code, as the API wants.
 *
 * `lookup` with `property=itemWeight` also reads R4 scores. Medplum's `$lookup`
 * reports concept properties, which `CodeSystem/$import` loads, and not the
 * `ordinalValue` extensions an R4 CodeSystem resource carries on its concepts.
 * When the answer has no `itemWeight` property, the provider reads the
 * CodeSystem resource with the coding's system and version and reports the
 * concept's weight extension as that property. A concept found without one is
 * a confirmed absence, which `weight()` reads as empty; a CodeSystem or concept
 * the server does not have is `undefined`, which `weight()` reports as an
 * error. The engine asks the provider only after the contained CodeSystems of
 * the input and the Questionnaire, so local scores never reach the network.
 */
export function medplumTerminology(client: MedplumClientLike): TerminologyProvider {
  const codeSystems = new Map<string, Promise<CodeSystem | undefined>>()

  const operation = (type: string, name: string, parameter: Parameter[]): Promise<unknown> =>
    answerOf(client.post(client.fhirUrl(type, name), { resourceType: 'Parameters', parameter }, FHIR_JSON))

  /** The CodeSystem resource for a system and version, read once per provider. */
  function codeSystem(system: string, version: unknown): Promise<CodeSystem | undefined> {
    const key = JSON.stringify([system, version])
    let pending = codeSystems.get(key)
    if (pending === undefined) {
      const url = client.fhirUrl('CodeSystem')
      url.searchParams.set('url', system)
      if (typeof version === 'string') url.searchParams.set('version', version)
      pending = answerOf<{ entry?: { resource?: CodeSystem }[] }>(client.get(url)).then(
        bundle => bundle?.entry?.find(entry => entry.resource?.resourceType === 'CodeSystem')?.resource
      )
      codeSystems.set(key, pending)
    }
    return pending
  }

  /** The `$lookup` answer with the weight an R4 CodeSystem resource carries as a concept extension. */
  async function withResourceWeight(coding: Coding, answer: Parameters | undefined): Promise<unknown> {
    if (typeof coding.system !== 'string' || typeof coding.code !== 'string') return answer
    const resource = await codeSystem(coding.system, coding.version)
    const concept = [...concepts(resource?.concept)].find(candidate => candidate.code === coding.code)
    if (concept === undefined) return answer
    const found: Parameters = answer ?? {
      resourceType: 'Parameters',
      parameter: [
        { name: 'name', valueString: coding.system },
        ...(typeof concept.display === 'string' ? [{ name: 'display', valueString: concept.display }] : []),
      ],
    }
    const weight = extensionWeight(concept)
    if (typeof weight !== 'number') return found
    return {
      ...found,
      parameter: [
        ...(found.parameter ?? []),
        {
          name: 'property',
          part: [
            { name: 'code', valueCode: 'itemWeight' },
            { name: 'value', valueDecimal: weight },
          ],
        },
      ],
    }
  }

  return {
    expand: (valueSet, params) =>
      operation('ValueSet', '$expand', [resourceParameter('valueSet', valueSet), ...extra(params)]),
    lookup: async (coded, params) => {
      const answer = await operation('CodeSystem', '$lookup', [codedParameter(coded), ...extra(params)])
      const wantsWeight = new URLSearchParams(params ?? '').getAll('property').includes('itemWeight')
      if (!wantsWeight || typeof coded === 'string' || hasProperty(answer as Parameters | undefined, 'itemWeight')) {
        return answer
      }
      return withResourceWeight(coded as Coding, answer as Parameters | undefined)
    },
    validateVS: (valueSet, coded, params) =>
      operation('ValueSet', '$validate-code', [
        resourceParameter('valueSet', valueSet),
        codedParameter(coded),
        ...extra(params),
      ]),
    validateCS: (codeSystem, coded, params) =>
      operation('CodeSystem', '$validate-code', [
        resourceParameter('codeSystem', codeSystem),
        codedParameter(coded),
        ...extra(params),
      ]),
    subsumes: async (system, coded1, coded2, params) => {
      const answer = (await operation('CodeSystem', '$subsumes', [
        { name: 'system', valueUri: system },
        { name: 'codeA', valueCode: codeOf(coded1) },
        { name: 'codeB', valueCode: codeOf(coded2) },
        ...extra(params),
      ])) as Parameters | undefined
      return answer?.parameter?.find(parameter => parameter.name === 'outcome')?.['valueCode']
    },
    translate: (conceptMap, coded, params) =>
      operation('ConceptMap', '$translate', [
        resourceParameter('conceptMap', conceptMap),
        codedParameter(coded),
        ...extra(params),
      ]),
  }
}

/**
 * A `ReferenceResolver` that reads resources from the client's server only. A
 * relative `Type/id` reference is read from the client's FHIR base, or from
 * `base` when the resource holding it names one. A reference that lands
 * outside the client's FHIR base resolves to nothing: the client sends its
 * credentials with every request, and the reference comes from the data. A
 * resource the server does not have also resolves to nothing.
 */
export function medplumResolver(client: MedplumClientLike): ReferenceResolver {
  const own = client.fhirUrl().href.replace(/\/?$/, '/')
  return (reference, base) => {
    if (reference.startsWith('urn:')) return Promise.resolve(undefined)
    const url = new URL(reference, base === undefined ? own : `${base.replace(/\/$/, '')}/`).href
    return url.startsWith(own) ? answerOf(client.get(url)) : Promise.resolve(undefined)
  }
}

/**
 * A `MedplumClientLike` over plain `fetch`, for a FHIR server reached without
 * a Medplum session: a terminology server, or Medplum itself with a bearer
 * token in `headers`. A failure whose body is an OperationOutcome is thrown
 * with it, as Medplum's client throws, so the providers read an unknown value
 * set, code system, or concept as an answer the server cannot give.
 */
export function fhirClient(baseUrl: string, headers: Record<string, string> = {}): MedplumClientLike {
  const base = `${baseUrl.replace(/\/$/, '')}/`
  async function request(url: URL | string, init: RequestInit): Promise<unknown> {
    // The headers may carry credentials, so they go to this server only.
    if (!String(url).startsWith(base)) throw new Error(`${String(url)} is outside the FHIR base ${base}`)
    const response = await fetch(url, {
      ...init,
      headers: { Accept: FHIR_JSON, ...headers, ...(init.headers as Record<string, string> | undefined) },
    })
    const body: unknown = response.headers.get('Content-Type')?.includes('json') ? await response.json() : undefined
    if (response.ok) return body
    const outcome =
      (body as { resourceType?: unknown } | undefined)?.resourceType === 'OperationOutcome' ? body : undefined
    throw Object.assign(new Error(`FHIR request to ${String(url)} failed: ${response.status}`), { outcome })
  }
  return {
    fhirUrl: (...path) => new URL(path.join('/'), base),
    get: url => request(url, { method: 'GET' }),
    post: (url, body, contentType = FHIR_JSON) =>
      request(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body) }),
  }
}
