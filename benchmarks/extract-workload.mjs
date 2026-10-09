/**
 * Build the shared benchmark workload from the official HL7 R4 conformance suite.
 *
 * Each case pairs a FHIRPath expression with the FHIR resource it runs against.
 * We keep only cases that (a) expect a value (not an error) and (b) have an input
 * fixture, so the comparison is apples-to-apples real-resource evaluation. The
 * output embeds each distinct fixture once; cases reference it by filename.
 *
 *   node benchmarks/extract-workload.mjs [outPath]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const suiteDir = path.join(repoRoot, 'test-data/official/r4')
const outPath = process.argv[2] ?? path.join(here, 'results', 'workload.json')

const groups = JSON.parse(readFileSync(path.join(suiteDir, 'tests.json'), 'utf8'))
const fixtures = {}
const cases = []
let skippedInvalid = 0
let skippedNoInput = 0

function loadFixture(inputfile) {
  // The suite references .xml fixtures; this repo ships the JSON equivalents.
  const jsonName = inputfile.replace(/\.xml$/, '.json')
  if (!(jsonName in fixtures)) {
    fixtures[jsonName] = JSON.parse(readFileSync(path.join(suiteDir, 'fixtures', jsonName), 'utf8'))
  }
  return jsonName
}

for (const group of groups) {
  for (const test of group.tests ?? []) {
    if (test.invalid !== undefined) {
      skippedInvalid++ // error-expectation cases: not an evaluation workload
      continue
    }
    if (!test.inputfile) {
      skippedNoInput++ // literal-only cases: keep it real-resource apples-to-apples
      continue
    }
    cases.push({
      name: `${group.name}/${test.name}`,
      expression: test.expression,
      fixture: loadFixture(test.inputfile),
    })
  }
}

mkdirSync(path.dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ fixtures, cases }))
console.log(
  `wrote ${cases.length} cases (${Object.keys(fixtures).length} fixtures) to ${path.relative(repoRoot, outPath)}\n` +
    `skipped ${skippedInvalid} error-expectation + ${skippedNoInput} literal-only cases`
)
