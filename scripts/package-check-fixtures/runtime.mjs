import assert from 'node:assert/strict'

import { FhirPathEngine } from 'fhirpath-ts'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import plugin from 'fhirpath-ts/eslint'
import packageMetadata from 'fhirpath-ts/package.json' with { type: 'json' }
import { r4 } from 'fhirpath-ts/r4'
import { sdcScope } from 'fhirpath-ts/sdc'
import { createSiteFinder } from 'fhirpath-ts/sites'
import ts from 'typescript'

assert.equal(typeof FhirPathEngine, 'function')
assert.deepEqual(
  r4.evaluate('Patient.name.given', {
    resourceType: 'Patient',
    name: [{ given: ['Ada'] }],
  }),
  ['Ada']
)
assert.deepEqual(analyzeExpression('Patient.name'), [])
assert.equal(plugin.meta.name, packageMetadata.name)
assert.equal(plugin.meta.version, packageMetadata.version)
const source = "import { compile } from 'fhirpath-ts'\nconst path = compile('Patient.name')"
assert.equal(createSiteFinder(ts)(source, 'consumer.ts').length, 1)
const sdcResponse = { resourceType: 'QuestionnaireResponse', item: [{ linkId: 'q', answer: [{ valueInteger: 2 }] }] }
const sdcQuestionnaire = { resourceType: 'Questionnaire', item: [{ linkId: 'q', type: 'integer' }] }
const [, item] = sdcScope(r4, sdcQuestionnaire).contexts(sdcResponse)
assert.deepEqual(r4.evaluate('answer.value + %qitem.linkId.length()', item.context, { vars: item.vars }), [3])
