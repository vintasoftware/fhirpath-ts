import type {
  Address as MedplumAddress,
  Goal as MedplumGoal,
  HumanName as MedplumHumanName,
  Observation as MedplumObservation,
  Patient as MedplumPatient,
  QuestionnaireItem as MedplumQuestionnaireItem,
} from '@medplum/fhirtypes'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { compile } from '../api/compile.ts'
import type { Address, Goal, HumanName, Observation, Patient, QuestionnaireItem } from './generated/type-maps.ts'
import { r4Model } from './index.ts'

/**
 * Both packages generate their types from the same HL7 R4 StructureDefinitions
 * (@medplum/definitions), pinned to the same release, so the required-binding
 * code unions agree exactly: all 429 fields that both packages type as a literal
 * union match code-for-code. See the README's "Medplum compatibility" section.
 */
describe('Medplum (@medplum/fhirtypes) structural compatibility', () => {
  it('required-binding fields resolve to the same literal unions', () => {
    expectTypeOf<Patient['gender']>().toEqualTypeOf<MedplumPatient['gender']>()
    expectTypeOf<Address['use']>().toEqualTypeOf<MedplumAddress['use']>()
    expectTypeOf<Address['type']>().toEqualTypeOf<MedplumAddress['type']>()
  })

  /**
   * R4 CodeSystems nest narrower codes under broader ones, and a binding admits
   * the whole tree. These four are the cases where the nesting is deepest or the
   * child codes are the ones callers reach for most, so they pin the traversal:
   * miss it and each union silently loses its children (see conceptCodes in
   * scripts/generate-r4-model.ts).
   */
  it('includes codes nested under a broader parent concept', () => {
    // NonNullable on both sides because these three bindings are 1..1 in R4:
    // Medplum types them as required, fhirpath-ts leaves every field optional.
    expectTypeOf<HumanName['use']>().toEqualTypeOf<MedplumHumanName['use']>()
    expectTypeOf<NonNullable<Goal['lifecycleStatus']>>().toEqualTypeOf<MedplumGoal['lifecycleStatus']>()
    expectTypeOf<NonNullable<Observation['status']>>().toEqualTypeOf<MedplumObservation['status']>()
    expectTypeOf<NonNullable<QuestionnaireItem['type']>>().toEqualTypeOf<MedplumQuestionnaireItem['type']>()

    // Spot-check the child codes themselves: 'maiden' sits under 'old', 'active'
    // under 'accepted', 'corrected' under 'amended', 'boolean' under 'question'.
    const name: HumanName = { use: 'maiden' }
    const goal: Goal = { resourceType: 'Goal', lifecycleStatus: 'active' }
    const observation: Observation = { resourceType: 'Observation', status: 'corrected' }
    const item: QuestionnaireItem = { type: 'boolean' }
    expect([name.use, goal.lifecycleStatus, observation.status, item.type]).toEqual([
      'maiden',
      'active',
      'corrected',
      'boolean',
    ])
  })

  it('accepts a raw Medplum resource against the default inferred input, no cast', () => {
    const medplumPatient: MedplumPatient = {
      resourceType: 'Patient',
      gender: 'male',
      name: [{ use: 'official', family: 'Chalmers', given: ['Peter'] }],
    }
    const gender = compile('Patient.gender').evaluate(medplumPatient, { model: r4Model })
    expect(gender).toEqual(['male'])
  })

  it('the TInput/TResult override types input and result as Medplum’s own', () => {
    const medplumPatient: MedplumPatient = { resourceType: 'Patient', gender: 'female' }
    const compiled = compile<'Patient.gender', MedplumPatient, NonNullable<MedplumPatient['gender']>[]>(
      'Patient.gender'
    )
    const gender = compiled.evaluate(medplumPatient, { model: r4Model })
    expectTypeOf(gender).toEqualTypeOf<NonNullable<MedplumPatient['gender']>[]>()
    expect(gender).toEqual(['female'])
  })
})
