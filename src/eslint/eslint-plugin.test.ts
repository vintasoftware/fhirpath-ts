import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'

import plugin from './index.ts'

const R4_IMPORT = "import { r4 } from 'fhirpath-ts/r4'; "

// RuleTester integrates with vitest's globals and creates its own suites.
const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

tester.run('no-invalid-expressions', plugin.rules['no-invalid-expressions'], {
  valid: [
    { code: 'const q = fhirpath`Patient.name.given`' },
    { code: "const q = compile('Patient.birthDate')" },
    { code: "const q = api.evaluate('Patient.active', input)" },
    { code: 'const dynamic = compile(someVariable)' },
    { code: 'const other = somethingElse`Patient.nope`' },
    { code: 'const withHole = fhirpath`Patient.$' + '{x}`' },
    // Subject-first engine helpers: the expression comes second.
    { code: `${R4_IMPORT}const q = r4.test(patient, 'active')` },
    { code: `${R4_IMPORT}const q = r4.filter(patients, 'birthDate <= @2008-01-01')` },
    { code: "const q = r4.evaluateTyped('Patient.birthDate', patient)" },
    { code: `${R4_IMPORT}const q = r4.first('Patient.name.family', patient)` },
    {
      code: `${R4_IMPORT}const q = r4.project(patients, { family: 'name.family.first()', given: { path: 'name.given', collection: true }, dynamic: someVariable })`,
    },
    {
      code: "const q = r4.checkConstraints(patient, [{ key: 'pat-1', expression: 'contact.name.exists()' }, { key: 'dyn', expression: dynamic }, other])",
    },
    // Dynamic or shapeless helper arguments cannot be checked statically.
    { code: `${R4_IMPORT}const q = r4.filter(patients, criteria)` },
    { code: `${R4_IMPORT}const q = r4.project(patients, columns)` },
    { code: `${R4_IMPORT}const q = r4.checkConstraints(patient, constraints)` },
    { code: `${R4_IMPORT}const q = r4.test(patient)` },
    // Common-name helpers fire only on known engine receivers: other libraries'
    // .first()/.filter()/.test() must not be analyzed as FHIRPath.
    { code: "import knex from 'knex'; const db = knex({}); const q = db.first('COUNT(*) as total')" },
    { code: "import knex from 'knex'; const db = knex({}); const q = db.filter(rows, 'created_at > ?')" },
    { code: "const q = validator.test(input, 'some free text')" },
    { code: 'const q = items.filter(item => item.active)' },
    { code: "const q = r4.filter(patients, 'no import binds r4 here so it is unknown')" },
    {
      code: "import { FhirPathEngine } from 'some-other-fhirpath'; const e = new FhirPathEngine(); const q = e.test(x, 'not ours')",
    },
    // A trusted name the file re-binds loses engine trust file-wide.
    { code: `${R4_IMPORT}function query(r4) { return r4.filter(rows, 'created_at > ?') }` },
    {
      code: "import { FhirPathEngine } from 'fhirpath-ts'; function a() { const e = new FhirPathEngine({}); return e } function b(e) { return e.filter(rows, 'created_at > ?') }",
    },
    // Names imported from other modules are not FHIRPath entry points.
    { code: "import { compile } from 'handlebars'; const t = compile('not [fhirpath]')" },
    { code: "import fhirpath from 'other-lib'; const t = fhirpath`Patient.nope`" },
    { code: "import _ from 'lodash'; const t = _.filter(users, 'not [fhirpath]')" },
    // By default a relative import is foreign, so an in-repo `compile` is skipped
    // even if the expression is invalid...
    { code: "import { compile } from '../api/compile.ts'; const t = compile('Patient.frobnicate()')" },
    // ...and `localImports` does not resurrect genuinely foreign package imports.
    {
      code: "import { compile } from 'handlebars'; const t = compile('Patient.frobnicate()')",
      options: [{ localImports: true }],
    },
  ],
  invalid: [
    {
      code: 'const q = fhirpath`Patient.nope`',
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: "const q = compile('Patient.name.frobnicate()')",
      errors: [{ message: /unknown-function/ }],
    },
    {
      code: "const q = evaluate('Patient..name', input)",
      errors: [{ message: /syntax/ }],
    },
    {
      code: "const q = compile('Patient.name.given.substring(1)')",
      errors: [{ message: /singleton-required/ }],
    },
    {
      code: `${R4_IMPORT}const q = r4.filter(patients, 'birthDate <=< @2008')`,
      errors: [{ message: /syntax/ }],
    },
    {
      code: `${R4_IMPORT}const q = r4.test(patient, 'Patient.nope')`,
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: "const q = r4.evaluateTyped('Patient.nope', patient)",
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: `${R4_IMPORT}const q = r4.first('Patient.nope', patient)`,
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: `${R4_IMPORT}const q = r4.project(patients, { bad: 'name..family', worse: { path: 'name.frobnicate()' } })`,
      errors: [{ message: /syntax/ }, { message: /unknown-function/ }],
    },
    {
      // A computed key names the column; the value is still a checkable expression.
      code: `${R4_IMPORT}const q = r4.project(patients, { [column]: 'name..family' })`,
      errors: [{ message: /syntax/ }],
    },
    {
      code: "const q = r4.checkConstraints(patient, [{ key: 'x-1', expression: 'name.frobnicate()' }])",
      errors: [{ message: /unknown-function/ }],
    },
    {
      // A new FhirPathEngine local is an engine receiver, even when used above its declaration.
      code: "import { FhirPathEngine } from 'fhirpath-ts'; function f(p) { return engine.test(p, 'name..bad') } const engine = new FhirPathEngine({})",
      errors: [{ message: /syntax/ }],
    },
    // localImports: relative imports of the API are checked — how the package
    // dogfoods this rule on its own source.
    {
      code: "import { compile } from '../api/compile.ts'; const t = compile('Patient.frobnicate()')",
      options: [{ localImports: true }],
      errors: [{ message: /unknown-function/ }],
    },
    {
      code: "import { r4 } from '../r4/index.ts'; const t = r4.filter(patients, 'Patient.nope')",
      options: [{ localImports: true }],
      errors: [{ message: /unknown-element/ }],
    },
    // packages: extra import sources counted as the FHIRPath API.
    {
      code: "import { compile } from '@myorg/fhir'; const t = compile('Patient.frobnicate()')",
      options: [{ packages: ['@myorg/fhir'] }],
      errors: [{ message: /unknown-function/ }],
    },
  ],
})

