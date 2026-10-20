import { describe, expect, it } from 'vitest'

import {
  DEFERRED_FEATURES,
  MODEL_DIFFERENCES,
  OFFICIAL_SUITE_COPIES,
  QUIRK_FAMILIES,
} from '../test-data/fhirpathjs/quirk-manifest.ts'
import {
  classifyCase,
  type CorpusCase,
  corpusCases,
  expressionsOf,
  loadCorpus,
  matchQuirk,
  runCorpusTest,
  skipReason,
} from './testing/fhirpathjs-harness.ts'
import { loadOfficialSuite } from './testing/official-harness.ts'

/**
 * The fhirpath.js YAML corpus (plus the fhirpath-py-only files), vendored as
 * JSON. Cases for another FHIR version or model, intentional divergences (the
 * quirk manifest carries the evidence for each), and cases that need a
 * deferred feature are skipped; everything else must pass. `corpusCases()`
 * leaves out the corpus's copies of the official suites: official.test.ts runs
 * those suites directly. See test-data/fhirpathjs/README.md for provenance.
 */
for (const [corpusName, cases] of [
  ['fhirpath.js corpus', corpusCases('cases')],
  ['fhirpath-py extra corpus', corpusCases('cases-py-extras')],
] as const) {
  describe(corpusName, () => {
    const files = new Map<string, CorpusCase[]>()
    for (const corpusCase of cases) {
      files.set(corpusCase.file, [...(files.get(corpusCase.file) ?? []), corpusCase])
    }
    for (const [file, fileCases] of files) {
      describe(file, () => {
        fileCases.forEach(({ data, test, expression }, index) => {
          const title = `${index + 1}: ${(test.desc ?? '').replace(/^\**\s*/, '')} ${truncate(expression)}`
          const reason = skipReason(test, expression, file)
          if (reason !== undefined) {
            it.skip(`${title} — ${reason}`, () => {})
          } else {
            it(title, () => {
              const failure = runCorpusTest(data, test, expression)
              expect(failure, failure).toBeUndefined()
            })
          }
        })
      })
    }
  })
}

function truncate(expression: string): string {
  return expression.length > 80 ? `${expression.slice(0, 77)}...` : expression
}

describe('quirk manifest hygiene', () => {
  const cases = [...corpusCases('cases'), ...corpusCases('cases-py-extras')]

  it('every manifest family key shields a case this engine still fails', () => {
    // A case that starts passing must take its manifest key with it, and a key
    // matching only other-model cases shields nothing.
    const shielding = new Set<string>()
    const passing: string[] = []
    for (const { file, data, test, expression } of cases) {
      const key = classifyCase(test, expression, file)?.key
      if (key === undefined) {
        continue
      }
      shielding.add(key)
      if (runCorpusTest(data, test, expression) === undefined) {
        passing.push(`${key} (model ${test.model ?? 'none'})`)
      }
    }
    expect(passing, 'these cases now pass; remove their manifest keys').toEqual([])
    const unused = [...MODEL_DIFFERENCES, ...QUIRK_FAMILIES, ...DEFERRED_FEATURES].flatMap(family =>
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
    const corpus = loadCorpus('cases')
    const missing = OFFICIAL_SUITE_COPIES.flatMap(file =>
      (corpus[file]?.tests ?? [])
        .flatMap(test => expressionsOf(test))
        .filter(expression => !official[file.includes('r4') ? 'r4' : 'r5'].has(normalize(expression)))
        .map(expression => `${file}: ${expression}`)
    )
    expect(missing).toEqual([])
  })
})
