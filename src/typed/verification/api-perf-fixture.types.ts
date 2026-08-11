import { column, criteria, defineDto } from '../../api/dto.ts'
import { FhirPathEngine } from '../../api/engine.ts'
import type { Observation } from '../../r4/generated/type-maps.ts'

class ObservationSummary extends defineDto('Observation') {
  @column('status')
  status!: string | undefined

  @column('code.coding.first().code')
  code!: string | undefined

  @column('(code.text | code.coding.display.first()).first()')
  display!: string | undefined

  @column('subject.reference')
  subjectReference!: string | undefined

  @column('effective.ofType(dateTime)')
  effective!: string | undefined

  @column('value.ofType(Quantity).value')
  value!: number | undefined

  @column('value.ofType(Quantity).unit')
  unit!: string | undefined

  @column('component.code.text', { collection: true })
  componentLabels!: string[]

  @criteria("status = 'final'")
  isFinal!: boolean
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
