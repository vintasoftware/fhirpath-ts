import { RuleTester } from 'eslint'
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
  ],
})
