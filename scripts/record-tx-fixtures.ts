/**
 * Records tx.fhir.org responses for the official suite's tx-mode tests into
 * test-data/official/r5/tx-fixtures.json, so the vitest suite replays them
 * offline (src/testing/tx-fixtures.ts). Re-run to refresh against the live
 * server: node scripts/record-tx-fixtures.ts
 *
 * The requests are not hand-listed: the script runs every tx-mode test from
 * the vendored suite through evaluateTypedAsync() with a recording txProvider()
 * wrapper around a live REST provider, so the recorded (operation, args) keys
 * are exactly what the engine asks for and new tx tests are picked up
 * automatically.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CompiledExpression } from '../src/api/compile.ts'
import { valueToString } from '../src/functions/conversion.ts'
import { r4Model } from '../src/r4/index.ts'
import type { TerminologyProvider } from '../src/terminology/provider.ts'
import { type TxFixtureEntry, type TxFixtureFile, txProvider } from '../src/testing/tx-fixtures.ts'

const SERVER = process.env.TX_SERVER ?? 'https://tx.fhir.org/r5'
const DATA_DIR = resolve(import.meta.dirname, '../test-data/official/r5')

async function get(path: string, query: Record<string, string>): Promise<unknown> {
  const url = new URL(`${SERVER}/${path}`)
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value)
  }
  const response = await fetch(url, { headers: { Accept: 'application/fhir+json' } })
  const body: unknown = await response.json()
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${what} must be a canonical url string for recording, got ${JSON.stringify(value)}`)
  }
  return value
}

/** query-string params for a coded value: a bare code string, a Coding, or a CodeableConcept with one coding. */
function codedParams(coded: unknown): { code: string; system?: string; inferSystem?: string } {
  if (typeof coded === 'string') {
    // A bare FHIR `code` has no system of its own; the server infers it from the value set.
    return { code: coded, inferSystem: 'true' }
  }
  const value = coded as { system?: unknown; code?: unknown; coding?: unknown } | null
  const coding = Array.isArray(value?.coding) ? (value.coding[0] as { system?: unknown; code?: unknown }) : value
  if (typeof coding?.system === 'string' && typeof coding.code === 'string') {
    return { system: coding.system, code: coding.code }
  }
  throw new Error(`cannot derive system+code from ${JSON.stringify(coded)}`)
}

/**
 * The system behind a bare code being translated: $translate requires one, so
 * resolve it against the ConceptMap's source scope value set via $validate-code.
 */
async function inferSystem(conceptMap: string, code: string): Promise<string> {
  const resource = (await get(`ConceptMap/${conceptMap.split('/').pop()}`, {})) as { sourceScopeCanonical?: unknown }
  const scope = resource.sourceScopeCanonical
  if (typeof scope !== 'string') {
    throw new Error(`ConceptMap ${conceptMap} has no sourceScopeCanonical to infer a system from`)
  }
  const outcome = (await get('ValueSet/$validate-code', { url: scope, code, inferSystem: 'true' })) as {
    parameter?: { name?: unknown; valueUri?: unknown }[]
  }
  const system = outcome.parameter?.find(p => p.name === 'system')?.valueUri
  if (typeof system !== 'string') {
    throw new Error(`could not infer the system of code '${code}' from ${scope}`)
  }
  return system
}

/** Maps each TerminologyProvider operation onto the server's REST API. */
const live: Required<TerminologyProvider> = {
  expand: (valueSet, extra) => get('ValueSet/$expand', { url: asString(valueSet, 'valueSet'), ...params(extra) }),
  lookup: (coded, extra) => get('CodeSystem/$lookup', { ...codedParams(coded), ...params(extra) }),
  validateVS: (valueSet, coded, extra) =>
    get('ValueSet/$validate-code', { url: asString(valueSet, 'valueSet'), ...codedParams(coded), ...params(extra) }),
  validateCS: (codeSystem, coded, extra) =>
    get('CodeSystem/$validate-code', {
      url: asString(codeSystem, 'codeSystem'),
      ...codedParams(coded),
      ...params(extra),
    }),
  subsumes: (system, coded1, coded2, extra) =>
    get('CodeSystem/$subsumes', {
      system,
      codeA: codedParams(coded1).code,
      codeB: codedParams(coded2).code,
      ...params(extra),
    }),
  translate: async (conceptMap, coded, extra) => {
    const url = asString(conceptMap, 'conceptMap')
    const source =
      typeof coded === 'string' ? { system: await inferSystem(url, coded), code: coded } : codedParams(coded)
    return get('ConceptMap/$translate', { url, sourceCode: source.code, system: source.system ?? '', ...params(extra) })
  },
}

function params(extra?: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(extra ?? ''))
}

interface SuiteTest {
  name: string
  expression: string
  inputfile?: string
  mode?: string
}

const groups = JSON.parse(readFileSync(resolve(DATA_DIR, 'tests.json'), 'utf8')) as { tests: SuiteTest[] }[]
const txTests = groups.flatMap(group => group.tests.filter(test => test.mode === 'tx'))
console.log(`Recording ${txTests.length} tx-mode tests against ${SERVER}`)

const entries: TxFixtureEntry[] = []
const terminology = txProvider(async (operation, args) => {
  const impl = live[operation as keyof TerminologyProvider] as (...callArgs: unknown[]) => Promise<unknown>
  const response = await impl(...args)
  entries.push({ operation, args, response })
  console.log(`  recorded ${operation}(${JSON.stringify(args).slice(1, -1)})`)
  return response
})

for (const test of txTests) {
  console.log(`${test.name}: ${test.expression}`)
  if (test.inputfile === undefined) {
    throw new Error(`tx test ${test.name} has no inputfile`)
  }
  const inputFile = test.inputfile.replace(/\.xml$/, '.json')
  const input: unknown = JSON.parse(readFileSync(resolve(DATA_DIR, 'fixtures', inputFile), 'utf8'))
  const results = await new CompiledExpression(test.expression).evaluateTypedAsync(input, {
    model: r4Model,
    terminology,
  })
  console.log(`  -> ${JSON.stringify(results.map(item => valueToString(item) ?? item.value))}`)
}

const file: TxFixtureFile = { server: SERVER, recordedAt: new Date().toISOString().slice(0, 10), entries }
writeFileSync(resolve(DATA_DIR, 'tx-fixtures.json'), `${JSON.stringify(file, null, 2)}\n`)
console.log(`Wrote ${entries.length} entries to test-data/official/r5/tx-fixtures.json`)
