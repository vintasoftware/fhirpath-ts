/**
 * Compare engine result files on the set of expressions every engine accepted.
 *
 *   node benchmarks/compare.mjs [resultFile...]
 *
 * With no args it reads results/ts-model.json, results/ts-nomodel.json and
 * results/rs.json (each optional). trace() cases are excluded: the Rust engine
 * writes trace output to stdout, which pollutes their timing.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaults = ['ts-model.json', 'ts-nomodel.json', 'rs.json'].map(f => path.join(here, 'results', f))
const files = (process.argv.slice(2).length ? process.argv.slice(2) : defaults).filter(existsSync)
if (files.length < 2) {
  console.error('need at least two result files; run the harnesses first (see benchmarks/README.md)')
  process.exit(1)
}

const engines = files.map(f => {
  const data = JSON.parse(readFileSync(f, 'utf8'))
  return { label: data.engine, byName: new Map(data.results.map(r => [r.name, r])), results: data.results }
})

const isTrace = expr => /\btrace\s*\(/.test(expr)
const base = engines[0]
const common = base.results
  .filter(r => !isTrace(r.expression))
  .filter(r => engines.every(e => e.byName.get(r.name)?.accepted))
  .map(r => r.name)

const quantile = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * p)]
}
const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length
const sum = arr => arr.reduce((s, x) => s + x, 0)
const fmt = ns => (ns >= 1000 ? `${(ns / 1000).toFixed(2)}µs` : `${ns.toFixed(0)}ns`)
const pad = (s, n) => String(s).padStart(n)

for (const e of engines) {
  console.log(`  accepted ${e.results.filter(r => r.accepted).length}/${e.results.length}  ${e.label}`)
}
console.log(`\ncommon accepted set (no trace): ${common.length}\n`)

for (const metric of ['evalNs', 'parseNs']) {
  console.log(`=== ${metric === 'evalNs' ? 'EVAL' : 'PARSE'} ns/op (n=${common.length}) ===`)
  for (const e of engines) {
    const v = common.map(n => e.byName.get(n)[metric])
    console.log(
      `  ${e.label.padEnd(24)} median ${pad(fmt(quantile(v, 0.5)), 9)}  mean ${pad(fmt(mean(v)), 9)}  ` +
        `p90 ${pad(fmt(quantile(v, 0.9)), 9)}  one-pass ${pad(`${(sum(v) / 1000).toFixed(0)}µs`, 9)}`
    )
  }
  console.log()
}
