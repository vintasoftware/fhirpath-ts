import { describe, expect, it } from 'vitest'
import { runOfficialTest } from './official-harness.ts'
import { recordedTerminology } from './tx-fixtures.ts'

// The harness's own failure paths, exercised with synthetic cases.
describe('official harness', () => {
  it('passes and fails value comparisons', async () => {
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '1 + 1', outputs: [{ type: 'integer', value: '2' }] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '1 + 1', outputs: [{ type: 'integer', value: '3' }] })
    ).resolves.toContain('expected integer 3')
    await expect(
      runOfficialTest('r5', { name: 'x', expression: "'a'", outputs: [{ type: 'string', value: 'b' }] })
    ).resolves.toContain('expected string')
    await expect(
      runOfficialTest('r5', { name: 'x', expression: 'true', outputs: [{ type: 'boolean', value: 'false' }] })
    ).resolves.toContain('expected false')
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '1.50', outputs: [{ type: 'decimal', value: '1.5' }] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: "'a'", outputs: [{ type: 'decimal', value: '1.5' }] })
    ).resolves.toContain('expected decimal')
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '@2014', outputs: [{ type: 'date', value: '@2015' }] })
    ).resolves.toContain('expected @2015')
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '1 | 2', outputs: [{ type: 'integer', value: '1' }] })
    ).resolves.toContain('expected 1 results')
  })

  it('handles invalid expectations and predicates', async () => {
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '1 +', invalid: 'syntax', outputs: [] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '1 + 1', invalid: 'semantic', outputs: [] })
    ).resolves.toContain('expected an error')
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '(1 | 2).single()', invalid: 'execution', outputs: [] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', {
        name: 'x',
        expression: '1 = 1',
        predicate: true,
        outputs: [{ type: 'boolean', value: 'true' }],
      })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', {
        name: 'x',
        expression: '{}',
        predicate: true,
        outputs: [{ type: 'boolean', value: 'false' }],
      })
    ).resolves.toBeUndefined()
  })

  it('reports evaluation failures and untyped outputs', async () => {
    await expect(runOfficialTest('r5', { name: 'x', expression: '(1 | 2).single()', outputs: [] })).resolves.toContain(
      'evaluation failed'
    )
    await expect(
      runOfficialTest('r5', { name: 'x', expression: "'text'", outputs: [{ type: '', value: 'text' }] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '%a', outputs: [{ type: 'integer', value: '5' }] })
    ).resolves.toContain('evaluation failed')
  })
})

describe('output comparisons for longs and temporals', () => {
  it('long results compare against integer outputs', async () => {
    await expect(
      runOfficialTest('r5', { name: 'x', expression: "'5'.toLong()", outputs: [{ type: 'integer', value: '5' }] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: "'5'.toLong()", outputs: [{ type: 'integer', value: '6' }] })
    ).resolves.toContain('expected integer 6')
  })

  it('temporal literal outputs pass through the @ comparison', async () => {
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '@T10:00', outputs: [{ type: 'time', value: '@T10:00' }] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '@2014', outputs: [{ type: 'date', value: '2014' }] })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', { name: 'x', expression: '@2014', outputs: [{ type: 'date', value: '@2015' }] })
    ).resolves.toContain('expected @2015')
  })
})

describe('tx-mode cases', () => {
  it('replays recorded tx.fhir.org responses and names unrecorded requests', async () => {
    await expect(
      runOfficialTest('r5', {
        name: 'x',
        expression:
          "%terminologies.expand('http://hl7.org/fhir/ValueSet/administrative-gender').expansion.contains.count()",
        mode: 'tx',
        outputs: [{ type: 'integer', value: '4' }],
      })
    ).resolves.toBeUndefined()
    await expect(
      runOfficialTest('r5', {
        name: 'x',
        expression: "%terminologies.expand('http://example.org/ValueSet/not-recorded')",
        mode: 'tx',
        outputs: [],
      })
    ).resolves.toContain('No recorded tx.fhir.org response for expand')
  })
})

describe('recorded terminology provider', () => {
  it('every operation reports unrecorded requests', async () => {
    const provider = recordedTerminology
    await expect(provider.lookup?.({ system: 's', code: 'c' })).rejects.toThrow('No recorded tx.fhir.org response')
    await expect(provider.validateCS?.('http://cs', 'c')).rejects.toThrow('No recorded tx.fhir.org response')
    await expect(provider.subsumes?.('s', 'a', 'b')).rejects.toThrow('No recorded tx.fhir.org response')
    await expect(provider.translate?.('http://cm', 'c', 'p=1')).rejects.toThrow('No recorded tx.fhir.org response')
    await expect(provider.validateVS?.('http://vs', 'c')).rejects.toThrow('No recorded tx.fhir.org response')
  })
})
