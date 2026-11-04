import { describe, expect, it } from 'vitest'

import { FhirPathSyntaxError } from '../errors.ts'
import { findSkipReason, loadOfficialSuite } from '../testing/official-harness.ts'
import { stripSpans } from '../testing/strip-spans.ts'
import { parse } from './parser.ts'
import { printExpression } from './printer.ts'

interface CorpusEntry {
  expression: string
  invalid: string | undefined
}

/** Every suite expression, without the syntax-invalid cases the skip manifest disputes. */
function loadCorpus(release: 'r4' | 'r5'): CorpusEntry[] {
  return loadOfficialSuite(release).flatMap(group =>
    group.tests
      .filter(test => test.invalid !== 'syntax' || findSkipReason(release, group, test) === undefined)
      .map(test => ({ expression: test.expression, invalid: test.invalid }))
  )
}

describe.each([['r4'], ['r5']] as const)('official %s suite expressions', release => {
  const corpus = loadCorpus(release)
  // Semantic-invalid expressions still parse; execution-invalid ones may fail anywhere
  // (e.g. time literals with a timezone are already a grammar error), so only the
  // unmarked and semantic groups must parse.
  const parseable = corpus.filter(entry => entry.invalid === undefined || entry.invalid === 'semantic')
  const syntaxInvalid = corpus.filter(entry => entry.invalid === 'syntax')

  it('finds the whole corpus', () => {
    expect(corpus.length).toBeGreaterThan(release === 'r4' ? 930 : 1040)
    expect(syntaxInvalid.length).toBeGreaterThan(0)
  })

  it('parses every expression that is not marked as a syntax error', () => {
    const failures: { expression: string; error: string }[] = []
    for (const entry of parseable) {
      try {
        parse(entry.expression)
      } catch (error) {
        failures.push({ expression: entry.expression, error: (error as Error).message })
      }
    }
    expect(failures).toEqual([])
  })

  it('rejects the expressions marked as syntax errors', () => {
    for (const entry of syntaxInvalid) {
      expect(() => parse(entry.expression), entry.expression).toThrow(FhirPathSyntaxError)
    }
  })

  it('round trips every parseable expression through the printer', () => {
    const failures: string[] = []
    for (const entry of parseable) {
      const first = parse(entry.expression)
      const printed = printExpression(first)
      try {
        const reparsed = parse(printed)
        expect(stripSpans(reparsed)).toEqual(stripSpans(first))
      } catch {
        failures.push(`${entry.expression} => ${printed}`)
      }
    }
    expect(failures).toEqual([])
  })
})
