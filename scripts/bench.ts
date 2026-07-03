/**
 * Micro-benchmarks for the parse and evaluate hot paths. Not part of CI — run
 * by hand when touching the parser, navigation, or operator dispatch:
 *   node scripts/bench.ts
 */
import { performance } from 'node:perf_hooks'
import { compile, evaluate } from '../src/index.ts'
import { r4Model } from '../src/r4/index.ts'

const patient = {
  resourceType: 'Patient',
  id: 'example',
  name: [
    { use: 'official', family: 'Chalmers', given: ['Peter', 'James'] },
    { use: 'usual', given: ['Jim'] },
  ],
  birthDate: '1974-12-25',
  telecom: [{ system: 'phone', value: '555-1234' }],
}

const EXPRESSIONS = [
  'Patient.name.given',
  "Patient.name.where(use = 'official').family.first()",
  'Patient.birthDate < today()',
  "Patient.telecom.where(system = 'phone').value",
  'Patient.name.given.count() + Patient.name.family.count()',
]

function bench(label: string, iterations: number, run: () => void): void {
  run() // warm up
  const started = performance.now()
  for (let i = 0; i < iterations; i++) {
    run()
  }
  const elapsed = performance.now() - started
  console.log(
    `${label}: ${((elapsed / iterations) * 1000).toFixed(2)}µs/op (${iterations} ops in ${elapsed.toFixed(0)}ms)`
  )
}

for (const expression of EXPRESSIONS) {
  bench(`parse       ${expression.slice(0, 48)}`, 5_000, () => {
    compile(expression)
  })
  const compiled = compile(expression)
  bench(`eval        ${expression.slice(0, 48)}`, 5_000, () => {
    compiled.evaluate(patient, { model: r4Model })
  })
  bench(`eval+cache  ${expression.slice(0, 48)}`, 5_000, () => {
    evaluate(expression, patient, { model: r4Model })
  })
}
