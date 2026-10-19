import { readFileSync } from 'node:fs'

import type { TerminologyProvider } from '../terminology/provider.ts'
import { testDataPath } from './test-data.ts'

/**
 * Recorded terminology-service responses: tx.fhir.org for the official suite's
 * tx-mode tests (`pnpm record:tx`, scripts/record-tx-fixtures.ts) and Medplum
 * for the provider end-to-end cases (`pnpm record:tx:medplum`,
 * scripts/record-medplum-terminology.ts). The files are committed so the suite
 * stays hermetic — no network in tests.
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

/**
 * Replays a recorded fixture file (under `test-data/`) as a TerminologyProvider.
 * A request the file does not hold fails with the command that re-records it.
 */
export function replayedTerminology(file: string, recordCommand: string): TerminologyProvider {
  let cached: TxFixtureFile | undefined
  return txProvider(async (operation, args) => {
    cached ??= JSON.parse(readFileSync(testDataPath(file), 'utf8')) as TxFixtureFile
    const key = JSON.stringify(args)
    const entry = cached.entries.find(e => e.operation === operation && JSON.stringify(e.args) === key)
    if (!entry) {
      throw new Error(
        `No recorded ${cached.server} response for ${operation}(${key.slice(1, -1)}); run: ${recordCommand}`
      )
    }
    return entry.response
  })
}

/** Replays the recorded tx.fhir.org responses as a TerminologyProvider. */
export const recordedTerminology: TerminologyProvider = replayedTerminology(
  'official/r5/tx-fixtures.json',
  'pnpm record:tx'
)
