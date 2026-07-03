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
  ],
})
