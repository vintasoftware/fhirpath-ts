import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resolve a file under this package's `test-data/` directory. Resolved from cwd so it
 * works whether vitest runs in the package dir or from the repo root (same pattern as
 * packages/ui theme tests).
 */
export function testDataPath(relative: string): string {
  const candidates = [
    resolve(process.cwd(), 'test-data', relative),
    resolve(process.cwd(), 'packages/fhirpath/test-data', relative),
  ]
  const found = candidates.find(existsSync)
  if (!found) {
    throw new Error(`test-data/${relative} not found from cwd ${process.cwd()}`)
  }
  return found
}
