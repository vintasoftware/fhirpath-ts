import { describe, expect, it } from 'vitest'

import { INFERENCE_PRECISION_REPORT } from './generated/precision-report.ts'

describe('type-inference precision report', () => {
  it('accounts for the whole distinct corpus without unsound conflicts', () => {
    expect(INFERENCE_PRECISION_REPORT.conflict).toBe(0)
    expect(
      INFERENCE_PRECISION_REPORT.checked + INFERENCE_PRECISION_REPORT.rejected + INFERENCE_PRECISION_REPORT.budget
    ).toBe(INFERENCE_PRECISION_REPORT.total)
    expect(
      INFERENCE_PRECISION_REPORT.precise + INFERENCE_PRECISION_REPORT.opaque + INFERENCE_PRECISION_REPORT.conflict
    ).toBe(INFERENCE_PRECISION_REPORT.checked)
  })
})
