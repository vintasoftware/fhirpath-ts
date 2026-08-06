import { describe, expect, it } from 'vitest'

import { findExpressionSites } from './reference-sites.ts'

// The reference walker's own suite. It is the oracle the lexical scanner is
// pinned to (see lexical-sites.test.ts), so its behaviour is spelled out here
// rather than left implicit in the parity comparison.

describe('expression site extraction', () => {
  it('finds tags and literal call arguments with positions', () => {
    const source = [
      "import { fhirpath, compile, evaluate } from 'fhirpath-ts'",
      'const a = fhirpath`Patient.name.given`',
      "const b = compile('Patient.birthDate')",
      "const c = evaluate('Patient.active', input)",
      "const d = api.evaluate('Patient.telecom.value', input)",
      'const dynamic = compile(someVariable)',
      'const template = fhirpath`Patient.$' + '{part}`',
    ].join('\n')
    const sites = findExpressionSites(source, 'sample.ts')
    expect(sites.map(site => site.expression)).toEqual([
      'Patient.name.given',
      'Patient.birthDate',
      'Patient.active',
      'Patient.telecom.value',
    ])
    expect(sites[0]?.line).toBe(2)
    expect(sites[1]?.line).toBe(3)
  })

  it('finds expressions in the subject-first engine helpers', () => {
    const source = [
      "import { r4 } from 'fhirpath-ts/r4'",
      "const active = r4.test(patient, 'active')",
      "const adults = r4.filter(patients, 'birthDate <= @2008-01-01')",
      "const typed = r4.evaluateTyped('Patient.birthDate', patient)",
      "const one = r4.first('Patient.name.family', patient)",
      'const rows = r4.project(patients, {',
      "  family: 'name.family.first()',",
      "  given: { path: 'name.given', collection: true },",
      "  quoted: { 'path': 'telecom.value' },",
      '  dynamic: someVariable,',
      '  [computed]: `name.$' + '{part}`,',
      "  [alsoComputed]: 'name.suffix',", // a computed key names the column; the value is still checkable
      '})',
      'const result = r4.checkConstraints(patient, [',
      "  { key: 'pat-1', expression: 'contact.name.exists()', human: 'contact needs a name' },",
      "  { key: 'dyn-1', expression: dynamicExpression },",
      '])',
    ].join('\n')
    const sites = findExpressionSites(source, 'sample.ts')
    expect(sites.map(site => site.expression)).toEqual([
      'active',
      'birthDate <= @2008-01-01',
      'Patient.birthDate',
      'Patient.name.family',
      'name.family.first()',
      'name.given',
      'telecom.value',
      'name.suffix',
      'contact.name.exists()',
    ])
    const projectSite = sites.find(site => site.expression === 'name.given')
    expect(projectSite?.line).toBe(8)
    const constraintSite = sites.find(site => site.expression === 'contact.name.exists()')
    expect(constraintSite?.line).toBe(15)
  })

  it('leaves non-literal helper arguments and non-object shapes alone', () => {
    const source = [
      "import { r4 } from 'fhirpath-ts/r4'", // r4 is a known engine, so only the argument shapes decide
      'const a = r4.test(patient)', // no expression argument at all
      'const b = r4.filter(patients, criteriaVariable)',
      'const c = r4.project(patients, columnsVariable)',
      'const d = r4.checkConstraints(patient, constraintsVariable)',
      'const e = r4.checkConstraints(patient, [constraintVariable, null, ...moreConstraints])',
      'const h = r4.project(patients, { ...spreadColumns, shorthand })',
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts')).toEqual([])
  })

  it('checks common-name helpers only on known engine receivers', () => {
    // test/filter/first/project exist only as engine methods and collide with
    // everyday APIs (knex .first(), lodash .filter(), regex .test()), so they
    // need a positive engine binding — not just "no foreign import".
    const skipped = [
      "import knex from 'knex'",
      'const db = knex({})',
      "const a = db.first('COUNT(*) as total')", // knex, receiver derived from a foreign import
      "const b = db.filter(rows, 'created_at > ?')",
      "const c = validator.test(input, 'some free text')", // untracked local receiver
      'const d = r4.filter(patients, someCriteria)',
      "const e = r4.test(patient, 'active')", // no fhirpath-ts import in this file: r4 is unknown
      'const f = items.filter(item => item.active)',
      "const g = this.engine.filter(patients, 'active')", // untracked alias: documented gap
    ].join('\n')
    expect(findExpressionSites(skipped, 'sample.ts')).toEqual([])

    const checked = [
      "import { FhirPathEngine } from 'fhirpath-ts'",
      'const engine = new FhirPathEngine({ model })',
      "const a = engine.filter(patients, 'birthDate <= @2008-01-01')",
      "const b = engine.first('Patient.name.family', patient)",
    ].join('\n')
    expect(findExpressionSites(checked, 'sample.ts').map(site => site.expression)).toEqual([
      'birthDate <= @2008-01-01',
      'Patient.name.family',
    ])
  })

  it('treats a new FhirPathEngine local as an engine even without imports, and after use', () => {
    const source = [
      "function isActive(patient) { return engine.test(patient, 'active') }", // use before declaration
      'const engine = new FhirPathEngine({ model })',
      'const other = new SomethingElse()',
      "const skipped = other.test(x, 'free text with spaces')",
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => site.expression)).toEqual(['active'])
  })

  it('demotes a trusted name the file re-binds, file-wide', () => {
    // Trust is name-based, not scope-based: a parameter named like a trusted
    // binding would otherwise have its free-text arguments read as FHIRPath.
    // Demotion prefers a missed check over a false positive on valid code.
    const shadowedImport = [
      "import { r4 } from 'fhirpath-ts/r4'",
      "function query(r4) { return r4.filter(rows, 'created_at > ?') }",
      "const alsoSkipped = r4.test(patient, 'active')", // module-scope use loses trust too
      "function g() { try {} catch (r4) { return r4.first('oops', y) } }",
    ].join('\n')
    expect(findExpressionSites(shadowedImport, 'sample.ts')).toEqual([])

    const shadowedEngineLocal = [
      "import { FhirPathEngine } from 'fhirpath-ts'",
      'function a() { const engine = new FhirPathEngine({}); return engine }',
      "function b(engine) { return engine.filter(rows, 'created_at > ?') }",
    ].join('\n')
    expect(findExpressionSites(shadowedEngineLocal, 'sample.ts')).toEqual([])
  })

  it('does not treat a foreign FhirPathEngine as an engine', () => {
    const source = [
      "import { FhirPathEngine } from 'some-other-fhirpath'",
      'const engine = new FhirPathEngine()',
      "const skipped = engine.test(x, 'not ours')",
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts')).toEqual([])
  })

  it('reads through side-effect imports and deep member callees', () => {
    const source = [
      "import './register-polyfill'", // no bindings to record
      "const a = app.engines.r4.evaluate('Patient.active', input)",
      "const b = getEngine().evaluate('Patient.gender', input)", // no identifier at the callee root
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => site.expression)).toEqual([
      'Patient.active',
      'Patient.gender',
    ])
  })

  it('skips call names imported from other modules', () => {
    const source = [
      "import { compile } from 'handlebars'",
      "import fhirpath from 'some-other-fhirpath'",
      "import _ from 'lodash'",
      "import { evaluate } from 'fhirpath-ts'",
      "const template = compile('not a [fhirpath] expression')",
      'const other = fhirpath`Patient.nope`',
      "const picked = _.filter(users, 'not a [fhirpath] expression')",
      "const checked = evaluate('Patient.active', input)",
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => site.expression)).toEqual(['Patient.active'])
  })
})

