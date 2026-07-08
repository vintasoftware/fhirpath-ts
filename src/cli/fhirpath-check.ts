#!/usr/bin/env node
/**
 * Static FHIRPath checking for a codebase: scans the given TypeScript/JavaScript
 * files for FHIRPath expression literals and runs the spec §11 analyzer over
 * each with the R4 model. Which call sites carry expressions, and which are
 * skipped, is the shared policy's decision — see src/analyzer/expression-policy.ts.
 * Exits non-zero when any diagnostic is found. This repo lints with Biome, so
 * this CLI is how CI enforces the checks; ESLint users can use the ./eslint
 * export instead.
 *
 * Usage: fhirpath-check <file...>
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts */
/** biome-ignore-all lint/suspicious/noConsole: a CLI reports through the console */
import { readFileSync } from 'node:fs'
import { analyzeExpression } from '../analyzer/analyze.ts'
import { r4Model } from '../r4/index.ts'
import { findExpressionSites } from './expression-sites.ts'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: fhirpath-check <file...>')
  process.exit(2)
}

let failures = 0
for (const file of files) {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    console.error(`fhirpath-check: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  for (const site of findExpressionSites(text, file)) {
    for (const diagnostic of analyzeExpression(site.expression, { model: r4Model })) {
      failures += 1
      const line = site.line + (diagnostic.span.line - 1)
      const column = diagnostic.span.line === 1 ? site.column + diagnostic.span.column - 1 : diagnostic.span.column
      console.error(`${file}:${line}:${column} [${diagnostic.code}] ${diagnostic.message}`)
    }
  }
}

if (failures > 0) {
  console.error(`fhirpath-check: ${failures} problem(s) found`)
  process.exit(1)
}
console.log('fhirpath-check: no problems found')
