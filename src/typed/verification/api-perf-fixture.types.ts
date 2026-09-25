import { defineDto } from '../../api/dto.ts'
import { FhirPathEngine } from '../../api/engine.ts'
import type { Observation } from '../../r4/generated/type-maps.ts'

class ObservationSummary extends defineDto('Observation', {
  env: { tones: [{ code: 'final', tone: 'success' }] },
  callerEnv: { reports: { type: 'DiagnosticReport', collection: true } },
  vars: { report: "%reports.where(basedOn.reference = 'Observation/' + %context.id).first()" },
}) {
  status = this.column('status')

  tone = this.column('%tones.where(code = %context.status).tone.first()')

  reportStatus = this.column('%report.status', { default: 'waiting' })

  code = this.column('code.coding.first().code')

  display = this.column('(code.text | code.coding.display.first()).first()')

  subjectReference = this.column('subject.reference')

  effective = this.column('effective.ofType(dateTime)')

  value = this.column('value.ofType(Quantity).value')

  unit = this.column('value.ofType(Quantity).unit')

  componentLabels = this.column('component.code.text', { collection: true })

  isFinal = this.criteria("status = 'final'")
}

const engine = new FhirPathEngine({
  env: { preferredUnit: 'kg' },
  envTypes: { preferredUnit: { type: 'string' } },
  vars: { display: '(code.text | code.coding.display.first()).first()' },
  varTypes: { display: { type: 'string' } },
  functions: {
    normalizedValue: {
      expression: 'value.ofType(Quantity).toQuantity(%preferredUnit).value',
      signature: { result: { types: ['decimal'], single: true } },
      envTypes: { preferredUnit: { type: 'string' } },
    },
  },
})

declare const observations: readonly Observation[]

export const apiPerfDtoRows = engine.project(observations, ObservationSummary, {
  env: { requestedStatus: 'final' },
  envTypes: { requestedStatus: { type: 'code' } },
})

export const apiPerfRows = engine.project(
  observations,
  {
    id: 'id',
    status: 'status',
    display: '(Observation.code.text | Observation.code.coding.display.first()).first()',
    normalized: 'Observation.value.ofType(Quantity).value',
    selected: 'Observation.status',
    subject: 'Observation.subject.reference',
  },
  {
    env: { requestedStatus: 'final' },
    envTypes: { requestedStatus: { type: 'code' } },
    vars: { fallback: "'unknown'" },
    varTypes: { fallback: { type: 'string' } },
  }
)

export const apiPerfEvaluation = engine.evaluate('Observation.status', observations)
