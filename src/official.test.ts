import { describe, expect, it } from 'vitest'

import { PHASE_OVERRIDES, SKIP_MANIFEST } from '../test-data/official/skip-manifest.ts'
import {
  casesMatching,
  findSkipReason,
  loadOfficialSuite,
  runOfficialTest,
  type SuiteName,
} from './testing/official-harness.ts'

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
            const failure = runOfficialTest(suite, test, group.name)
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
      expect(casesMatching(entry, suites).length, entry.reason).toBeGreaterThan(0)
    }
  })

  it('every phase override matches an invalid case', () => {
    for (const entry of PHASE_OVERRIDES) {
      const matches = casesMatching(entry, suites).filter(({ test }) => test.invalid !== undefined)
      expect(matches.length, `${entry.suite}/${entry.group}/${entry.test}: ${entry.reason}`).toBeGreaterThan(0)
    }
  })
})
