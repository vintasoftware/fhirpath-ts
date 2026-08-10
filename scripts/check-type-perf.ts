import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RESOLVED_INFERENCE_CAPABILITIES } from '../src/typed/generated/capabilities.ts'

interface PerfBudget {
  tolerancePct: number
  compilers: Record<string, { commonPath: number; fullLanguage: number }>
  fullLanguageLimit: number
  perCaseLimit: number
}

const root = fileURLToPath(new URL('..', import.meta.url))
const budgetPath = new URL('./type-perf-budget.json', import.meta.url)
const budget = JSON.parse(readFileSync(budgetPath, 'utf8')) as PerfBudget

const expensiveCases = [
  ...new Set(
    Object.values(RESOLVED_INFERENCE_CAPABILITIES).flatMap(capability => [
      capability.expression,
      capability.composition,
    ])
  ),
]
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .slice(0, 5)

let failed = false
const measurements: PerfBudget['compilers'] = {}
for (const [compilerPackage, compilerBudget] of Object.entries(budget.compilers)) {
  const commonPath = measureProject(compilerPackage, 'tsconfig.perf.json')
  const fullLanguage = measureProject(compilerPackage, 'tsconfig.perf-full.json')
  const perCase = expensiveCases.map(expression => ({
    expression,
    instantiations: measureExpression(compilerPackage, expression),
  }))
  const worstCase = perCase.reduce((best, current) => (current.instantiations > best.instantiations ? current : best))
  measurements[compilerPackage] = { commonPath, fullLanguage }

  const commonLimit = Math.round(compilerBudget.commonPath * (1 + budget.tolerancePct / 100))
  const commonDelta = ((commonPath - compilerBudget.commonPath) / compilerBudget.commonPath) * 100
  const fullDelta = ((fullLanguage - compilerBudget.fullLanguage) / compilerBudget.fullLanguage) * 100
  const commonSummary = `${compilerPackage} common path: ${commonPath} instantiations (baseline ${compilerBudget.commonPath}, ${signed(commonDelta)}%, limit ${commonLimit})`
  const fullSummary = `${compilerPackage} full language: ${fullLanguage} instantiations (baseline ${compilerBudget.fullLanguage}, ${signed(fullDelta)}%, ceiling ${budget.fullLanguageLimit})`
  const caseSummary = `${compilerPackage} worst registered case: ${worstCase.instantiations} instantiations (ceiling ${budget.perCaseLimit}) — ${worstCase.expression}`

  if (process.argv.includes('--update')) {
    console.log(`${commonSummary} — baseline updated`)
    console.log(`${fullSummary} — baseline updated`)
    continue
  }

  failed = report(commonPath <= commonLimit, commonSummary) || failed
  failed = report(fullLanguage <= budget.fullLanguageLimit, fullSummary) || failed
  failed = report(worstCase.instantiations <= budget.perCaseLimit, caseSummary) || failed
}

if (process.argv.includes('--update')) {
  writeFileSync(budgetPath, `${JSON.stringify({ ...budget, compilers: measurements }, null, 2)}\n`)
} else if (failed) {
  process.exit(1)
}

function measureProject(compilerPackage: string, config: string): number {
  return instantiations(
    execFileSync(
      process.execPath,
      [`node_modules/${compilerPackage}/bin/tsc`, '-p', config, '--noEmit', '--extendedDiagnostics'],
      { cwd: root, encoding: 'utf8' }
    )
  )
}

function measureExpression(compilerPackage: string, expression: string): number {
  const directory = mkdtempSync(join(tmpdir(), 'fhirpath-type-perf-'))
  try {
    const fixture = join(directory, 'case.ts')
    const inferPath = `${root}/src/typed/infer.ts`
    writeFileSync(
      fixture,
      `import type { FhirpathResult } from ${JSON.stringify(inferPath)}\nexport type Result = FhirpathResult<${JSON.stringify(expression)}>\n`
    )
    return instantiations(
      execFileSync(
        process.execPath,
        [
          `${root}/node_modules/${compilerPackage}/bin/tsc`,
          '--noEmit',
          '--extendedDiagnostics',
          '--strict',
          '--skipLibCheck',
          '--target',
          'es2022',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--allowImportingTsExtensions',
          fixture,
        ],
        { cwd: root, encoding: 'utf8' }
      )
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function instantiations(output: string): number {
  const match = /^Instantiations:\s+(\d+)/m.exec(output)
  if (!match?.[1]) throw new Error(`Could not find an Instantiations line:\n${output}`)
  return Number(match[1])
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
}

function report(ok: boolean, summary: string): boolean {
  const log = ok ? console.log : console.error
  log(`${summary} — ${ok ? 'OK' : 'FAIL'}`)
  return !ok
}
