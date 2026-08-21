import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createSiteFinder, createSiteScanner } from './index.ts'

const findExpressionSites = createSiteFinder(ts)

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

  it('finds ordered vars in every call that accepts EvaluateOptions', () => {
    const source = [
      "import { r4 } from 'fhirpath-ts/r4'",
      "r4.evaluate('%a', patient, { vars: { a: 'Patient.name' } })",
      "r4.evaluateTyped('%b', patient, { vars: { b: 'Patient.birthDate' } })",
      "r4.first('%c', patient, { vars: { c: 'Patient.gender' } })",
      "r4.test(patient, '%d.exists()', { vars: { d: 'Patient.active' } })",
      "r4.filter(patients, '%e.exists()', { vars: { e: 'Patient.telecom' } })",
      "r4.project(patients, { id: '%f' }, { vars: { f: 'Patient.id' } })",
      "r4.checkConstraints(patient, [{ key: 'x', expression: '%g.exists()' }], { vars: { g: 'Patient.contact' } })",
    ].join('\n')

    expect(findExpressionSites(source, 'sample.ts').map(site => site.expression)).toEqual([
      '%a',
      'Patient.name',
      '%b',
      'Patient.birthDate',
      '%c',
      'Patient.gender',
      '%d.exists()',
      'Patient.active',
      '%e.exists()',
      'Patient.telecom',
      '%f',
      'Patient.id',
      '%g.exists()',
      'Patient.contact',
    ])
  })

  it('marks sites whose call binds variable names the source cannot list', () => {
    const source = [
      "import { r4 } from 'fhirpath-ts/r4'",
      "r4.evaluate('%a', patient, { env: { [key]: 1 } })",
      "r4.evaluate('%b', patient, { env: { plain: 1 } })",
      "r4.evaluate('%c', patient, someOptions)",
    ].join('\n')
    const sites = findExpressionSites(source, 'sample.ts')
    expect(sites.map(site => [site.expression, site.openVariables])).toEqual([
      ['%a', true],
      ['%b', undefined],
      ['%c', true],
    ])
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
    // Each column declares the type it was written against, so a call on the
    // wrong focus is checkable, plus what it yields.
    const stringOn = (host: string) => ({
      minArity: 0,
      maxArity: 0,
      signature: { input: { types: [host] }, result: { types: ['string'], single: true } },
    })
    const sites = findExpressionSites(withCalls, 'sample.ts')
    const vocabulary = { displayText: stringOn('CodeableConcept'), name: stringOn('Observation') }
    // Every site of the file carries the file's whole column vocabulary.
    expect(sites.map(site => site.functions)).toEqual([vocabulary, vocabulary])
  })

  it('reads the cardinality of a collection column, and declines to guess a dynamic one', () => {
    const source = [
      "import { column, defineDto } from 'fhirpath-ts'",
      "class Row extends defineDto('Patient') {",
      "  @column('name.given', { type: 'string', collection: true })",
      '  given!: string[]',
      "  @column('name.family', { type: 'string', collection: false })",
      '  family!: string | undefined',
      "  @column('telecom.value', { type: 'string', collection: dynamic })",
      '  contacts!: string[]',
      '}',
    ].join('\n')
    const input = { types: ['Patient'] }
    expect(findExpressionSites(source, 'sample.ts')[0]?.functions).toEqual({
      given: { minArity: 0, maxArity: 0, signature: { input, result: { types: ['string'], single: false } } },
      family: { minArity: 0, maxArity: 0, signature: { input, result: { types: ['string'], single: true } } },
      // Cardinality not in the syntax, so no result at all rather than a guessed
      // one; the input the class fixes is known either way.
      contacts: { minArity: 0, maxArity: 0, signature: { input } },
    })
  })

  it('reads a tag by the name it is reached through, so a foreign namespace is not ours', () => {
    // A tag is gated on its receiver exactly as a call is: `hb.fhirpath` under a
    // handlebars namespace import is somebody else's tag, and reporting its
    // contents as invalid FHIRPath would be the worst kind of miss.
    const foreign = ["import * as hb from 'handlebars'", 'const q = hb.fhirpath`Patient.name.given`'].join('\n')
    expect(findExpressionSites(foreign, 'sample.ts')).toEqual([])
    const ours = ["import * as api from 'fhirpath-ts'", 'const q = api.fhirpath`Patient.name.given`'].join('\n')
    expect(findExpressionSites(ours, 'sample.ts').map(site => site.expression)).toEqual(['Patient.name.given'])
    // No imports at all: a distinctive name stays checkable.
    expect(findExpressionSites('const q = fhirpath`Patient.name.given`', 'sample.ts')).toHaveLength(1)
  })

  it('skips a column that is not the package export', () => {
    const local = ['const column = (name: string) => name', "column('not.a.fhirpath.expression')"].join('\n')
    expect(findExpressionSites(local, 'sample.ts')).toEqual([])
  })

  it('follows a DTO root through a base class the same file declares', () => {
    const source = [
      "import { column, defineDto } from 'fhirpath-ts'",
      "class ObservationRow extends defineDto('Observation') {",
      "  @column('issued') at!: string | undefined",
      '}',
      'class WeightRow extends ObservationRow {',
      "  @column('value.ofType(Quantity).value') kg!: unknown",
      '}',
      'class Deeper extends WeightRow {',
      "  @column('status') state!: string | undefined",
      '}',
      // A factory call is not a name this file declares, so it stays rootless.
      "class LabRow extends badgedRow('DiagnosticReport') {",
      "  @column('code.text') name!: string | undefined",
      '}',
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => [site.expression, site.inputType])).toEqual([
      ['issued', 'Observation'],
      ['value.ofType(Quantity).value', 'Observation'],
      ['status', 'Observation'],
      ['code.text', undefined],
    ])
  })

  it('does not guess a root for a class name the file declares twice', () => {
    // Two scopes, two different classes, one name: inheriting the wrong root would
    // report valid code, so the chain drops the name. A class's own clause is
    // unaffected.
    const source = [
      "import { column, defineDto } from 'fhirpath-ts'",
      "function a() { class Row extends defineDto('Observation') { @column('issued') at!: unknown } return Row }",
      "function b() { class Row extends defineDto('Condition') { @column('recordedDate') at!: unknown } return Row }",
      'class Sub extends Row {',
      "  @column('whatever') x!: unknown",
      '}',
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => [site.expression, site.inputType])).toEqual([
      ['issued', 'Observation'],
      ['recordedDate', 'Condition'],
      ['whatever', undefined],
    ])
  })

  it('does not loop on a cyclic extends chain', () => {
    const source = [
      "import { column } from 'fhirpath-ts'",
      "class A extends B { @column('issued') at!: unknown }",
      'class B extends A {}',
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => site.inputType)).toEqual([undefined])
  })
})

