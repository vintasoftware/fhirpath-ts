import { describe, expect, it } from 'vitest'

import { QUIRK_FAMILIES } from '../../test-data/fhirpathjs/quirk-manifest.ts'
import { type CorpusFile, type CorpusTest, matchQuirk, runCorpusTest, skipReason } from './fhirpathjs-harness.ts'

const emptyFile: CorpusFile = { subject: { resourceType: 'Patient', active: true }, tests: [] }

function run(test: CorpusTest, expression: string): string | undefined {
  return runCorpusTest(emptyFile, test, expression)
}

describe('corpus harness comparator', () => {
  it('reports result mismatches and error mismatches with details', () => {
    expect(run({ expression: 'active', result: [false] }, 'active')).toContain('got [true], want [false]')
    expect(run({ expression: 'active', result: [true], error: true }, 'active')).toContain('expected an error')
    expect(run({ expression: '1 +', result: [1] }, '1 +')).toContain('threw')
    expect(run({ expression: '1 +', error: [true] }, '1 +')).toBeUndefined()
    expect(run({ expression: 'active', result: [true] }, 'active')).toBeUndefined()
  })

  it('compares numbers with float tolerance and structures deeply', () => {
    expect(run({ expression: '0.1 + 0.2', result: [0.3] }, '0.1 + 0.2')).toBeUndefined()
    expect(run({ expression: '1 / 3', result: [0.3333333333333333] }, '1 / 3')).toBeUndefined()
    expect(run({ expression: '(1 | 2)', result: [1] }, '(1 | 2)')).toContain('want')
    expect(run({ expression: '{}', result: [{ a: 1 }] }, '{}')).toContain('want')
  })

  it('renders longs as strings and quantities in literal form', () => {
    expect(run({ expression: '5L', result: ['5'] }, '5L')).toBeUndefined()
    expect(run({ expression: "4.5 'mg'", result: ["4.5 'mg'"] }, "4.5 'mg'")).toBeUndefined()
    expect(run({ expression: '4 days', result: ['4 days'] }, '4 days')).toBeUndefined()
  })

  it('compares datetimes by instant, not by offset spelling', () => {
    expect(
      run({ expression: '@2018-02-18T12:23:45-05:00', result: ['2018-02-18T17:23:45Z'] }, '@2018-02-18T12:23:45-05:00')
    ).toBeUndefined()
    expect(run({ expression: "'a'", result: ['b'] }, "'a'")).toContain('want')
  })

  it('threads context and variables into the evaluation', () => {
    const test: CorpusTest = {
      expression: '%context.active | %flag',
      context: '$this',
      variables: { flag: 'x' },
      result: [true, 'x'],
    }
    expect(run(test, '%context.active | %flag')).toBeUndefined()
  })
})

describe('corpus skip logic', () => {
  it('covers each skip shape', () => {
    expect(skipReason({ expression: 'a', disable: true }, 'a', 'f.yaml')).toBe('disabled upstream')
    expect(skipReason({ expression: 'a', inheritedDisable: true }, 'a', 'f.yaml')).toBe('disabled upstream')
    expect(skipReason({ expression: { dsl: true } }, '<non-string expression>', 'f.yaml')).toContain('non-string')
    expect(skipReason({ expression: 'a', model: 'r5' }, 'a', 'f.yaml')).toContain('R5 model')
    expect(skipReason({ expression: 'a', model: 'r99' }, 'a', 'f.yaml')).toContain('unknown model')
    expect(skipReason({ expression: 'a', model: 'r4' }, 'a', 'f.yaml')).toBeUndefined()
    const [quirkFile, quirkExpression] = ((QUIRK_FAMILIES[0] as { keys: string[] }).keys[0] as string).split('||') as [
      string,
      string,
    ]
    expect(skipReason({ expression: quirkExpression }, quirkExpression, quirkFile)).toContain('intentional divergence')
    expect(matchQuirk('nope.yaml', 'nope')).toBeUndefined()
  })
})
