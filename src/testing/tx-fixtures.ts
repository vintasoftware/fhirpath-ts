import { readFileSync } from 'node:fs'
import type { TerminologyProvider } from '../terminology/provider.ts'
import { testDataPath } from './test-data.ts'

/**
 * Recorded tx.fhir.org responses backing the official suite's tx-mode tests.
 * The file is committed so the suite stays hermetic — no network in tests;
 * `pnpm record:tx` (scripts/record-tx-fixtures.ts) re-records it against the
 * live server. Entries are keyed by the exact TerminologyProvider call
 * (operation + JSON-rendered arguments), so the replaying provider below is a
 * faithful stand-in for the server the suite was authored against.
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
export const recordedTerminology: TerminologyProvider = {
  expand: (valueSet, params) => respond('expand', [valueSet, params ?? null]),
  lookup: (coded, params) => respond('lookup', [coded, params ?? null]),
  validateVS: (valueSet, coded, params) => respond('validateVS', [valueSet, coded, params ?? null]),
  validateCS: (codeSystem, coded, params) => respond('validateCS', [codeSystem, coded, params ?? null]),
  subsumes: (system, coded1, coded2, params) => respond('subsumes', [system, coded1, coded2, params ?? null]),
  translate: (conceptMap, coded, params) => respond('translate', [conceptMap, coded, params ?? null]),
}
