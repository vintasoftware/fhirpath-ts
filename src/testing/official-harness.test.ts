import { describe, expect, it } from 'vitest'

import { runOfficialTest } from './official-harness.ts'

// The harness's own failure paths, exercised with synthetic cases.
describe('official harness', () => {
  it('passes and fails value comparisons', () => {
    expect(
      runOfficialTest('r5', { name: 'x', expression: '1 + 1', outputs: [{ type: 'integer', value: '2' }] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', { name: 'x', expression: '1 + 1', outputs: [{ type: 'integer', value: '3' }] })
    ).toContain('expected integer 3')
    expect(
      runOfficialTest('r5', { name: 'x', expression: "'a'", outputs: [{ type: 'string', value: 'b' }] })
    ).toContain('expected string')
    expect(
      runOfficialTest('r5', { name: 'x', expression: 'true', outputs: [{ type: 'boolean', value: 'false' }] })
    ).toContain('expected false')
    expect(
      runOfficialTest('r5', { name: 'x', expression: '1.50', outputs: [{ type: 'decimal', value: '1.5' }] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', { name: 'x', expression: "'a'", outputs: [{ type: 'decimal', value: '1.5' }] })
    ).toContain('expected decimal')
    expect(
      runOfficialTest('r5', { name: 'x', expression: '@2014', outputs: [{ type: 'date', value: '@2015' }] })
    ).toContain('expected @2015')
    expect(
      runOfficialTest('r5', { name: 'x', expression: '1 | 2', outputs: [{ type: 'integer', value: '1' }] })
    ).toContain('expected 1 results')
  })

  it('handles invalid expectations and predicates', () => {
    expect(runOfficialTest('r5', { name: 'x', expression: '1 +', invalid: 'syntax', outputs: [] })).toBeUndefined()
    expect(runOfficialTest('r5', { name: 'x', expression: '1 + 1', invalid: 'semantic', outputs: [] })).toContain(
      'expected an error'
    )
    expect(
      runOfficialTest('r5', { name: 'x', expression: '(1 | 2).single()', invalid: 'execution', outputs: [] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', {
        name: 'x',
        expression: '1 = 1',
        predicate: true,
        outputs: [{ type: 'boolean', value: 'true' }],
      })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', {
        name: 'x',
        expression: '{}',
        predicate: true,
        outputs: [{ type: 'boolean', value: 'false' }],
      })
    ).toBeUndefined()
  })

  it('reports evaluation failures and untyped outputs', () => {
    expect(runOfficialTest('r5', { name: 'x', expression: '(1 | 2).single()', outputs: [] })).toContain(
      'evaluation failed'
    )
    expect(
      runOfficialTest('r5', { name: 'x', expression: "'text'", outputs: [{ type: '', value: 'text' }] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', { name: 'x', expression: '%a', outputs: [{ type: 'integer', value: '5' }] })
    ).toContain('evaluation failed')
  })
})

describe('output comparisons for longs and temporals', () => {
  it('long results compare against integer outputs', () => {
    expect(
      runOfficialTest('r5', { name: 'x', expression: "'5'.toLong()", outputs: [{ type: 'integer', value: '5' }] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', { name: 'x', expression: "'5'.toLong()", outputs: [{ type: 'integer', value: '6' }] })
    ).toContain('expected integer 6')
  })

  it('temporal literal outputs pass through the @ comparison', () => {
    expect(
      runOfficialTest('r5', { name: 'x', expression: '@T10:00', outputs: [{ type: 'time', value: '@T10:00' }] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', { name: 'x', expression: '@2014', outputs: [{ type: 'date', value: '2014' }] })
    ).toBeUndefined()
    expect(
      runOfficialTest('r5', { name: 'x', expression: '@2014', outputs: [{ type: 'date', value: '@2015' }] })
    ).toContain('expected @2015')
  })
})