describe('DTO export reachability', () => {
  const scan = createSiteScanner(ts)
  const loadableOf = (code: string): Record<string, boolean> =>
    Object.fromEntries(scan(code, 'sample.ts').dtoDeclarations.map(dto => [dto.name, dto.loadable]))
  const dto = [
    "import { column, defineDto } from 'fhirpath-ts'",
    "class ProblemRow extends defineDto('Condition') {",
    "  @column('code.text') name!: string | undefined",
    '}',
  ]

  it('reads a DTO reached through an exported const binding as loadable', () => {
    expect(loadableOf([...dto, 'export const Row = ProblemRow'].join('\n'))).toEqual({ ProblemRow: true })
    expect(loadableOf([...dto, 'export const Row = ProblemRow as unknown'].join('\n'))).toEqual({ ProblemRow: true })
    expect(loadableOf([...dto, 'const Alias = ProblemRow', 'export { Alias }'].join('\n'))).toEqual({
      ProblemRow: true,
    })
    expect(
      loadableOf([...dto, 'const Alias = ProblemRow', 'const Out = Alias', 'export default Out'].join('\n'))
    ).toEqual({ ProblemRow: true })
  })

  it('reads a DTO reached through an exported subclass expression as loadable', () => {
    expect(loadableOf([...dto, 'export const Row = class extends ProblemRow {}'].join('\n'))).toEqual({
      ProblemRow: true,
    })
    expect(loadableOf([...dto, 'export default class extends ProblemRow {}'].join('\n'))).toEqual({
      ProblemRow: true,
    })
  })

  it('still reads a genuinely module-private DTO as unloadable', () => {
    expect(loadableOf(dto.join('\n'))).toEqual({ ProblemRow: false })
    // A local alias that never reaches an export does not make it loadable.
    expect(loadableOf([...dto, 'const Private = ProblemRow'].join('\n'))).toEqual({ ProblemRow: false })
  })
})

