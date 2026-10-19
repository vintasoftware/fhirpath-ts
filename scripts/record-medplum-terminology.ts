/**
 * Records the Medplum terminology end-to-end cases (src/testing/medplum-terminology.ts)
 * into test-data/terminology/medplum.json, which src/terminology/medplum.test.ts
 * replays offline.
 *
 *   MEDPLUM_BASE_URL=https://api.medplum.com/ MEDPLUM_CLIENT_ID=... MEDPLUM_CLIENT_SECRET=... \
 *     pnpm record:tx:medplum
 *
 * Use a client of a project that holds only synthetic data. The script creates a
 * scored CodeSystem and a ConceptMap under example.org URLs, records, and deletes
 * them in all cases. Medplum deletes are soft deletes.
 *
 * Recording happens at the TerminologyProvider boundary: the file holds the
 * engine's (operation, arguments) and the FHIR answers, never HTTP traffic, so
 * tokens and headers cannot reach it. Answers lose their server bookkeeping
 * (`meta`, with project and author, and server-assigned resource ids), and the
 * file is refused if it still contains the client id, secret, access token,
 * project id, or server host.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CompiledExpression } from '../src/api/compile.ts'
import { r4Model } from '../src/r4/index.ts'
import type { TerminologyProvider } from '../src/terminology/provider.ts'
import {
  FREQUENCY_CONCEPT_MAP,
  FREQUENCY_MAP,
  MEDPLUM_CASES,
  MEDPLUM_CASSETTE,
  MEDPLUM_ENV,
  SCORED_CONCEPTS,
  SCORES_SYSTEM,
} from '../src/testing/medplum-terminology.ts'
import { type TxFixtureEntry, type TxFixtureFile, txProvider } from '../src/testing/tx-fixtures.ts'
import { unwrap } from '../src/values/typed-value.ts'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`Set ${name}`)
  return value
}

const server = new URL(required('MEDPLUM_BASE_URL'))
const clientId = required('MEDPLUM_CLIENT_ID')
const clientSecret = required('MEDPLUM_CLIENT_SECRET')
const fhirBase = new URL('fhir/R4/', server)

const tokenResponse = await fetch(new URL('oauth2/token', server), {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
})
if (!tokenResponse.ok) throw new Error(`Token request answered ${tokenResponse.status}`)
const accessToken = ((await tokenResponse.json()) as { access_token: string }).access_token
const projectId = ((await (await call('GET', new URL('auth/me', server))).json()) as { project?: { id?: string } })
  .project?.id

async function call(method: string, url: URL, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/fhir+json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
}

async function fhir(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await call(method, new URL(path, fhirBase), body)
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`)
  return response.json()
}

/**
 * A FHIR operation as the provider answers it. An unknown value set, code
 * system, or concept answers 4xx: that is `undefined`, an answer the service
 * cannot give. Authentication and server failures stop the recording.
 */
async function operation(path: string, parameter: object[]): Promise<unknown> {
  const response = await call('POST', new URL(path, fhirBase), { resourceType: 'Parameters', parameter })
  if (response.status === 401 || response.status === 403 || response.status >= 500) {
    throw new Error(`${path} answered ${response.status}`)
  }
  return response.ok ? withoutServerFields(await response.json()) : undefined
}

/** An answer without server bookkeeping: `meta` (project, author) and resource ids the server assigned. */
function withoutServerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutServerFields)
  if (typeof value !== 'object' || value === null) return value
  const isResource = 'resourceType' in value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      key === 'meta' || (isResource && key === 'id') ? [] : [[key, withoutServerFields(item)]]
    )
  )
}

const resourceParameter = (name: string, value: unknown) =>
  typeof value === 'string' ? { name: 'url', valueUri: value } : { name, resource: value }

function codedParameter(coded: unknown): object {
  if (typeof coded === 'string') return { name: 'code', valueCode: coded }
  return 'coding' in (coded as object)
    ? { name: 'codeableConcept', valueCodeableConcept: coded }
    : { name: 'coding', valueCoding: coded }
}

const codeOf = (coded: unknown) => (typeof coded === 'string' ? coded : (coded as { code?: string }).code)

/** The API's URL-encoded parameter string as Parameters entries. */
const extra = (params: string | undefined) =>
  [...new URLSearchParams(params ?? '')].map(([name, value]) =>
    name === 'property' ? { name, valueCode: value } : { name, valueString: value }
  )

