import { compile, FhirPathEngine } from 'fhirpath-ts'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import plugin from 'fhirpath-ts/eslint'
import { r4 } from 'fhirpath-ts/r4'
import { createSiteFinder } from 'fhirpath-ts/sites'
import ts from 'typescript'

new FhirPathEngine().evaluate('1 + 1')
r4.evaluate('Patient.active', { resourceType: 'Patient', active: true })
analyzeExpression('Patient.active')
createSiteFinder(ts)
void plugin.rules['no-invalid-expressions']

// A declared `type` with a compiled expression and a literal `resourceType`
// reaches the `NoInfer` overloads, the reason for the TypeScript peer floor.
const condition = {
  resourceType: 'Condition' as const,
  subject: { reference: 'Patient/example' },
  clinicalStatus: { coding: [{ code: 'active' }] },
}
const status = compile('clinicalStatus.coding.first().code', 'Condition')
export const codes: string[] = r4.evaluate(status, condition, { type: 'code' })
export const code: string | undefined = r4.first(compile('clinicalStatus.coding.code'), condition, { type: 'code' })
// @ts-expect-error a Patient expression does not accept a Condition
r4.evaluate('Patient.name.given', condition, { type: 'string' })
// @ts-expect-error a Condition-rooted expression does not accept a Patient
r4.evaluate(status, { resourceType: 'Patient' as const })
