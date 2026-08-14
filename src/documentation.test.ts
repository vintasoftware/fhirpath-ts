import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { analyzeExpression, analyzeSite } from './analyzer/analyze.ts'
import { r4Model } from './r4/index.ts'
import { createSiteFinder, type ExpressionSite } from './sites/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

interface FenceExpectation {
  expressions: readonly string[]
  diagnostics?: {
    inputType: string
    codes: readonly string[]
  }
}

interface DocumentExpectation {
  path: string
  fences: readonly FenceExpectation[]
}

function valid(...expressions: string[]): FenceExpectation {
  return { expressions }
}

function invalid(inputType: string, codes: readonly string[], ...expressions: string[]): FenceExpectation {
  return { expressions, diagnostics: { inputType, codes } }
}

const documentation: readonly DocumentExpectation[] = [
  {
    path: 'README.md',
    fences: [
      valid('Patient.name.given', 'Patient.name.family', 'Patient.active = true', 'Patient.name.family'),
      valid('%threshold + 1'),
      invalid('Patient', ['unknown-element'], 'Patient.name.givenn'),
      valid('id', "name.where(use = 'official').first().family", 'name.given', 'active = true'),
      valid('(text | coding.display.first() | coding.first().code).first()', 'Condition.code.displayText()'),
      valid(
        'Patient.name.given',
        'Patient.name.family',
        'birthDate <= today()',
        "Observation.code.coding.exists(system = %loinc and code = '8480-6')",
        'Observation.sort(-(effective.ofType(dateTime) | issued).first())'
      ),
      valid('contact.all(name.exists() or telecom.exists())'),
      valid(
        "value.ofType(Quantity) > 140 'mm[Hg]'",
        "value.ofType(Quantity).convertsToQuantity('kg')",
        "Observation.value.ofType(Quantity).toQuantity('kg').value"
      ),
      valid('Condition.clinicalStatus.coding.first().code', 'Condition.clinicalStatus.coding.first().code'),
      valid('(%report.effective.ofType(dateTime) | %report.issued).first()', '%report.exists()'),
      valid('Bundle.entry.resource.ofType(Observation).subject.resolve().name.family'),
      valid('Questionnaire.repeat(item).linkId'),
      valid('birthDate <= today()', "Patient.name.trace('names').given"),
      valid('Patient.name.given'),
    ],
  },
  {
    path: 'docs/api.md',
    fences: [
      valid('Patient.name.given', 'Patient.name.family'),
      valid(),
      invalid('Patient', ['unknown-element'], 'Patient.name.givenn'),
      invalid('Patient', ['unknown-element', 'unknown-element'], 'Patient.name.givenn', 'Patient.name.givenn'),
      valid('Patient.name.given'),
      valid('Patient.name.family'),
      valid('active = true'),
      valid('birthDate < @1990-01-01'),
      valid('contact.all(name.exists() or telecom.exists())'),
      valid(
        'Patient.id',
        'Patient.name.family.first()',
        'Patient.name.given',
        'Patient.birthDate',
        'Patient.gender',
        'Patient.active = true'
      ),
      valid('Patient.name.given'),
      valid("(status in ('entered-in-error' | 'draft')).not()"),
      valid('Patient.name.given', 'Patient.name.given', 'Patient.name.given', 'Patient.name.given'),
      valid(),
      valid('%report.status'),
      valid('%threshold + 1'),
      valid('birthDate <= today()'),
      valid("name.trace('names').given"),
      valid(),
      valid('(text | coding.display.first() | coding.first().code).first()'),
      valid("status = 'final'"),
      valid(
        "value.ofType(Quantity).toQuantity('[lb_av]').value",
        '(effective.ofType(dateTime) | issued).first()',
        'note.text',
        "status = 'final'"
      ),
      valid('(text | coding.display.first() | coding.first().code).first()', 'Condition.code.displayText()'),
      valid('code.coding.where(system = %system).first().code'),
      valid('%reports.where(orderId = %context.id).report', '%report.status'),
      valid(),
      valid('$this is Patient'),
      valid(),
      valid('Patient.name.given', 'Bundle.entry.count()'),
      valid('Bundle.type'),
      valid(),
      valid('Patient.name'),
    ],
  },
  {
    path: 'docs/static-checking.md',
    fences: [
      invalid('Patient', ['unknown-element'], 'Patient.name.givenn'),
      valid('Patient.name.given'),
      valid(),
      valid('%reports.where(orderId = %context.id).report'),
      invalid('Patient', ['unknown-element'], 'name.givenn'),
      valid('%limit < value.count()'),
    ],
  },
  { path: 'docs/conformance.md', fences: [] },
  { path: 'docs/engine-comparison.md', fences: [] },
  { path: 'demo/README.md', fences: [valid('Patient.name.given')] },
]