const live: Required<TerminologyProvider> = {
  expand: (valueSet, params) =>
    operation('ValueSet/$expand', [resourceParameter('valueSet', valueSet), ...extra(params)]),
  lookup: (coded, params) => operation('CodeSystem/$lookup', [codedParameter(coded), ...extra(params)]),
  validateVS: (valueSet, coded, params) =>
    operation('ValueSet/$validate-code', [
      resourceParameter('valueSet', valueSet),
      codedParameter(coded),
      ...extra(params),
    ]),
  validateCS: (codeSystem, coded, params) =>
    operation('CodeSystem/$validate-code', [
      resourceParameter('codeSystem', codeSystem),
      codedParameter(coded),
      ...extra(params),
    ]),
  // Medplum takes codeA/codeB within `system`, and the API wants the outcome code.
  subsumes: async (system, coded1, coded2, params) => {
    const answer = (await operation('CodeSystem/$subsumes', [
      { name: 'system', valueUri: system },
      { name: 'codeA', valueCode: codeOf(coded1) },
      { name: 'codeB', valueCode: codeOf(coded2) },
      ...extra(params),
    ])) as { parameter?: { name: string; valueCode?: string }[] } | undefined
    return answer?.parameter?.find(parameter => parameter.name === 'outcome')?.valueCode
  },
  translate: (conceptMap, coded, params) =>
    operation('ConceptMap/$translate', [
      resourceParameter('conceptMap', conceptMap),
      codedParameter(coded),
      ...extra(params),
    ]),
}

/** Creates the synthetic resources, refusing to touch any that already exist. */
async function createFixtures(created: string[]): Promise<void> {
  for (const [type, url] of [
    ['CodeSystem', SCORES_SYSTEM],
    ['ConceptMap', FREQUENCY_MAP],
  ] as const) {
    const existing = (await fhir('GET', `${type}?url=${encodeURIComponent(url)}`)) as { entry?: unknown[] }
    if ((existing.entry?.length ?? 0) > 0) throw new Error(`${type} ${url} already exists; delete it and re-run`)
  }
  const codeSystem = (await fhir('POST', 'CodeSystem', {
    resourceType: 'CodeSystem',
    url: SCORES_SYSTEM,
    status: 'draft',
    content: 'complete',
    property: [{ code: 'itemWeight', type: 'decimal' }],
  })) as { id: string }
  created.push(`CodeSystem/${codeSystem.id}`)
  // Medplum's $lookup reads concept properties from the $import index.
  await fhir('POST', 'CodeSystem/$import', {
    resourceType: 'Parameters',
    parameter: [
      { name: 'system', valueUri: SCORES_SYSTEM },
      ...SCORED_CONCEPTS.map(({ code, display }) => ({ name: 'concept', valueCoding: { code, display } })),
      ...SCORED_CONCEPTS.flatMap(({ code, itemWeight }) =>
        itemWeight === undefined
          ? []
          : [
              {
                name: 'property',
                part: [
                  { name: 'code', valueCode: code },
                  { name: 'property', valueCode: 'itemWeight' },
                  { name: 'value', valueString: String(itemWeight) },
                ],
              },
            ]
      ),
    ],
  })
  const conceptMap = (await fhir('POST', 'ConceptMap', FREQUENCY_CONCEPT_MAP)) as { id: string }
  created.push(`ConceptMap/${conceptMap.id}`)
}

const entries: TxFixtureEntry[] = []
const terminology = txProvider(async (operationName, args) => {
  const impl = live[operationName as keyof TerminologyProvider] as (...callArgs: unknown[]) => Promise<unknown>
  const response = await impl(...args)
  if (!entries.some(e => e.operation === operationName && JSON.stringify(e.args) === JSON.stringify(args))) {
    entries.push({ operation: operationName, args, response })
  }
  return response
})

const created: string[] = []
let failures = 0
try {
  await createFixtures(created)
  for (const testCase of MEDPLUM_CASES) {
    let actual: unknown
    try {
      const values = await new CompiledExpression(testCase.expression).evaluateTypedAsync(testCase.input ?? {}, {
        model: r4Model,
        terminology,
        env: MEDPLUM_ENV,
      })
      actual = values.map(unwrap)
    } catch (error) {
      actual = { error: (error as Error).message }
    }
    const expected = testCase.expected
    const ok =
      'error' in expected
        ? typeof actual === 'object' &&
          actual !== null &&
          String((actual as { error?: unknown }).error).includes(expected.error)
        : JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${testCase.name}: ${JSON.stringify(actual)}`)
  }
} finally {
  for (const reference of created) {
    const response = await call('DELETE', new URL(reference, fhirBase))
    console.log(`deleted ${reference.split('/')[0]}: ${response.status}`)
  }
}
if (failures > 0) throw new Error(`${failures} case(s) did not match; nothing written`)

const file: TxFixtureFile = { server: 'Medplum', recordedAt: new Date().toISOString().slice(0, 10), entries }
const text = `${JSON.stringify(file, null, 2)}\n`
const secrets = { clientId, clientSecret, accessToken, projectId, host: server.host }
for (const [name, value] of Object.entries(secrets)) {
  if (value !== undefined && value !== '' && text.includes(value))
    throw new Error(`The recording contains the ${name}; nothing written`)
}
writeFileSync(resolve(import.meta.dirname, '../test-data', MEDPLUM_CASSETTE), text)
console.log(`Wrote ${entries.length} entries to test-data/${MEDPLUM_CASSETTE}`)
