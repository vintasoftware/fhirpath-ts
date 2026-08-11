import { describe, expect, it } from 'vitest'

import { INFERENCE_PRECISION_REPORT } from './generated/precision-report.ts'

describe('type-inference precision report', () => {
  it('accounts for the whole distinct corpus without unsound conflicts', () => {
    expect(INFERENCE_PRECISION_REPORT).toMatchObject({
      total: 2356,
      checked: 2347,
      precise: 1766,
      opaque: 581,
      conflict: 0,
      rejected: 8,
      budget: 1,
    })
    expect(
      INFERENCE_PRECISION_REPORT.checked + INFERENCE_PRECISION_REPORT.rejected + INFERENCE_PRECISION_REPORT.budget
    ).toBe(INFERENCE_PRECISION_REPORT.total)
  })
})