/**
 * DTO fields carry decorators, which the default parser cannot read — the same
 * TypeScript parser the repo lints with supplies them.
 */
const dtoTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
})

const DTO_IMPORT = "import { column, criteria, defineDto } from 'fhirpath-ts'; "

dtoTester.run('no-invalid-expressions (DTOs)', plugin.rules['no-invalid-expressions'], {
  valid: [
    // A column analyzed against the class's fhirType.
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Condition') { @column('clinicalStatus.coding.first().code') code!: string | undefined }`,
    },
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Condition') { @criteria('recordedDate.exists()') seen!: boolean }`,
    },
    // A DTO's vars, off the defineDto options.
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Observation', { vars: { at: 'issued' } }) { @column('status') s!: string | undefined }`,
    },
    // %vars and registered DTO functions are not this rule's to judge.
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Condition') { @column('%badge.label', { type: 'string' }) label!: string | undefined }`,
    },
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Condition') { @column('code.displayText()', { type: 'string' }) name!: string | undefined }`,
    },
    // No statically-known root: a relative path is not reported, because a
    // leading `code` segment is also a model type name.
    {
      code: `${DTO_IMPORT}class Row extends badgedRow('DiagnosticReport') { @column('code.coding.first().display') name!: string | undefined }`,
    },
    // A call into a column the same file declares resolves, in a DTO site and
    // in an ordinary one.
    {
      code: `${DTO_IMPORT}class C extends defineDto('CodeableConcept') { @column('text', { type: 'string' }) displayText!: string | undefined } class W extends defineDto('Observation') { @column('code.displayText().length()', { type: 'integer' }) len!: number | undefined }`,
    },
    {
      code: `${DTO_IMPORT}import { r4 } from 'fhirpath-ts/r4'; class C extends defineDto('CodeableConcept') { @column('text', { type: 'string' }) displayText!: string | undefined } const label = r4.first('Condition.code.displayText()', condition)`,
    },
    // An unresolved call unlike any column here: a DTO in another module.
    {
      code: `${DTO_IMPORT}class W extends defineDto('Observation') { @column('code.reportBadge()', { type: 'string' }) badge!: string | undefined }`,
    },
    // A declared root makes a shared const checkable; its %env stays unjudged.
    {
      code: "import { fhirpath } from 'fhirpath-ts'; const V = fhirpath(\"(status in ('draft')).not()\", 'MedicationRequest')",
    },
    {
      code: "import { fhirpath } from 'fhirpath-ts'; const W = fhirpath('code.coding.exists(system = %loinc)', 'Observation')",
    },
    // A `column` that is not the package's own.
    { code: "import { column } from 'some-table-library'; column('id')" },
    { code: "const column = (name: string) => name; column('not.a.fhirpath.expression')" },
  ],
  invalid: [
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Condition') { @column('clinicalStatus.codingg.first()') code!: unknown }`,
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: `${DTO_IMPORT}class Row extends defineDto('CodeableConcept') { @column('(texxt | coding.display.first()).first()') text!: string | undefined }`,
      errors: [{ message: /unknown-element.*texxt/ }],
    },
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Condition') { @criteria('verificationStatuss.exists()') bad!: boolean }`,
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: `${DTO_IMPORT}class Row extends defineDto('Observation', { vars: { at: 'issuedd' } }) { @column('status') s!: string | undefined }`,
      errors: [{ message: /unknown-element/ }],
    },
    // A near-miss of a column the file declares is a typo, not a foreign DTO.
    {
      code: `${DTO_IMPORT}class C extends defineDto('CodeableConcept') { @column('text', { type: 'string' }) displayText!: string | undefined } class W extends defineDto('Observation') { @column('code.displayTxt()', { type: 'string' }) name!: string | undefined }`,
      errors: [{ message: /unknown-function.*did you mean 'displayText'/ }],
    },
    // A declared column's result type carries into the calling expression.
    {
      code: `${DTO_IMPORT}class C extends defineDto('CodeableConcept') { @column('text', { type: 'string' }) displayText!: string | undefined } class W extends defineDto('Observation') { @column('code.displayText() + 1', { type: 'string' }) bad!: string | undefined }`,
      errors: [{ message: /operand-type/ }],
    },
    // The root is what lets a relative expression be checked at all.
    {
      code: "import { fhirpath } from 'fhirpath-ts'; const V = fhirpath(\"(statuss in ('draft')).not()\", 'MedicationRequest')",
      errors: [{ message: /unknown-element.*did you mean 'status'/ }],
    },
    {
      code: "import { compile } from 'fhirpath-ts'; const H = compile('value.ofType(Quantityy).value', 'Observation')",
      errors: [{ message: /unknown-type/ }],
    },
    // Even with no root, a malformed expression is still a syntax error.
    {
      code: `${DTO_IMPORT}class Row extends badgedRow('DiagnosticReport') { @column('code.text(') name!: unknown }`,
      errors: [{ message: /syntax/ }],
    },
  ],
})
