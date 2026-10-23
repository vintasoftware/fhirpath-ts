import { type ReferenceResolver, serverBase } from '../fhir/reference-resolver.ts'
import { codeSystemWeight } from '../fhir/weights.ts'
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

interface SearchBundle {
  entry?: { resource?: unknown }[]
  link?: { relation?: unknown; url?: string }[]
}

interface Parameters {
  resourceType?: unknown
  parameter?: Parameter[]
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

/**
 * A Coding's version as the operation's `version` parameter. Medplum's
 * CodeSystem `$lookup` and `$validate-code` select the code system version
 * from that parameter only, so a version left in the Coding would be ignored.
 */
function versionParameter(coded: unknown, params: string | undefined): Parameter[] {
  const version = typeof coded === 'object' && coded !== null ? (coded as Coding).version : undefined
  if (typeof version !== 'string' || new URLSearchParams(params ?? '').has('version')) return []
  return [{ name: 'version', valueString: version }]
}

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
 * When the answer has no `itemWeight` property, the provider reads every
 * version of the CodeSystem resource, across all search pages, and reports the concept's weight as that
 * property, by the rules `weight()` applies to contained CodeSystems: the
 * Coding's version, or else the version `$lookup` answered with, selects the
 * resource, and versions that disagree on an unversioned Coding fail the
 * lookup. Whether the concept exists is `$lookup`'s answer, since a resource
 * whose concepts were imported lists none: a concept it finds without a
 * weight in either place is a confirmed absence, which `weight()` reads as
 * empty; a CodeSystem or concept the server does not have is `undefined`,
 * which `weight()` reports as an error. The engine asks the
 * provider only after the contained CodeSystems of the input and the
 * Questionnaire, so local scores never reach the network.
 *
 * `lookup` and `validateCS` send a Coding's version as `version`, the
 * parameter Medplum reads it from. `subsumes` sends `system`, `codeA`, and `codeB`, the only form Medplum's
 * `$subsumes` accepts, with the Codings' version as `version`. Codings that name
 * two different versions fail the call rather than compare across versions.
 */
export function medplumTerminology(client: MedplumClientLike): TerminologyProvider {
  const codeSystems = new Map<string, Promise<unknown[]>>()

  const operation = (type: string, name: string, parameter: Parameter[]): Promise<unknown> =>
    answerOf(client.post(client.fhirUrl(type, name), { resourceType: 'Parameters', parameter }, FHIR_JSON))

  /**
   * Every resource a search finds, following its `next` pages on the client's
   * server. A search with no match answers an empty Bundle, so any failed page
   * fails the whole search rather than leaving it incomplete.
   */
  async function searchAll(url: URL): Promise<unknown[]> {
    const own = client.fhirUrl().href
    const resources: unknown[] = []
    for (let next: string | undefined = url.href; next !== undefined;) {
      if (!next.startsWith(own)) throw new Error(`the search page ${new URL(next).pathname} is outside the FHIR base`)
      const page = (await client.get(next)) as SearchBundle | undefined
      resources.push(...(page?.entry ?? []).map(entry => entry.resource))
      next = page?.link?.find(link => link.relation === 'next')?.url
    }
    return resources
  }

  /** Every version of the CodeSystem resource for a system, read once per provider; a failed read is retried. */
  function codeSystemVersions(system: string): Promise<unknown[]> {
    let pending = codeSystems.get(system)
    if (pending === undefined) {
      const url = client.fhirUrl('CodeSystem')
      url.searchParams.set('url', system)
      pending = searchAll(url)
      codeSystems.set(system, pending)
      pending.catch(() => codeSystems.delete(system))
    }
    return pending
  }

  /** The `$lookup` answer with the weight an R4 CodeSystem resource carries as a concept extension. */
  async function withResourceWeight(coding: Coding, answer: Parameters | undefined): Promise<unknown> {
    if (typeof coding.system !== 'string' || typeof coding.code !== 'string') return answer
    const version =
      coding.version ?? answer?.parameter?.find(parameter => parameter.name === 'version')?.['valueString']
    const found = codeSystemWeight(await codeSystemVersions(coding.system), {
      system: coding.system,
      code: coding.code,
      version,
    })
    if (!found.listed) return answer
    const base: Parameters = answer ?? {
      resourceType: 'Parameters',
      parameter: [{ name: 'name', valueString: coding.system }],
    }
    if (found.weight === undefined) return base
    return {
      ...base,
      parameter: [
        ...(base.parameter ?? []),
        {
          name: 'property',
          part: [
            { name: 'code', valueCode: 'itemWeight' },
            { name: 'value', valueDecimal: found.weight.toNumber() },
          ],
        },
      ],
    }
  }

  return {
    expand: (valueSet, params) =>
      operation('ValueSet', '$expand', [resourceParameter('valueSet', valueSet), ...extra(params)]),
    lookup: async (coded, params) => {
      const answer = await operation('CodeSystem', '$lookup', [
        codedParameter(coded),
        ...versionParameter(coded, params),
        ...extra(params),
      ])
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
        ...versionParameter(coded, params),
        ...extra(params),
      ]),
    subsumes: async (system, coded1, coded2, params) => {
      const [codeA, codeB] = [coded1, coded2].map(coded =>
        typeof coded === 'string' ? { code: coded } : (coded as Coding)
      )
      const versions = new Set([codeA?.version, codeB?.version].filter(version => version !== undefined))
      if (versions.size > 1) {
        throw new Error(
          `Medplum's $subsumes compares codes of one version of ${system}, not ${[...versions].join(' and ')}`
        )
      }
      const answer = (await operation('CodeSystem', '$subsumes', [
        { name: 'system', valueUri: system },
        ...[...versions].map(version => ({ name: 'version', valueString: version })),
        { name: 'codeA', valueCode: codeA?.code },
        { name: 'codeB', valueCode: codeB?.code },
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
 * `base` when the resource holding it names one. Anything but a literal
 * `Type/id` or `Type/id/_history/vid` read on the client's FHIR base resolves
 * to nothing: the client sends its credentials with every request, and the
 * reference comes from the data. A resource the server does not have also
 * resolves to nothing.
 */
export function medplumResolver(client: MedplumClientLike): ReferenceResolver {
  const own = client.fhirUrl().href.replace(/\/$/, '')
  return (reference, base) => {
    if (reference.startsWith('urn:')) return Promise.resolve(undefined)
    const url = new URL(reference, `${(base ?? own).replace(/\/$/, '')}/`).href
    // Only a literal `Type/id[/_history/vid]` read on the client's own base.
    return serverBase(url) === own ? answerOf(client.get(url)) : Promise.resolve(undefined)
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
  const base = new URL(`${baseUrl.replace(/\/$/, '')}/`).href
  async function request(url: URL | string, init: RequestInit): Promise<unknown> {
    const target = new URL(url)
    // The headers may carry credentials, so they go to this server only.
    if (!target.href.startsWith(base))
      throw new Error(`${target.origin}${target.pathname} is outside the FHIR base ${base}`)
    const response = await fetch(target, {
      ...init,
      headers: { Accept: FHIR_JSON, ...headers, ...(init.headers as Record<string, string> | undefined) },
    })
    const body: unknown = response.headers.get('Content-Type')?.includes('json') ? await response.json() : undefined
    if (response.ok) return body
    const outcome =
      (body as { resourceType?: unknown } | undefined)?.resourceType === 'OperationOutcome' ? body : undefined
    // The path names the operation or resource; the query, which may carry search values, stays out.
    throw Object.assign(new Error(`FHIR request to ${target.pathname} failed: ${response.status}`), { outcome })
  }
  return {
    fhirUrl: (...path) => new URL(path.join('/'), base),
    get: url => request(url, { method: 'GET' }),
    post: (url, body, contentType = FHIR_JSON) =>
      request(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body) }),
  }
}
