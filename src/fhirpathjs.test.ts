import { describe, expect, it } from 'vitest'

import { DISABLED_UPSTREAM_SKIPS, QUIRK_FAMILIES } from '../test-data/fhirpathjs/quirk-manifest.ts'
import {
  type CorpusFile,
  type CorpusTest,
  disabledUpstreamSkip,
  loadCorpus,
  matchQuirk,
  runCorpusTest,
  skipReason,
} from './testing/fhirpathjs-harness.ts'

/**
 * The fhirpath.js YAML corpus (plus the fhirpath-py-only files), vendored as
 * JSON. Cases we intentionally diverge on are skipped through the quirk
 * manifest, which carries the evidence for each divergence; everything else
 * must pass. See test-data/fhirpathjs/README.md for provenance.
 */
for (const [corpusName, corpus] of [
  ['fhirpath.js corpus', loadCorpus('cases')],
  ['fhirpath-py extra corpus', loadCorpus('cases-py-extras')],
] as const) {
  describe(corpusName, () => {
    for (const [file, data] of Object.entries(corpus)) {
      describe(file, () => {
        let index = 0
        for (const test of data.tests) {
          const expressions = expressionsOf(test)
          for (const expression of expressions) {
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

function expressionsOf(test: CorpusTest): string[] {
  if (typeof test.expression === 'string') {
    return [test.expression]
  }
  if (Array.isArray(test.expression)) {
    return test.expression.filter((entry): entry is string => typeof entry === 'string')
  }
  // Non-string expressions (fhirpath.js internal AST form) go through skipReason.
  return ['<non-string expression>']
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

  it('every quirk manifest key shields a case this engine still fails', () => {
    // A quirk that starts passing must take its manifest key with it, and a key
    // matching only disabled or other-model cases shields nothing.
    const shielding = new Set<string>()
    const passing: string[] = []
    for (const { file, data, test, expression } of cases) {
      const quirk = matchQuirk(file, expression, test.model)
      if (quirk === undefined || skipReason(test, expression, file) !== `intentional divergence: ${quirk.name}`) {
        continue
      }
      for (const key of quirk.keys) {
        if (key === `${file}||${expression}` || key === `${file}@${test.model ?? 'none'}||${expression}`) {
          shielding.add(key)
        }
      }
      if (runCorpusTest(data, test, expression) === undefined) {
        passing.push(`${file}||${expression} (model ${test.model ?? 'none'})`)
      }
    }
    expect(passing, 'these quirk cases now pass; remove their manifest keys').toEqual([])
    const unused = QUIRK_FAMILIES.flatMap(family => family.keys.filter(key => !shielding.has(key)))
    expect(unused, 'these quirk keys shield no runnable corpus case').toEqual([])
  })

  it('every disabled-upstream skip names one disabled case this engine still fails', () => {
    for (const entry of DISABLED_UPSTREAM_SKIPS) {
      const matches = cases.filter(
        ({ file, test }) =>
          (test.disable === true || test.inheritedDisable === true) && disabledUpstreamSkip(file, test) === entry
      )
      expect(matches.length, `${entry.file}: ${entry.desc}`).toBe(1)
      for (const { data, test, expression } of matches) {
        expect(runCorpusTest(data, test, expression), `${entry.file}: ${entry.desc} now passes`).toBeDefined()
      }
    }
  })

  it('the manifest stays a small documented fraction of the corpus', () => {
    const matched = cases.filter(({ file, test, expression }) => matchQuirk(file, expression, test.model) !== undefined)
    expect(matched.length / cases.length).toBeLessThan(0.1)
  })
})
