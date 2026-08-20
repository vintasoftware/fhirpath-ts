#!/usr/bin/env node
/**
 * Checks source literals with the TypeScript site finder, then imports DTO
 * modules for checks that need their engine context. Errors produce a non-zero
 * exit status. Use `--no-import` for source only and `--dtos` to change the DTO
 * module glob.
 *
 * Usage: fhirpath-check [--dtos <glob>]... [--no-import] [--local-imports] [--strict] <file...>
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { analyzeSite } from '../analyzer/analyze.ts'
import { r4Model } from '../r4/index.ts'
import { createSiteScanner, type ExpressionSite, type SiteScanResult } from '../sites/index.ts'
import { checkDtoModules, DEFAULT_DTO_GLOB, type DtoCheckResult, type DtoFinding } from './dto-check.ts'

interface Args {
  files: string[]
  dtoGlobs: string[]
  imports: boolean
  localImports: boolean
  strict: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { files: [], dtoGlobs: [], imports: true, localImports: false, strict: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--no-import') {
      args.imports = false
    } else if (arg === '--local-imports') {
      args.localImports = true
    } else if (arg === '--strict') {
      args.strict = true
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
  console.error('usage: fhirpath-check [--dtos <glob>]... [--no-import] [--local-imports] [--strict] <file...>')
  process.exit(2)
}
const dtoGlobs = args.dtoGlobs.length > 0 ? args.dtoGlobs : [DEFAULT_DTO_GLOB]

/** A type-aware program lets the site finder follow imported and aliased engine receivers. */
function sourceProgram(files: readonly string[]): ts.Program | undefined {
  if (files.length === 0) {
    return undefined
  }
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists)
  let options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  }
  if (configPath !== undefined) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error === undefined) {
      options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options
    }
  }
  return ts.createProgram({ rootNames: files.map(file => resolve(file)), options })
}

let scanExpressionSites = createSiteScanner(ts)

let failures = 0
let warnings = 0

function report(location: string, diagnostic: { severity: 'error' | 'warning'; code: string; message: string }): void {
  const severity = args.strict && diagnostic.severity === 'warning' ? 'error' : diagnostic.severity
  if (severity === 'error') {
    failures += 1
  } else {
    warnings += 1
  }
  const prefix = severity === 'warning' ? 'warning:' : ''
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

/** Source scans cached so each file is read once. */
const scansByFile = new Map<string, SiteScanResult>()

function scanOf(file: string): SiteScanResult {
  const cached = scansByFile.get(file)
  if (cached !== undefined) {
    return cached
  }
  const scan = scanExpressionSites(readFileSync(file, 'utf8'), resolve(file), {
    ...(args.localImports && { localImports: true }),
  })
  scansByFile.set(file, scan)
  return scan
}

function sitesOf(file: string): ExpressionSite[] {
  return scanOf(file).sites
}

// Extract source sites before executing project modules. Analysis waits until
// after the import pass so those sites can use the engines' real environment.
for (const file of args.files) {
  try {
    scanOf(file)
  } catch (error) {
    console.error(`fhirpath-check: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
if (
  !args.localImports &&
  [...scansByFile.values()].some(scan => scan.skipped.some(skipped => skipped.reason === 'unrecognized-receiver'))
) {
  // Pay the Program/TypeChecker cost only when the syntax-only pass found a
  // receiver it could not prove. Most source files need no compiler graph.
  scanExpressionSites = createSiteScanner(ts, sourceProgram(args.files))
  scansByFile.clear()
  for (const file of args.files) {
    scanOf(file)
  }
}

let dtoResult: DtoCheckResult | undefined
if (args.imports) {
  try {
    dtoResult = await checkDtoModules(dtoGlobs, process.cwd())
  } catch (error) {
    console.error(
      `fhirpath-check: cannot import DTO modules (${dtoGlobs.join(', ')}): ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(2)
  }
}

// Check source literals first.
for (const file of args.files) {
  const sites = sitesOf(file)
  for (const site of sites) {
    for (const diagnostic of analyzeSite(site, {
      model: r4Model,
      ...dtoResult?.sourceOptions,
      reportUnchecked: true,
    })) {
      report(`${file}:${positionIn(site, diagnostic.span)}`, diagnostic)
    }
  }
  for (const skipped of scanOf(file).skipped) {
    report(`${file}:${skipped.line}:${skipped.column}`, {
      severity: 'warning',
      code: 'skipped',
      message: skipped.message,
    })
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
if (dtoResult !== undefined) {
  const result = dtoResult
  for (const file of result.files) {
    let scan: SiteScanResult
    try {
      scan = scanOf(file)
    } catch {
      continue
    }
    for (const dto of scan.dtoDeclarations) {
      if (!dto.loadable) {
        report(`${file}:${dto.line}:${dto.column}`, {
          severity: 'warning',
          code: 'unloaded-dto',
          message: `DTO ${dto.name} is module-local and was not loaded for full analysis; export it or an extending class`,
        })
      }
    }
  }
  for (const finding of result.findings) {
    // With no engine in reach, an unresolved column call is unresolvable rather
    // than wrong, so it is reported without failing the run.
    const unresolvable = result.engines === 0 && finding.code === 'unknown-function'
    const reported = unresolvable ? { ...finding, severity: 'warning' as const } : finding
    report(locate(finding), reported)
  }
  if (result.files.length === 0) {
    console.error(
      `fhirpath-check: no DTO modules matched ${dtoGlobs.join(', ')} — DTOs live in *.dto.ts, or pass --dtos <glob>`
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
console.log(
  warnings > 0 ? `fhirpath-check: ${warnings} warning(s), no errors found` : 'fhirpath-check: no problems found'
)
