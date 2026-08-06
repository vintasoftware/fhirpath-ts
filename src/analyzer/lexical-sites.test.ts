import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { findLexicalExpressionSites, type LexicalExpressionSite } from './lexical-sites.ts'
import { findExpressionSites } from './reference-sites.ts'

/**
 * Every case runs through both walkers and must come out the same. The TypeScript
 * walker is the reference: when a case disagrees, the lexical walker is wrong.
 */
const CASES: Record<string, string> = {
  'expression-first calls': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.evaluate('Patient.name.given', patient)
    r4.evaluateTyped('Patient.birthDate', patient)
    r4.first('Patient.name.family', patient)
  `,
  'subject-first helpers take argument 1': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.test(patient, 'active = true')
    r4.filter(patients, 'birthDate < @1990-01-01')
  `,
  'project() columns': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(patients, { id: 'Patient.id', family: 'Patient.name.family.first()' })
  `,
  'project() columns with a path object': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, { given: { path: 'Patient.name.given', collection: true } })
  `,
  'project() test columns': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, { named: { test: 'Patient.name.exists()' }, id: { path: 'Patient.id', default: '' } })
  `,
  'checkConstraints() constraint arrays': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.checkConstraints(patient, [
      { key: 'pat-1', human: 'gender', expression: 'gender.exists()' },
      { key: 'pat-2', human: 'past', expression: 'birthDate < today()' },
    ])
  `,
  'the fhirpath tag': `
    import { fhirpath } from 'fhirpath-ts'
    const expr = fhirpath\`Patient.name.given\`
  `,
  'a tag with a substitution is dynamic': `
    import { fhirpath } from 'fhirpath-ts'
    const expr = fhirpath\`Patient.\${part}.given\`
  `,
  'a template literal argument': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.evaluate(\`Patient.name.given\`, patient)
  `,
  'bare analyzeExpression needs no receiver': `
    analyzeExpression('Observation.valueQuantity', { inputType: 'Observation' })
  `,
  'a foreign compile is skipped': `
    import Handlebars from 'handlebars'
    Handlebars.compile('{{name}}')
    compile('Patient.name')
  `,
  'a foreign named import shadows the tag': `
    import { fhirpath } from 'some-other-package'
    fhirpath\`Patient.name.given\`
  `,
  'an engine local is trusted': `
    import { FhirPathEngine } from 'fhirpath-ts'
    const engine = new FhirPathEngine({})
    engine.filter(rows, 'active = true')
  `,
  'a bare FhirPathEngine local is trusted without imports': `
    const engine = new FhirPathEngine({})
    engine.first('Patient.id', patient)
  `,
  'a non-engine local is not trusted': `
    const db = new Client({})
    db.first('column-name')
  `,
  'a parameter demotes engine trust for the file': `
    import { r4 } from 'fhirpath-ts/r4'
    function query(r4) {
      return r4.filter(rows, 'active = true')
    }
  `,
  'an arrow parameter demotes engine trust': `
    import { r4 } from 'fhirpath-ts/r4'
    const query = r4 => r4.filter(rows, 'active = true')
  `,
  'a destructured parameter demotes engine trust': `
    import { r4 } from 'fhirpath-ts/r4'
    const query = ({ r4 }) => r4.filter(rows, 'active = true')
  `,
  'a catch clause demotes engine trust': `
    import { r4 } from 'fhirpath-ts/r4'
    try {
      go()
    } catch (r4) {
      r4.filter(rows, 'active = true')
    }
  `,
  'a namespace import is trusted': `
    import * as api from 'fhirpath-ts/r4'
    api.first('Patient.id', patient)
  `,
  'a renamed import keeps the local name': `
    import { r4 as engine } from 'fhirpath-ts/r4'
    engine.first('Patient.id', patient)
  `,
  'a type-only import binds its name': `
    import type { QuantityValue } from 'fhirpath-ts'
    r4.evaluate('Patient.name', patient)
  `,
  'a default plus named import': `
    import def, { r4 } from 'fhirpath-ts/r4'
    r4.first('Patient.id', patient)
  `,
  'a side-effect import binds nothing': `
    import 'fhirpath-ts/r4'
    analyzeExpression('Patient.name')
  `,
  'this-rooted receivers are skipped': `
    import { r4 } from 'fhirpath-ts/r4'
    class Repo {
      run() {
        return this.engine.filter(rows, 'active = true')
      }
    }
  `,
  'an element-access receiver keeps its root': `
    import * as api from 'fhirpath-ts/r4'
    api[0].first('Patient.id', patient)
  `,
  'a call-result receiver is skipped': `
    import { make } from 'fhirpath-ts'
    make().first('Patient.id', patient)
  `,
  'optional chaining keeps the root': `
    import * as api from 'fhirpath-ts/r4'
    api?.first('Patient.id', patient)
  `,
  'comments never match': `
    // r4.evaluate('Patient.commented')
    /* analyzeExpression('Patient.blocked') */
    analyzeExpression('Patient.name')
  `,
  'strings inside regexes never match': `
    const quote = /['"]/g
    analyzeExpression('Patient.name')
  `,
  'division is not a regex': `
    const ratio = total / count / 2
    analyzeExpression('Patient.name')
  `,
  // No leading token at all, so the `/` can only be a regex.
  'a file may open with a regex': `/['"]/g.test(analyzeExpression('Patient.name'))`,
  'a trailing line comment needs no newline': `analyzeExpression('Patient.name') // done`,
  'a chain of optional accesses keeps the root': `
    import * as api from 'fhirpath-ts/r4'
    api?.inner?.first('Patient.id', patient)
  `,
  'a nested element-access receiver keeps the root': `
    import * as api from 'fhirpath-ts/r4'
    api[keys[0]].first('Patient.id', patient)
  `,
  'a string where columns are expected reads nothing': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, 'Patient.id')
  `,
  'DTO column and criteria fields': `
    import { column, criteria, defineDto } from 'fhirpath-ts'
    class ProblemRow extends defineDto('Condition') {
      @column('clinicalStatus.coding.first().code')
      statusCode!: string | undefined
      @column('code.text', { type: 'string', default: '' })
      name!: string
      @criteria('verificationStatus.coding.exists()')
      verified!: boolean
    }
  `,
  'DTO vars come off the defineDto options': `
    import { column, defineDto } from 'fhirpath-ts'
    class OrderRow extends defineDto('ServiceRequest', {
      env: { waiting: 'Waiting' },
      vars: { report: '%reports.first()', badge: 'status' },
    }) {
      @column('id')
      id!: string | undefined
    }
  `,
  'a DTO class extending a factory has no root': `
    import { column, defineDto } from 'fhirpath-ts'
    class LabRow extends badgedRow('DiagnosticReport') {
      @column('code.text')
      name!: string | undefined
    }
    class Plain extends defineDto('Observation') {
      @column('status')
      status!: string | undefined
    }
  `,
  'a column that is not the imported one is skipped': `
    import { defineDto } from 'fhirpath-ts'
    const column = (name: string) => name
    class Row extends defineDto('Observation') {
      @column('not.a.fhirpath.expression')
      value!: string
    }
  `,
  'a foreign column import is skipped': `
    import { column } from 'some-table-library'
    column('id')
  `,
  'columns calling other columns of the file': `
    import { column, defineDto } from 'fhirpath-ts'
    class ConceptDto extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first()).first()', { type: 'string' })
      displayText!: string | undefined
    }
    class WeightRow extends defineDto('Observation') {
      @column('code.displayText()', { type: 'string', default: '' })
      readonly name!: string
      @column('value.ofType(Quantity).value', { collection: true })
      values!: number[]
      @column('status', { choices: { final: 'Final' }, default: '' })
      label!: string
    }
  `,
  'a declared root on fhirpath and compile': `
    import { compile, fhirpath } from 'fhirpath-ts'
    const VISIBLE = fhirpath("(status in ('draft')).not()", 'MedicationRequest')
    const HEIGHT = compile('value.ofType(Quantity).value', 'Observation')
    const BARE = fhirpath('Patient.name.given')
  `,
  'a numeric column key keeps its value': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, { 1: 'Patient.id' })
  `,
  'a four-digit unicode escape must be hex': `
    analyzeExpression('Patient.name\\u00ZZgiven')
  `,
  'escapes are decoded': `
    analyzeExpression('Patient.name.where(use = \\'official\\')')
  `,
  'unicode escapes are decoded': `
    analyzeExpression('Patient.name\\u002Egiven')
  `,
  'an as-const argument is dynamic': `
    analyzeExpression('Patient.name' as const)
  `,
  'a variable argument is dynamic': `
    const expr = 'Patient.name'
    analyzeExpression(expr)
  `,
  'a concatenated argument is dynamic': `
    analyzeExpression('Patient.' + part)
  `,
  'a member call on a literal is dynamic': `
    analyzeExpression('Patient.name'.trim())
  `,
  'a ternary argument is dynamic': `
    analyzeExpression(wide ? 'Patient.name' : 'Patient.id')
  `,
  'a malformed unicode escape keeps the text': `
    analyzeExpression('a\\u{110000}b')
  `,
  'a malformed hex escape keeps the text': `
    analyzeExpression('a\\xZZb')
  `,
  'an unknown escape drops the backslash': `
    analyzeExpression('Patient.\\name')
  `,
  'a line continuation contributes nothing': `
    analyzeExpression('Patient.\\
name')
  `,
  'a spread column object is partly readable': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, { ...base, id: 'Patient.id' })
  `,
  'a computed column key keeps its value': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, { [key]: 'Patient.id' })
  `,
  'shorthand columns hold no literal': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.project(rows, { id })
  `,
  'nested calls each count': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.evaluate('Patient.name', r4.first('Patient.contained', patient))
  `,
  'a template with a nested quote stays dynamic': `
    import { r4 } from 'fhirpath-ts/r4'
    r4.evaluate(\`Patient.\${pick("name")}.given\`, patient)
  `,
  'object keys named like calls do not match': `
    const handlers = { evaluate: 'Patient.name', filter: 'Patient.id' }
  `,
  'no arguments at all': `
    analyzeExpression()
  `,
  'the samples the playground ships': `
    import { r4 } from 'fhirpath-ts/r4'
    import { analyzeExpression } from 'fhirpath-ts/analyzer'
    const patient = { resourceType: 'Patient' as const, birthDate: '1984-11-02' }
    console.log(r4.evaluate('Patient.name.given', patient))
    console.log(r4.first('Patient.name.family', patient))
    console.log(r4.evaluate("Patient.telecom.where(system = 'phone').value", patient))
    const adults = r4.filter([patient], 'birthDate < @1990-01-01')
    const rows = r4.project([patient], { id: 'Patient.id', name: "Patient.name.family" })
    const result = r4.checkConstraints(patient, [
      { key: 'pat-2', human: 'born in the past', expression: 'birthDate < today()' },
    ])
    analyzeExpression('Observation.valueQuantity', { inputType: 'Observation' })
  `,
}

