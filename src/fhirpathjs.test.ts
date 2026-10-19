import { describe, expect, it } from 'vitest'

import { DEFERRED_FEATURES, OFFICIAL_SUITE_COPIES, QUIRK_FAMILIES } from '../test-data/fhirpathjs/quirk-manifest.ts'
import {
  classifyCase,
  type CorpusFile,
  type CorpusTest,
  isOfficialSuiteCopy,
  loadCorpus,
  matchQuirk,
  runCorpusTest,
  skipReason,
} from './testing/fhirpathjs-harness.ts'
import { loadOfficialSuite } from './testing/official-harness.ts'

/**
 * The fhirpath.js YAML corpus (plus the fhirpath-py-only files), vendored as
 * JSON. Cases for another FHIR version, intentional divergences (the quirk
 * manifest carries the evidence for each), and cases that need a deferred
 * feature are skipped; everything else must pass. The corpus's copies of the
 * official suites are left out: official.test.ts runs those suites directly.
 * See test-data/fhirpathjs/README.md for provenance.
 */
for (const [corpusName, corpus] of [
  ['fhirpath.js corpus', loadCorpus('cases')],
  ['fhirpath-py extra corpus', loadCorpus('cases-py-extras')],
] as const) {
  describe(corpusName, () => {
    for (const [file, data] of Object.entries(corpus)) {
      if (isOfficialSuiteCopy(file)) {
        continue
      }
      describe(file, () => {
        let index = 0
        for (const test of data.tests) {
          for (const expression of expressionsOf(test)) {
            index += 1
            const title = `${index}: ${(test.desc ?? '').replace(/^\**\s*/, '')} ${truncate(expression)}`
            const reason = skipReason(test, expression, file)
            if (reason !== undefined) {
              it.skip(`${title} — ${reason}`, () => {})
            } else {
              it(title, () => {
                const failure = runCorpusTest(data, test, expression)
                expect(failure, failure).toBeUndefined()
              })
            }
          }
        }
      })
    }
  })
}

/**
 * A case's expressions. fhirpath.js's `{ base, expression }` form evaluates
 * `expression` with the input typed as the `base` path; the deferred-feature
 * manifest names those cases by `expression`.
 */
function expressionsOf(test: CorpusTest): string[] {
  if (typeof test.expression === 'string') {
    return [test.expression]
  }
  if (Array.isArray(test.expression)) {
    return test.expression.filter((entry): entry is string => typeof entry === 'string')
  }
  const { expression } = test.expression as { expression?: unknown }
  return typeof expression === 'string' ? [expression] : []
}

function truncate(expression: string): string {
  return expression.length > 80 ? `${expression.slice(0, 77)}...` : expression
}

describe('quirk manifest hygiene', () => {
  const cases: { file: string; data: CorpusFile; test: CorpusTest; expression: string }[] = []
  for (const corpus of [loadCorpus('cases'), loadCorpus('cases-py-extras')]) {
    for (const [file, data] of Object.entries(corpus)) {
      for (const test of data.tests) {
        for (const expression of expressionsOf(test)) {
          cases.push({ file, data, test, expression })
        }
      }
    }
  }

  it('every quirk and deferred-feature key shields a case this engine still fails', () => {
    // A case that starts passing must take its manifest key with it, and a key
    // matching only official-suite copies or other-model cases shields nothing.
    const shielding = new Set<string>()
    const passing: string[] = []
    for (const { file, data, test, expression } of cases) {
      const skip = classifyCase(test, expression, file)
      if (skip?.kind !== 'quirk' && skip?.kind !== 'deferred') {
        continue
      }
      shielding.add(skip.key)
      if (runCorpusTest(data, test, expression) === undefined) {
        passing.push(`${skip.key} (model ${test.model ?? 'none'})`)
      }
    }
    expect(passing, 'these cases now pass; remove their manifest keys').toEqual([])
    const unused = [...QUIRK_FAMILIES, ...DEFERRED_FEATURES].flatMap(family =>
      family.keys.filter(key => !shielding.has(key))
    )
    expect(unused, 'these manifest keys shield no runnable corpus case').toEqual([])
  })

  it('the quirk manifest stays a small documented fraction of the corpus', () => {
    const matched = cases.filter(({ file, test, expression }) => matchQuirk(file, test, expression)?.kind === 'quirk')
    expect(matched.length / cases.length).toBeLessThan(0.1)
  })

  it('every case of the official-suite copies is in the official suite official.test.ts runs', () => {
    const normalize = (expression: string) => expression.replace(/\s+/g, ' ').trim()
    const official = {
      r4: new Set(loadOfficialSuite('r4').flatMap(group => group.tests.map(test => normalize(test.expression)))),
      r5: new Set(loadOfficialSuite('r5').flatMap(group => group.tests.map(test => normalize(test.expression)))),
    }
    const missing = cases
      .filter(({ file }) => OFFICIAL_SUITE_COPIES.includes(file))
      .filter(({ file, expression }) => !official[file.includes('r4') ? 'r4' : 'r5'].has(normalize(expression)))
      .map(({ file, expression }) => `${file}: ${expression}`)
    expect(missing).toEqual([])
  })
})
