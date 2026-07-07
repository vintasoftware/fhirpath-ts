import { readFileSync } from 'node:fs'
import type { TerminologyProvider } from '../terminology/provider.ts'
import { testDataPath } from './test-data.ts'

/**
 * Recorded tx.fhir.org responses backing the official suite's tx-mode tests.
 * The file is committed so the suite stays hermetic — no network in tests;
 * `pnpm record:tx` (scripts/record-tx-fixtures.ts) re-records it against the
 * live server.
 */
export interface TxFixtureFile {
  server: string
  recordedAt: string
  entries: TxFixtureEntry[]
}

export interface TxFixtureEntry {
  operation: string
  args: unknown[]
  response: unknown
}

const TX_OPERATIONS = ['expand', 'lookup', 'validateVS', 'validateCS', 'subsumes', 'translate'] as const

/**
 * A TerminologyProvider whose methods all funnel into `handle(operation, args)`
 * with the argument list exactly as the engine passed it. Recorder and replayer
 * are both built from this factory, so the fixture lookup key — operation plus
 * JSON-rendered args — is derived in one place and cannot drift between them.
 */
export function txProvider(handle: (operation: string, args: unknown[]) => Promise<unknown>): TerminologyProvider {
  return Object.fromEntries(
    TX_OPERATIONS.map(operation => [operation, (...args: unknown[]) => handle(operation, args)])
  ) as TerminologyProvider
}

let cached: TxFixtureFile | undefined

function fixtureFile(): TxFixtureFile {
  cached ??= JSON.parse(readFileSync(testDataPath('official/r5/tx-fixtures.json'), 'utf8')) as TxFixtureFile
  return cached
}

async function respond(operation: string, args: unknown[]): Promise<unknown> {
  const key = JSON.stringify(args)
  const entry = fixtureFile().entries.find(e => e.operation === operation && JSON.stringify(e.args) === key)
  if (!entry) {
    throw new Error(`No recorded tx.fhir.org response for ${operation}(${key.slice(1, -1)}); run: pnpm record:tx`)
  }
  return entry.response
}

/** Replays the recorded tx.fhir.org responses as a TerminologyProvider. */
export const recordedTerminology: TerminologyProvider = txProvider(respond)
