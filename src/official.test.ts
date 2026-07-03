import { describe, expect, it } from 'vitest'
import { SKIP_MANIFEST } from '../test-data/official/skip-manifest'
import {
  findSkipReason,
  loadOfficialSuite,
  runOfficialTest,
  type SuiteName,
  skipEntryMatchesSomething,
} from './testing/official-harness'

const suites: Record<SuiteName, ReturnType<typeof loadOfficialSuite>> = {
  r4: loadOfficialSuite('r4'),
  r5: loadOfficialSuite('r5'),
}

for (const suite of ['r4', 'r5'] as const) {
  describe(`official ${suite} suite`, () => {
    for (const group of suites[suite]) {
      describe(group.name, () => {
        group.tests.forEach((test, index) => {
          const title = `${test.name ?? `case-${index}`}: ${test.expression.slice(0, 100)}`
          const skipReason = findSkipReason(suite, group, test)
          if (skipReason !== undefined) {
            it.skip(`${title} [${skipReason}]`, () => {})
            return
          }
          it(title, () => {
            const failure = runOfficialTest(suite, test)
            expect(failure, failure).toBeUndefined()
          })
        })
      })
    }
  })
}

describe('skip manifest hygiene', () => {
  it('every skip entry matches at least one case', () => {
    for (const entry of SKIP_MANIFEST) {
      expect(skipEntryMatchesSomething(entry, suites), entry.reason).toBe(true)
    }
  })
})
