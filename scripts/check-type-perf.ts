// Limits the type-level inference cost of FhirpathResult<Expr>.
//
// `tsc --extendedDiagnostics` instantiation counts are deterministic for a
// pinned TypeScript version and fixed sources, so this compares the perf
// fixture's count against a checked-in budget instead of a flaky timing.
// A regression fails CI with a diff the PR must own: either fix the cost or
// raise scripts/type-perf-budget.json in the same PR and justify it in review.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const budgetPath = new URL('./type-perf-budget.json', import.meta.url)
const budget = JSON.parse(readFileSync(budgetPath, 'utf8')) as { instantiations: number; tolerancePct: number }

let output: string
try {
  output = execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.perf.json', '--noEmit', '--extendedDiagnostics'],
    { cwd: root, encoding: 'utf8' }
  )
} catch (error) {
  // tsc exits non-zero on type errors; `pnpm typecheck` owns those. Still
  // report them here so a broken fixture cannot skip this check.
  const failed = error as { stdout?: string; message: string }
  console.error(failed.stdout ?? failed.message)
  process.exit(1)
}

const match = /^Instantiations:\s+(\d+)/m.exec(output)
if (!match?.[1]) {
  console.error('Could not find an Instantiations line in tsc --extendedDiagnostics output:')
  console.error(output)
  process.exit(1)
}

const actual = Number(match[1])
const limit = Math.round(budget.instantiations * (1 + budget.tolerancePct / 100))
const deltaPct = ((actual - budget.instantiations) / budget.instantiations) * 100
const summary = `type-inference perf: ${actual} instantiations (budget ${budget.instantiations}, ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%, limit ${limit})`

if (process.argv.includes('--update')) {
  writeFileSync(budgetPath, `${JSON.stringify({ ...budget, instantiations: actual }, null, 2)}\n`)
  console.log(`${summary} — budget updated to ${actual}`)
} else if (actual > limit) {
  console.error(`${summary} — FAIL`)
  console.error(
    `Inference got meaningfully more expensive. Reduce the cost, or rerun with \`pnpm check:type-perf --update\` and justify the new budget in the PR.`
  )
  process.exit(1)
} else {
  if (actual < budget.instantiations * (1 - budget.tolerancePct / 100)) {
    console.log(`${summary} — under budget; consider ratcheting down via \`pnpm check:type-perf --update\``)
  } else {
    console.log(`${summary} — OK`)
  }
}