/** Every `.ts`/`.js` file under `roots`, relative to `base`. */
function* sourceFiles(base: string, roots: readonly string[]): Generator<string> {
  for (const root of roots) {
    for (const entry of readdirSync(`${base}/${root}`, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        yield `${entry.parentPath}/${entry.name}`
      }
    }
  }
}

/**
 * The TypeScript walker's sites in the lexical walker's shape: same fields, same
 * order, so a JSON comparison covers the DTO context too (`dto`, `inputType`,
 * the file's declared column `functions`) and not just where the expressions are.
 */
function reference(source: string, fileName: string): LexicalExpressionSite[] {
  return findExpressionSites(source, fileName).map(site => ({
    expression: site.expression,
    start: site.start,
    ...(site.dto !== undefined && { dto: site.dto }),
    ...(site.inputType !== undefined && { inputType: site.inputType }),
    ...(site.functions !== undefined && { functions: site.functions }),
  }))
}

describe('findLexicalExpressionSites', () => {
  it.each(Object.entries(CASES))('matches the TypeScript walker: %s', (_name, source) => {
    expect(findLexicalExpressionSites(source)).toEqual(reference(source, 'case.ts'))
  })

  it('carries the DTO context: root from the class, none from a factory', () => {
    const source = `
      import { column, criteria, defineDto } from 'fhirpath-ts'
      class ProblemRow extends defineDto('Condition', { vars: { badge: 'clinicalStatus' } }) {
        @column('code.text')
        name!: string | undefined
        @criteria('recordedDate.exists()')
        recorded!: boolean
      }
      class LabRow extends badgedRow('DiagnosticReport') {
        @column('code.text')
        name!: string | undefined
      }
    `
    expect(findLexicalExpressionSites(source).map(site => [site.expression, site.inputType, site.dto])).toEqual([
      ['clinicalStatus', 'Condition', true],
      ['code.text', 'Condition', true],
      ['recordedDate.exists()', 'Condition', true],
      // Extending a factory: the site is found, but no fhirType is claimed for it.
      ['code.text', undefined, true],
    ])
  })

  it('declares one function per column field, typed from its options', () => {
    const source = `
      import { column, criteria, defineDto } from 'fhirpath-ts'
      class Row extends defineDto('CodeableConcept') {
        @column('text', { type: 'string' })
        displayText!: string | undefined
        @column('coding.count()', { type: 'integer' })
        readonly codingCount!: number | undefined
        @column('coding', { collection: true })
        codings!: unknown[]
        @column('text', { choices: { a: 'A' } })
        decoded!: string | undefined
        @criteria('text.exists()')
        named!: boolean
      }
    `
    const [site] = findLexicalExpressionSites(source)
    // A criteria declares no function: it stays projection-only.
    expect(site?.functions).toEqual({
      displayText: { minArity: 0, maxArity: 0, signature: { result: { types: ['string'], single: true } } },
      codingCount: { minArity: 0, maxArity: 0, signature: { result: { types: ['integer'], single: true } } },
      // A collection or a choices shaper leaves the result an unknown region
      // rather than a guessed one.
      codings: { minArity: 0, maxArity: 0 },
      decoded: { minArity: 0, maxArity: 0 },
    })
  })

  it('finds the field name past other decorators and modifiers', () => {
    const source = `
      import { column, defineDto } from 'fhirpath-ts'
      class Row extends defineDto('CodeableConcept') {
        @column('text', { type: 'string' })
        @deprecated
        @label('Display')
        readonly displayText!: string | undefined
      }
    `
    expect(findLexicalExpressionSites(source)[0]?.functions).toEqual({
      displayText: { minArity: 0, maxArity: 0, signature: { result: { types: ['string'], single: true } } },
    })
  })

  it('declares nothing when no field follows the decorator', () => {
    // A malformed buffer — what an editor sees mid-edit — must not throw or invent a name.
    const source =
      "import { column, defineDto } from 'fhirpath-ts'\nclass Row extends defineDto('Coding') { @column('code') }"
    expect(findLexicalExpressionSites(source)).toEqual([
      { expression: 'code', start: source.indexOf("'code'") + 1, dto: true, inputType: 'Coding' },
    ])
    const trailing =
      "import { column, defineDto } from 'fhirpath-ts'\nclass Row extends defineDto('Coding') { @column('code')"
    expect(findLexicalExpressionSites(trailing)).toHaveLength(1)
    const decoratorOnly =
      "import { column, defineDto } from 'fhirpath-ts'\nclass Row extends defineDto('Coding') { @column('code') @ }"
    expect(findLexicalExpressionSites(decoratorOnly)).toHaveLength(1)
  })

  it('carries a declared root, and does not read it as a DTO site', () => {
    const source = `
      import { compile, fhirpath } from 'fhirpath-ts'
      const VISIBLE = fhirpath("(status in ('draft')).not()", 'MedicationRequest')
      const HEIGHT = compile('value.ofType(Quantity).value', 'Observation')
      const BARE = fhirpath('Patient.name.given')
    `
    expect(findLexicalExpressionSites(source).map(site => [site.expression, site.inputType, site.dto])).toEqual([
      ["(status in ('draft')).not()", 'MedicationRequest', undefined],
      ['value.ofType(Quantity).value', 'Observation', undefined],
      // No second argument: no root, and nothing else changes.
      ['Patient.name.given', undefined, undefined],
    ])
  })

  it('reads relative imports as the API when localImports is on', () => {
    const source = `
      import { r4 } from '../r4/index.ts'
      r4.filter(rows, 'active = true')
    `
    expect(findLexicalExpressionSites(source)).toEqual([])
    expect(findLexicalExpressionSites(source, { localImports: true })).toEqual([
      { expression: 'active = true', start: source.indexOf('active = true') },
    ])
  })

  it('reads extra package prefixes as the API', () => {
    const source = `
      import { r4 } from '@acme/fhirpath'
      r4.filter(rows, 'active = true')
    `
    expect(findLexicalExpressionSites(source, { packages: ['@acme/fhirpath'] })).toEqual([
      { expression: 'active = true', start: source.indexOf('active = true') },
    ])
  })

  // The hand-written cases above cover the shapes on purpose; this covers the
  // shapes nobody thought of. Every .ts file in the package goes through both
  // walkers, so real code — generated models, tests full of odd literals, the
  // demo's own sources — has to agree too.
  //
  // Its own timeout: the reference walker parses the whole package with the
  // TypeScript compiler, which runs a few seconds normally and several times
  // that under coverage instrumentation.
  it('matches the TypeScript walker across the package source', { timeout: 60_000 }, () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const files = [...sourceFiles(root, ['src', 'demo/src', 'dogfood', 'scripts', 'benchmarks'])]
    expect(files.length).toBeGreaterThan(50)
    const disagreements = files.filter(file => {
      const source = readFileSync(file, 'utf8')
      return JSON.stringify(findLexicalExpressionSites(source)) !== JSON.stringify(reference(source, file))
    })
    expect(disagreements).toEqual([])
  })

  it('points start at the first character inside the quote', () => {
    const source = `analyzeExpression('Patient.name')`
    expect(findLexicalExpressionSites(source)).toEqual([
      { expression: 'Patient.name', start: source.indexOf('Patient.name') },
    ])
  })

  // A buffer being typed into an editor is malformed most of the time, so nothing
  // here may throw. What it returns for half-written code does not matter.
  it('survives truncated source', () => {
    for (const source of [
      `analyzeExpression('Patient.name`,
      `analyzeExpression(`,
      `analyzeExpression({ a: `,
      `analyzeExpression([`,
      `import { r4 } from `,
      `import { r4 }`,
      `const re = /unterminated`,
      `const re = /unterminated\nanalyzeExpression('Patient.name')`,
      'const t = `unterminated',
      'const t = `a${b',
      `analyzeExpression('a\\`,
      `analyzeExpression('a\\u{110`,
      `/* unterminated comment`,
      `api].first('Patient.id', patient)`,
    ]) {
      expect(() => findLexicalExpressionSites(source)).not.toThrow()
    }
  })
})
