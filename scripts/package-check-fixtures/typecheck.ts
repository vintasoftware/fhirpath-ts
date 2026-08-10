import { FhirPathEngine } from 'fhirpath-ts'
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
