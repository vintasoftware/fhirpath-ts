import { RuleTester } from 'eslint'
import plugin from './index.ts'

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
    { code: "const q = r4.test(patient, 'active')" },
    { code: "const q = r4.filter(patients, 'birthDate <= @2008-01-01')" },
    { code: "const q = r4.evaluateTyped('Patient.birthDate', patient)" },
    { code: "const q = r4.first('Patient.name.family', patient)" },
    {
      code: "const q = r4.project(patients, { family: 'name.family.first()', given: { path: 'name.given', collection: true }, dynamic: someVariable })",
    },
    {
      code: "const q = r4.checkConstraints(patient, [{ key: 'pat-1', expression: 'contact.name.exists()' }, { key: 'dyn', expression: dynamic }, other])",
    },
    // Dynamic or shapeless helper arguments cannot be checked statically.
    { code: 'const q = r4.filter(patients, criteria)' },
    { code: 'const q = r4.project(patients, columns)' },
    { code: 'const q = r4.checkConstraints(patient, constraints)' },
    { code: 'const q = items.filter(item => item.active)' },
    { code: 'const q = r4.test(patient)' },
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
      code: "const q = r4.filter(patients, 'birthDate <=< @2008')",
      errors: [{ message: /syntax/ }],
    },
    {
      code: "const q = r4.test(patient, 'Patient.nope')",
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: "const q = r4.evaluateTyped('Patient.nope', patient)",
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: "const q = r4.first('Patient.nope', patient)",
      errors: [{ message: /unknown-element/ }],
    },
    {
      code: "const q = r4.project(patients, { bad: 'name..family', worse: { path: 'name.frobnicate()' } })",
      errors: [{ message: /syntax/ }, { message: /unknown-function/ }],
    },
    {
      code: "const q = r4.checkConstraints(patient, [{ key: 'x-1', expression: 'name.frobnicate()' }])",
      errors: [{ message: /unknown-function/ }],
    },
  ],
})
