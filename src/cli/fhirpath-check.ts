#!/usr/bin/env node
/**
 * Static FHIRPath checking for a codebase, in two halves:
 *
 * 1. Every FHIRPath expression literal in the given files, analyzed with the R4
 *    model. Which call sites carry expressions, and which are skipped, is the
 *    shared policy's decision — see src/analyzer/expression-policy.ts. Sites come
 *    from `fhirpath-ts/sites`, the shared TypeScript-AST walker, with the
 *    `typescript` package (an optional peer dependency, and this command's one
 *    requirement beyond Node) supplying the compiler.
 *
 * 2. Every DTO in the project's `*.dto.ts` modules, *imported* and analyzed
 *    against the engine that projects it (see dto-check.ts) — the exhaustive
 *    check, with the engine's real functions and env, where the first half has to
 *    hedge. `--no-import` skips it; `--dtos <glob>` points it elsewhere.
 *
 * Exits non-zero when any error-severity diagnostic is found, so it drops into a
 * CI job or a pre-commit hook. It is the standalone equivalent of the ./eslint
 * rule, for repos that do not lint with ESLint (e.g. Biome repos). This repo
 * itself dogfoods the ./eslint rule, so its own CI enforces the first half
 * through `pnpm lint`.
 *
 * Usage: fhirpath-check [--dtos <glob>]... [--no-import] <file...>
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts */
import { readFileSync } from 'node:fs'

import ts from 'typescript'

import { analyzeSite } from '../analyzer/analyze.ts'
import { r4Model } from '../r4/index.ts'
import { createSiteFinder } from '../sites/index.ts'
import { checkDtoModules, DEFAULT_DTO_GLOB, type DtoFinding } from './dto-check.ts'

const findExpressionSites = createSiteFinder(ts)

interface Args {
  files: string[]
  dtoGlobs: string[]
  imports: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { files: [], dtoGlobs: [], imports: true }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--no-import') {
      args.imports = false
    } else if (arg === '--dtos') {
      const glob = argv[++index]
      if (glob === undefined) {
        console.error('fhirpath-check: --dtos needs a glob')
        process.exit(2)
      }
      args.dtoGlobs.push(glob)
    } else {
      args.files.push(arg)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.files.length === 0 && !args.imports) {
  console.error('usage: fhirpath-check [--dtos <glob>]... [--no-import] <file...>')
  process.exit(2)
}

let failures = 0

function report(location: string, diagnostic: { severity: string; code: string; message: string }): void {
  if (diagnostic.severity === 'error') {
    failures += 1
  }
  const prefix = diagnostic.severity === 'warning' ? 'warning:' : ''
  console.error(`${location} [${prefix}${diagnostic.code}] ${diagnostic.message}`)
}

// --- 1. expression literals in the given files ---
for (const file of args.files) {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    console.error(`fhirpath-check: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  for (const site of findExpressionSites(text, file)) {
    for (const diagnostic of analyzeSite(site, { model: r4Model })) {
      const line = site.line + (diagnostic.span.line - 1)
      const column = diagnostic.span.line === 1 ? site.column + diagnostic.span.column - 1 : diagnostic.span.column
      report(`${file}:${line}:${column}`, diagnostic)
    }
  }
}

/**
 * A DTO finding's position in source: `analyzeDto` knows the member and the
 * expression, and the scanner knows where each expression literal sits, so the
 * expression text joins the two. Identical expressions in one file share the
 * first match — a cosmetic tie, not a wrong finding.
 */
function locate(finding: DtoFinding): string {
  let text: string
  try {
    text = readFileSync(finding.file, 'utf8')
  } catch {
    return `${finding.file} ${finding.dto}.${finding.member}`
  }
  const site = findExpressionSites(text, finding.file).find(candidate => candidate.expression === finding.expression)
  if (site === undefined) {
    return `${finding.file} ${finding.dto}.${finding.member}`
  }
  const line = site.line + (finding.span.line - 1)
  const column = finding.span.line === 1 ? site.column + finding.span.column - 1 : finding.span.column
  return `${finding.file}:${line}:${column} ${finding.dto}.${finding.member}`
}

// --- 2. the project's DTO modules, imported ---
if (args.imports) {
  const globs = args.dtoGlobs.length > 0 ? args.dtoGlobs : [DEFAULT_DTO_GLOB]
  let result
  try {
    result = await checkDtoModules(globs, process.cwd())
  } catch (error) {
    console.error(
      `fhirpath-check: cannot import DTO modules (${globs.join(', ')}): ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(2)
  }
  for (const finding of result.findings) {
    // With no engine in reach, an unresolved column call is unresolvable rather
    // than wrong, so it is reported without failing the run.
    const unresolvable = result.engines === 0 && finding.code === 'unknown-function'
    report(locate(finding), unresolvable ? { ...finding, severity: 'warning' } : finding)
  }
  if (result.files.length === 0) {
    console.error(
      `fhirpath-check: no DTO modules matched ${globs.join(', ')} — DTOs live in *.dto.ts, or pass --dtos <glob>`
    )
  } else if (result.dtos.length === 0) {
    console.error(`fhirpath-check: ${result.files.length} DTO module(s) matched but export no DTO class`)
  } else if (result.engines === 0) {
    // Without an engine, a call into another DTO's column cannot resolve, so the
    // DTO half would report valid code. Say so instead of failing the run.
    console.error(
      'fhirpath-check: no engine was constructed by the imported modules — column function calls cannot be resolved; ' +
        'point --dtos at the module that builds your FhirPathEngine'
    )
  } else {
    console.log(
      `fhirpath-check: analyzed ${result.dtos.length} DTO(s) from ${result.files.length} module(s) against ${result.engines} engine(s)`
    )
  }
}

if (failures > 0) {
  console.error(`fhirpath-check: ${failures} problem(s) found`)
  process.exit(1)
}
console.log('fhirpath-check: no problems found')
