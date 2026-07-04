import { describe, expect, it } from 'vitest'
import { QUIRK_FAMILIES } from '../test-data/fhirpathjs/quirk-manifest.ts'
import { type CorpusTest, loadCorpus, matchQuirk, runCorpusTest, skipReason } from './testing/fhirpathjs-harness.ts'

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
  const allKeys: { file: string; expression: string }[] = []
  for (const corpus of [loadCorpus('cases'), loadCorpus('cases-py-extras')]) {
    for (const [file, data] of Object.entries(corpus)) {
      for (const test of data.tests) {
        for (const expression of expressionsOf(test)) {
          allKeys.push({ file, expression })
        }
      }
    }
  }

  it('every quirk manifest key still names a corpus case', () => {
    const corpusKeys = new Set(allKeys.map(key => `${key.file}||${key.expression}`))
    const stale = QUIRK_FAMILIES.flatMap(family => family.keys.filter(key => !corpusKeys.has(key)))
    expect(stale).toEqual([])
  })

  it('the manifest stays a small documented fraction of the corpus', () => {
    const matched = allKeys.filter(key => matchQuirk(key.file, key.expression) !== undefined).length
    expect(matched / allKeys.length).toBeLessThan(0.1)
  })
})
