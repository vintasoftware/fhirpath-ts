/**
 * Summarize repeated cross-engine benchmark runs on their unchanged common set.
 *
 *   node benchmarks/summarize-runs.mjs RUN_DIR...
 *
 * Each directory must contain ts-model.json, ts-nomodel.json, and rs.json from
 * benchmarks/run.sh. The output is a Markdown table suitable for the plan and
 * pull request.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const runDirectories = process.argv.slice(2)
if (runDirectories.length === 0) {
  console.error('usage: node benchmarks/summarize-runs.mjs RUN_DIR...')
  process.exit(1)
}

const resultFiles = ['ts-model.json', 'ts-nomodel.json', 'rs.json']
const runs = runDirectories.map(directory =>
  resultFiles.map(file => JSON.parse(readFileSync(path.join(directory, file), 'utf8')))
)

const engineLabels = runs[0].map(result => result.engine)
for (const [runIndex, run] of runs.entries()) {
  const labels = run.map(result => result.engine)
  if (JSON.stringify(labels) !== JSON.stringify(engineLabels)) {
    throw new Error(`run ${runIndex + 1} has different engine labels: ${labels.join(', ')}`)
  }
}

const isTrace = expression => /\btrace\s*\(/.test(expression)
const acceptedNames = runs.map(run => {
  const byEngine = run.map(result => new Map(result.results.map(item => [item.name, item])))
  return run[0].results
    .filter(item => !isTrace(item.expression))
    .filter(item => byEngine.every(engine => engine.get(item.name)?.accepted))
    .map(item => item.name)
})
const commonNames = acceptedNames.reduce(
  (common, names) => common.filter(name => names.includes(name)),
  acceptedNames[0]
)

console.log(`Runs: ${runs.length}; unchanged common accepted set (no trace): ${commonNames.length}`)
console.log()
console.log('| Engine | Metric | Median aggregate mean | Median | p95 |')
console.log('| --- | --- | ---: | ---: | ---: |')

for (const [engineIndex, label] of engineLabels.entries()) {
  for (const [metric, metricLabel] of [
    ['evalNs', 'evaluation'],
    ['parseNs', 'parse'],
  ]) {
    const summaries = runs.map(run => {
      const byName = new Map(run[engineIndex].results.map(item => [item.name, item]))
      const values = commonNames.map(name => byName.get(name)[metric])
      return {
        mean: mean(values),
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
      }
    })
    console.log(
      `| ${label} | ${metricLabel} | ${format(
        quantile(
          summaries.map(value => value.mean),
          0.5
        )
      )} | ${format(
        quantile(
          summaries.map(value => value.median),
          0.5
        )
      )} | ${format(
        quantile(
          summaries.map(value => value.p95),
          0.5
        )
      )} |`
    )
  }
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) * probability)]
}

function format(nanoseconds) {
  return nanoseconds >= 1000 ? `${(nanoseconds / 1000).toFixed(2)} µs` : `${nanoseconds.toFixed(0)} ns`
}
