import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { analyzeSite } from './analyzer/analyze.ts'
import { r4Model } from './r4/index.ts'
import { createSiteFinder, type ExpressionSite } from './sites/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const documentation = [
  'README.md',
  'docs/api.md',
  'docs/static-checking.md',
  'docs/conformance.md',
  'docs/engine-comparison.md',
  'demo/README.md',
]

const imports = `
import { FhirPathEngine, analyzeExpression, checkConstraints, column, compile, criteria, defineDto, evaluate, fhirpath } from 'fhirpath-ts'
import { r4 } from 'fhirpath-ts/r4'
`

const findExpressionSites = createSiteFinder(ts)

interface DocumentationSite extends ExpressionSite {
  document: string
}

function sitesInDocument(document: string): DocumentationSite[] {
  const markdown = readFileSync(join(root, document), 'utf8')
  return [...markdown.matchAll(/```(?:ts|js|javascript)\n([\s\S]*?)```/g)].flatMap((match, index) =>
    findExpressionSites(imports + match[1]!, `${document}:${index}.ts`).map(site => ({ ...site, document }))
  )
}

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return testFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('documentation examples', () => {
  const sites = documentation.flatMap(sitesInDocument)

  it('extracts expressions from every document with TypeScript examples', () => {
    for (const document of documentation) {
      const markdown = readFileSync(join(root, document), 'utf8')
      if (/```(?:ts|js|javascript)\n/.test(markdown)) {
        expect(
          sites.some(site => site.document === document),
          document
        ).toBe(true)
      }
    }
  })

  it('runs every extracted expression in the test suite', () => {
    const tested = new Set(
      [...testFiles(join(root, 'src')), ...testFiles(join(root, 'dogfood'))]
        .filter(path => path !== fileURLToPath(import.meta.url))
        .flatMap(path =>
          findExpressionSites(readFileSync(path, 'utf8'), path, { localImports: true }).map(site => site.expression)
        )
    )

    for (const site of sites) {
      expect(
        tested.has(site.expression),
        `${site.document}: expression is not exercised by a test: ${site.expression}`
      ).toBe(true)
    }
  })

  it('passes every extracted expression through the analyzer', () => {
    const variables = {
      limit: { types: ['System.Integer'], single: true },
      loinc: { types: ['System.String'], single: true },
      pharmacyUrl: { types: ['System.String'], single: true },
      report: {},
      reports: {},
      rowIndex: { types: ['System.Integer'], single: true },
      rowTotal: { types: ['System.Integer'], single: true },
      system: { types: ['System.String'], single: true },
      threshold: { types: ['System.Integer'], single: true },
      weight: {},
    }
    const functions = {
      displayText: {
        expression: '(text | coding.display.first() | coding.first().code).first()',
      },
    }

    for (const site of sites) {
      expect(
        analyzeSite(site, { model: r4Model, variables, functions }),
        `${site.document}: ${site.expression}`
      ).toEqual([])
    }
  })
})