describe('extraction ignores computed callees', () => {
  it('skips calls whose callee has no name', () => {
    const sites = findExpressionSites("const x = arr[0]('Patient.name')", 'sample.ts')
    expect(sites).toEqual([])
  })
})

describe('DTO declarations', () => {
  const source = [
    "import { column, criteria, defineDto } from 'fhirpath-ts'",
    "class ProblemRow extends defineDto('Condition', { vars: { badge: 'clinicalStatus' } }) {",
    "  @column('code.text', { type: 'string', default: '' })",
    '  name!: string',
    "  @criteria('recordedDate.exists()')",
    '  recorded!: boolean',
    '}',
    "class LabRow extends badgedRow('DiagnosticReport') {",
    "  @column('code.text')",
    '  name!: string | undefined',
    '}',
  ].join('\n')

  it('finds column, criteria and vars expressions with the class fhirType', () => {
    expect(findExpressionSites(source, 'sample.ts').map(site => [site.expression, site.inputType, site.dto])).toEqual([
      ['clinicalStatus', 'Condition', true],
      ['code.text', 'Condition', true],
      ['recordedDate.exists()', 'Condition', true],
      // Extending a factory: found, but with no fhirType to analyze against.
      ['code.text', undefined, true],
    ])
  })

  it('declares a function per column field, and types it from the options', () => {
    const withCalls = [
      "import { column, defineDto } from 'fhirpath-ts'",
      "class ConceptDto extends defineDto('CodeableConcept') {",
      "  @column('text', { type: 'string' })",
      '  displayText!: string | undefined',
      '}',
      "class WeightRow extends defineDto('Observation') {",
      "  @column('code.displayText()', { type: 'string', default: '' })",
      '  name!: string',
      '}',
    ].join('\n')
    const string = { minArity: 0, maxArity: 0, signature: { result: { types: ['string'], single: true } } }
    const sites = findExpressionSites(withCalls, 'sample.ts')
    // Every site of the file carries the file's whole column vocabulary.
    expect(sites.map(site => site.functions)).toEqual([
      { displayText: string, name: string },
      { displayText: string, name: string },
    ])
  })

  it('skips a column that is not the package export', () => {
    const local = ['const column = (name: string) => name', "column('not.a.fhirpath.expression')"].join('\n')
    expect(findExpressionSites(local, 'sample.ts')).toEqual([])
  })
})
