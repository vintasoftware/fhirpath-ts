#!/usr/bin/env node
/**
 * Checks source literals with the TypeScript site finder, then imports DTO
 * modules for checks that need their engine context. Errors produce a non-zero
 * exit status. Use `--no-import` for source only and `--dtos` to change the DTO
 * module glob.
 *
 * Usage: fhirpath-check [--dtos <glob>]... [--no-import] <file...>
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts */
import { readFileSync } from 'node:fs'

import ts from 'typescript'

import { analyzeSite } from '../analyzer/analyze.ts'
import { r4Model } from '../r4/index.ts'
import { createSiteFinder, type ExpressionSite } from '../sites/index.ts'
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

/**
 * Where a diagnostic falls in the file, given the site its expression came from.
 * A span's own line/column are relative to the expression text, so only a
 * first-line column is an offset from the site's; a later line starts at its own
 * column 1.
 */
function positionIn(site: { line: number; column: number }, span: { line: number; column: number }): string {
  const line = site.line + (span.line - 1)
  const column = span.line === 1 ? site.column + span.column - 1 : span.column
  return `${line}:${column}`
}

/** Expression sites cached so each source file is read once. */
const sitesByFile = new Map<string, ExpressionSite[]>()

function sitesOf(file: string): ExpressionSite[] {
  const cached = sitesByFile.get(file)
  if (cached !== undefined) {
    return cached
  }
  const sites = findExpressionSites(readFileSync(file, 'utf8'), file)
  sitesByFile.set(file, sites)
  return sites
}

// Check source literals first.
for (const file of args.files) {
  let sites: ExpressionSite[]
  try {
    sites = sitesOf(file)
  } catch (error) {
    console.error(`fhirpath-check: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  for (const site of sites) {
    for (const diagnostic of analyzeSite(site, { model: r4Model })) {
      report(`${file}:${positionIn(site, diagnostic.span)}`, diagnostic)
    }
  }
}

/**
 * A DTO finding's position in source: `analyzeDto` knows the member and the
 * expression, and the site finder knows where each expression literal sits, so
 * the expression text joins the two. Identical expressions in one file share the
 * first match — a cosmetic tie, not a wrong finding. A file that cannot be read,
 * or an expression with no literal to point at (one built at runtime), degrades
 * to naming the member.
 */
function locate(finding: DtoFinding): string {
  const member = `${finding.dto}.${finding.member}`
  let site: ExpressionSite | undefined
  try {
    site = sitesOf(finding.file).find(candidate => candidate.expression === finding.expression)
  } catch {
    return `${finding.file} ${member}`
  }
  return site === undefined
    ? `${finding.file} ${member}`
    : `${finding.file}:${positionIn(site, finding.span)} ${member}`
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
