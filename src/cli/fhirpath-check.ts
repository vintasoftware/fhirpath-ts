#!/usr/bin/env node
/**
 * Static FHIRPath checking for a codebase: scans the given TypeScript/JavaScript
 * files for FHIRPath expression literals and runs the spec §11 analyzer over
 * each with the R4 model. Which call sites carry expressions, and which are
 * skipped, is the shared policy's decision — see src/analyzer/expression-policy.ts.
 * Exits non-zero when any diagnostic is found. It is the standalone equivalent of
 * the ./eslint rule, for repos that do not lint with ESLint (e.g. Biome repos).
 * This repo itself dogfoods the ./eslint rule, so its own CI enforces the checks
 * through `pnpm lint`.
 *
 * Sites come from the `typescript`-free scanner (analyzer/lexical-sites.ts), the
 * same walker editors and bundler plugins use, so this command stays dependency-
 * light and there is one static walker to maintain besides the ESLint rule's.
 * analyzer/reference-sites.ts keeps the scanner honest as a test oracle.
 *
 * Usage: fhirpath-check <file...>
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts */
import { readFileSync } from 'node:fs'

import { analyzeSite } from '../analyzer/analyze.ts'
import { findLexicalExpressionSites } from '../analyzer/lexical-sites.ts'
import { r4Model } from '../r4/index.ts'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: fhirpath-check <file...>')
  process.exit(2)
}

/** 1-based line and column of `offset` in `text`. */
function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\n') {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
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
  for (const site of findLexicalExpressionSites(text)) {
    const diagnostics = analyzeSite(site, { model: r4Model })
    if (diagnostics.length === 0) {
      continue
    }
    const start = positionAt(text, site.start)
    for (const diagnostic of diagnostics) {
      // Warnings print but only errors fail the run.
      if (diagnostic.severity === 'error') {
        failures += 1
      }
      const line = start.line + (diagnostic.span.line - 1)
      const column = diagnostic.span.line === 1 ? start.column + diagnostic.span.column - 1 : diagnostic.span.column
      console.error(
        `${file}:${line}:${column} [${diagnostic.severity === 'warning' ? 'warning:' : ''}${diagnostic.code}] ${diagnostic.message}`
      )
    }
  }
}

if (failures > 0) {
  console.error(`fhirpath-check: ${failures} problem(s) found`)
  process.exit(1)
}
console.log('fhirpath-check: no problems found')