describe('DTO context and declared roots', () => {
  it('carries a declared root, and does not read it as a DTO site', () => {
    const source = [
      "import { compile, fhirpath } from 'fhirpath-ts'",
      "const VISIBLE = fhirpath(\"(status in ('draft')).not()\", 'MedicationRequest')",
      "const HEIGHT = compile('value.ofType(Quantity).value', 'Observation')",
      "const BARE = fhirpath('Patient.name.given')",
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => [site.expression, site.inputType, site.dto])).toEqual([
      ["(status in ('draft')).not()", 'MedicationRequest', undefined],
      ['value.ofType(Quantity).value', 'Observation', undefined],
      ['Patient.name.given', undefined, undefined],
    ])
  })

  it('declares one function per column field, typed from its options', () => {
    const source = [
      "import { column, criteria, defineDto } from 'fhirpath-ts'",
      "class Row extends defineDto('CodeableConcept') {",
      "  @column('text', { type: 'string' })",
      '  displayText!: string | undefined',
      "  @column('coding.count()', { type: 'integer' })",
      '  readonly codingCount!: number | undefined',
      "  @column('coding', { collection: true })",
      '  codings!: unknown[]',
      "  @column('text', { choices: { a: 'A' } })",
      '  decoded!: string | undefined',
      "  @criteria('text.exists()')",
      '  named!: boolean',
      '}',
    ].join('\n')
    const [site] = findExpressionSites(source, 'sample.ts')
    // A collection or a choices shaper leaves the result an unknown region
    // rather than a guessed one, while the class's own type is known for every
    // column. A criteria has no options to read: it is a single Boolean whatever
    // its expression yields, because the coercion lives on the function.
    const input = { types: ['CodeableConcept'] }
    expect(site?.functions).toEqual({
      displayText: { minArity: 0, maxArity: 0, signature: { input, result: { types: ['string'], single: true } } },
      codingCount: { minArity: 0, maxArity: 0, signature: { input, result: { types: ['integer'], single: true } } },
      codings: { minArity: 0, maxArity: 0, signature: { input } },
      decoded: { minArity: 0, maxArity: 0, signature: { input } },
      named: { minArity: 0, maxArity: 0, signature: { input, result: { types: ['System.Boolean'], single: true } } },
    })
  })

  it('finds the field name past other decorators and modifiers', () => {
    const source = [
      "import { column, defineDto } from 'fhirpath-ts'",
      "class Row extends defineDto('CodeableConcept') {",
      "  @column('text', { type: 'string' })",
      '  @deprecated',
      "  @label('Display')",
      '  readonly displayText!: string | undefined',
      '}',
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts')[0]?.functions).toEqual({
      displayText: {
        minArity: 0,
        maxArity: 0,
        signature: { input: { types: ['CodeableConcept'] }, result: { types: ['string'], single: true } },
      },
    })
  })

  it('survives a buffer that is mid-edit', () => {
    // What an editor sees between keystrokes: the parser recovers, the walker
    // neither throws nor invents a field name for a decorator with no field.
    const decoratorOnly =
      "import { column, defineDto } from 'fhirpath-ts'\nclass Row extends defineDto('Coding') { @column('code') }"
    expect(findExpressionSites(decoratorOnly, 'sample.ts').map(site => site.expression)).toEqual(['code'])
    const truncated = "import { r4 } from 'fhirpath-ts/r4'\nr4.evaluate('Patient.na"
    expect(() => findExpressionSites(truncated, 'sample.ts')).not.toThrow()
  })
})

describe('module options', () => {
  it('reads relative imports as the API when localImports is on', () => {
    const source = "import { compile } from '../api/compile.ts'\nconst q = compile('Patient.name')"
    expect(findExpressionSites(source, 'sample.ts')).toEqual([])
    expect(findExpressionSites(source, 'sample.ts', { localImports: true }).map(site => site.expression)).toEqual([
      'Patient.name',
    ])
  })

  it('reads extra package prefixes as the API', () => {
    const source = "import { compile } from '@acme/fhirpath'\nconst q = compile('active = true')"
    expect(findExpressionSites(source, 'sample.ts')).toEqual([])
    expect(
      findExpressionSites(source, 'sample.ts', { packages: ['@acme/fhirpath'] }).map(site => site.expression)
    ).toEqual(['active = true'])
  })

  it('uses extra package prefixes for type-resolved engines from another module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-sites-packages-'))
    const packageDirectory = join(directory, 'node_modules', '@acme', 'fhirpath')
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: '@acme/fhirpath', type: 'module', types: 'index.d.ts' })
    )
    writeFileSync(
      join(packageDirectory, 'index.d.ts'),
      'export declare class FhirPathEngine { first(expression: string, input: unknown): unknown }'
    )
    writeFileSync(
      join(directory, 'engine.ts'),
      "import { FhirPathEngine } from '@acme/fhirpath'\nexport const fp = new FhirPathEngine()"
    )
    const file = join(directory, 'source.ts')
    const source = "import { fp } from './engine.ts'\nfp.first('Patient.name', patient)"
    writeFileSync(file, source)
    const program = ts.createProgram({
      rootNames: [file],
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noLib: true,
      },
    })

    const scan = createSiteScanner(ts, program)
    expect(scan(source, file, { packages: ['@acme/fhirpath'] }).sites.map(site => site.expression)).toEqual([
      'Patient.name',
    ])
  }, 15_000)
})

describe('real source', () => {
  it('walks the dogfood modules without noise', () => {
    // A smoke test over real files: the walker parses production code and finds
    // the DTO sites the dogfood declares (patient-view.dto.ts holds 30+ columns).
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const dto = readFileSync(join(root, 'dogfood/patient-view.dto.ts'), 'utf8')
    const sites = findExpressionSites(dto, 'patient-view.dto.ts')
    expect(sites.length).toBeGreaterThan(30)
    expect(sites.every(site => site.dto === true || site.inputType === undefined)).toBe(true)
  })
})
