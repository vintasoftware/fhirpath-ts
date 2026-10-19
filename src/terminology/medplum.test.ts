import { describe, expect, it } from 'vitest'

import { evaluateAsync } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'
import { MEDPLUM_CASES, MEDPLUM_CASSETTE, MEDPLUM_ENV } from '../testing/medplum-terminology.ts'
import { replayedTerminology } from '../testing/tx-fixtures.ts'

// Answers recorded from a live Medplum server; `pnpm record:tx:medplum` re-records them.
const terminology = replayedTerminology(MEDPLUM_CASSETTE, 'pnpm record:tx:medplum')

describe('terminology against recorded Medplum answers', () => {
  for (const testCase of MEDPLUM_CASES) {
    it(testCase.name, async () => {
      const result = evaluateAsync(testCase.expression, testCase.input ?? {}, {
        model: r4Model,
        terminology,
        env: MEDPLUM_ENV,
      })
      const expected = testCase.expected
      if ('error' in expected) {
        await expect(result).rejects.toThrow(expected.error)
      } else {
        await expect(result).resolves.toEqual(expected)
      }
    })
  }
})
