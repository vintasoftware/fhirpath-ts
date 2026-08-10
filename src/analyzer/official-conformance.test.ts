import { describe, expect, it } from 'vitest'

import { ANALYZER_SKIP_MANIFEST } from '../../test-data/official/analyzer-skip-manifest.ts'
import { SKIP_MANIFEST } from '../../test-data/official/skip-manifest.ts'
import { r4Model } from '../r4/index.ts'
import {
  casesMatching,
  findSkipReason,
  fixtureResourceType,
  loadOfficialSuite,
  type OfficialGroup,
  type OfficialTest,
  type SuiteName,
} from '../testing/official-harness.ts'
import { analyzeExpression } from './analyze.ts'

/**
 * Runs the analyzer over the official suites. Syntax, semantic, and strict cases
 * must report an error; valid cases must report none. Execution-only failures
 * are excluded. Runtime feature skips and the analyzer skip manifest apply with
 * stale-entry checks.
 */

const suites: Record<SuiteName, OfficialGroup[]> = {
  r4: loadOfficialSuite('r4'),
  r5: loadOfficialSuite('r5'),
}

/** The runtime skip manifest minus its strict-mode entries, which are this file's subject. */
const RUNTIME_SKIPS = SKIP_MANIFEST.filter(entry => entry.mode !== 'strict')

function mustError(test: OfficialTest): boolean {
  return test.invalid === 'syntax' || test.invalid === 'semantic' || test.mode === 'strict'
}

function describeDiagnostics(diagnostics: ReturnType<typeof analyzeExpression>): string {
  return diagnostics.map(d => `${d.severity} ${d.code}: ${d.message}`).join('; ')
}

function analyzeCase(suite: SuiteName, test: OfficialTest): ReturnType<typeof analyzeExpression> {
  const inputType = test.inputfile === undefined ? undefined : fixtureResourceType(suite, test.inputfile)
  return analyzeExpression(
    test.expression,
    inputType === undefined ? { model: r4Model } : { model: r4Model, inputType }
  )
}

for (const suite of ['r4', 'r5'] as const) {
  describe(`analyzer conformance, official ${suite} suite`, () => {
    for (const group of suites[suite]) {
      describe(group.name, () => {
        for (const test of group.tests) {
          const title = `${test.name}: ${test.expression.slice(0, 100)}`
          const skipReason =
            findSkipReason(suite, group, test, RUNTIME_SKIPS) ??
            findSkipReason(suite, group, test, ANALYZER_SKIP_MANIFEST) ??
            (test.skipStaticCheck ? 'suite marks this case skipStaticCheck' : undefined) ??
            (test.invalid === 'execution' ? 'execution-time failures are beyond static checking' : undefined)
          if (skipReason !== undefined) {
            it.skip(`${title} [${skipReason}]`, () => {})
            continue
          }
          if (mustError(test)) {
            it(title, () => {
              const diagnostics = analyzeCase(suite, test)
              const errors = diagnostics.filter(d => d.severity === 'error')
              expect(
                errors.length,
                `expected an error-severity diagnostic (invalid="${test.invalid}", mode="${test.mode}"), got: ${
                  describeDiagnostics(diagnostics) || 'none'
                }`
              ).toBeGreaterThan(0)
            })
            continue
          }
          it(title, () => {
            const errors = analyzeCase(suite, test).filter(d => d.severity === 'error')
            expect(errors, `valid case flagged: ${describeDiagnostics(errors)}`).toEqual([])
          })
        }
      })
    }
  })
}

describe('analyzer skip manifest hygiene', () => {
  it('every analyzer skip entry shields a case the analyzer still gets wrong', () => {
    // A fixed check must take its manifest entry with it: re-run the analyzer on
    // each skipped case and require the analyzer to still get it wrong. An entry
    // matching nothing — or only runtime-skipped cases — shields nothing and must go.
    for (const entry of ANALYZER_SKIP_MANIFEST) {
      const shielded = casesMatching(entry, suites).filter(
        ({ group, test }) => findSkipReason(entry.suite, group, test, RUNTIME_SKIPS) === undefined
      )
      expect(
        shielded.length,
        `${entry.suite}/${entry.group}/${entry.test} shields no asserted case: ${entry.reason}`
      ).toBeGreaterThan(0)
      for (const { group, test } of shielded) {
        const errors = analyzeCase(entry.suite, test).filter(d => d.severity === 'error')
        const wrong = mustError(test) ? errors.length === 0 : errors.length > 0
        expect(
          wrong,
          `${entry.suite}/${group.name}/${test.name} now analyzes correctly — remove its manifest entry`
        ).toBe(true)
      }
    }
  })
})
