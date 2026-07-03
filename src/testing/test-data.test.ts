import { describe, expect, it } from 'vitest'
import { testDataPath } from './test-data'

describe('testDataPath', () => {
  it('resolves vendored files from either cwd', () => {
    expect(testDataPath('official/r4/tests-fhir-r4.xml')).toContain('tests-fhir-r4.xml')
  })

  it('throws a clear error for missing files', () => {
    expect(() => testDataPath('does-not-exist.xml')).toThrow('not found from cwd')
  })
})