const imports = `
import { FhirPathEngine, analyzeExpression, checkConstraints, column, compile, criteria, defineDto, evaluate, fhirpath } from 'fhirpath-ts'
import { r4 } from 'fhirpath-ts/r4'
`

const findExpressionSites = createSiteFinder(ts)

interface DocumentationSite extends ExpressionSite {
  fence: string
}

interface DocumentationFence {
  key: string
  language: string
  sites: DocumentationSite[]
  expected: FenceExpectation | undefined
}

function fencesInDocument(document: DocumentExpectation): DocumentationFence[] {
  const markdown = readFileSync(join(root, document.path), 'utf8')
  return [...markdown.matchAll(/```(ts(?:-invalid)?|js|javascript)\n([\s\S]*?)```/g)].map((match, index) => {
    const key = `${document.path} fence ${index + 1}`
    const sites = findExpressionSites(imports + match[2]!, `${document.path}:${index}.ts`).map(site => ({
      ...site,
      fence: key,
    }))
    return { key, language: match[1]!, sites, expected: document.fences[index] }
  })
}

describe('documentation examples', () => {
  const fences = documentation.flatMap(fencesInDocument)

  it('has an expectation for every documentation file and code fence', () => {
    const discovered = [
      'README.md',
      ...readdirSync(join(root, 'docs'), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => `docs/${entry.name}`),
      'demo/README.md',
    ].sort()
    expect(documentation.map(document => document.path).sort()).toEqual(discovered)

    for (const document of documentation) {
      const actual = fences.filter(fence => fence.key.startsWith(`${document.path} fence `))
      expect(actual, document.path).toHaveLength(document.fences.length)
      for (const fence of actual) {
        expect(fence.expected, fence.key).toBeDefined()
        expect(
          fence.sites.map(site => site.expression),
          fence.key
        ).toEqual(fence.expected!.expressions)
        expect(fence.language === 'ts-invalid', fence.key).toBe(fence.expected!.diagnostics !== undefined)
      }
    }
  })

  it('has an executable recipe case for every valid extracted expression', () => {
    const recipes = readFileSync(join(root, 'src/api/recipes.test.ts'), 'utf8')
    const tested = new Set(
      findExpressionSites(recipes, 'src/api/recipes.test.ts', { localImports: true }).map(site => site.expression)
    )
    const missing = fences
      .filter(fence => fence.expected?.diagnostics === undefined)
      .flatMap(fence => fence.sites.filter(site => !tested.has(site.expression)))
      .map(site => `${site.fence}: ${site.expression}`)
    expect(missing).toEqual([])
  })

  it('passes every valid extracted expression through the analyzer', () => {
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

    for (const fence of fences.filter(fence => fence.expected?.diagnostics === undefined)) {
      for (const site of fence.sites) {
        expect(
          analyzeSite(site, { model: r4Model, variables, functions }),
          `${site.fence}: ${site.expression}`
        ).toEqual([])
      }
    }
  })

  it('checks every invalid fence against its expected diagnostics', () => {
    for (const fence of fences.filter(fence => fence.expected?.diagnostics !== undefined)) {
      const diagnostic = fence.expected!.diagnostics!
      const codes = fence.sites.flatMap(site =>
        analyzeExpression(site.expression, { model: r4Model, inputType: diagnostic.inputType }).map(
          finding => finding.code
        )
      )
      expect(codes, fence.key).toEqual(diagnostic.codes)
    }
  })
})
