/**
 * fhirpath-ts side of the cross-engine benchmark.
 *
 * For each workload case: compile the expression once, then time parse and eval in
 * warmed loops. Records per-expression ns/op plus whether the engine accepted it
 * (compiled and evaluated without throwing), so the comparison can be restricted to
 * the set both engines handle.
 *
 *   node benchmarks/bench-ts.ts [--no-model] [workloadPath] [outPath]
 *
 * --no-model drops the R4 ModelProvider, matching a model-unaware engine (e.g. the
 * Rust harness with EmptyModelProvider) for a symmetric eval comparison.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { compile } from '../src/index.ts'
import { r4Model } from '../src/r4/index.ts'

const WARMUP = 50
const ITERS = 2000

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const noModel = argv.includes('--no-model')
const positional = argv.filter(arg => !arg.startsWith('--'))
const workloadPath = positional[0] ?? path.join(here, 'results', 'workload.json')
const outPath = positional[1] ?? path.join(here, 'results', noModel ? 'ts-nomodel.json' : 'ts-model.json')

const opts = noModel ? {} : { model: r4Model }
const { fixtures, cases } = JSON.parse(readFileSync(workloadPath, 'utf8'))

const results = []
for (const testCase of cases) {
  const input = fixtures[testCase.fixture]
  const record = {
    name: testCase.name,
    expression: testCase.expression,
    accepted: false,
    parseNs: null,
    evalNs: null,
    error: null,
  }
  try {
    for (let i = 0; i < WARMUP; i++) {
      compile(testCase.expression)
    }
    let t = performance.now()
    for (let i = 0; i < ITERS; i++) {
      compile(testCase.expression)
    }
    record.parseNs = ((performance.now() - t) * 1e6) / ITERS

    const compiled = compile(testCase.expression)
    compiled.evaluate(input, opts)
    for (let i = 0; i < WARMUP; i++) {
      compiled.evaluate(input, opts)
    }
    t = performance.now()
    for (let i = 0; i < ITERS; i++) {
      compiled.evaluate(input, opts)
    }
    record.evalNs = ((performance.now() - t) * 1e6) / ITERS
    record.accepted = true
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 200)
  }
  results.push(record)
}

const accepted = results.filter(r => r.accepted).length
writeFileSync(
  outPath,
  JSON.stringify({
    engine: noModel ? 'fhirpath-ts (no model)' : 'fhirpath-ts (r4 model)',
    total: results.length,
    accepted,
    results,
  })
)
console.log(
  `${noModel ? 'fhirpath-ts (no model)' : 'fhirpath-ts (r4 model)'}: accepted ${accepted}/${results.length} -> ${path.basename(outPath)}`
)
