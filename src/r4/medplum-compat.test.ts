import type {
  Address as MedplumAddress,
  AuditEvent as MedplumAuditEvent,
  Bundle as MedplumBundle,
  ExampleScenario as MedplumExampleScenario,
  Extension as MedplumExtension,
  Goal as MedplumGoal,
  HumanName as MedplumHumanName,
  Observation as MedplumObservation,
  Patient as MedplumPatient,
  Quantity as MedplumQuantity,
  QuestionnaireItem as MedplumQuestionnaireItem,
  SearchParameter as MedplumSearchParameter,
} from '@medplum/fhirtypes'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { compile } from '../api/compile.ts'
import type { LenientResource } from '../typed/infer.ts'
import type {
  Address,
  Extension,
  Goal,
  HumanName,
  Observation,
  Patient,
  Quantity,
  QuestionnaireItem,
  SearchParameter,
} from './generated/type-maps.ts'
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
    // These three bindings are 1..1 in R4, and both packages type them as required.
    expectTypeOf<HumanName['use']>().toEqualTypeOf<MedplumHumanName['use']>()
    expectTypeOf<Goal['lifecycleStatus']>().toEqualTypeOf<MedplumGoal['lifecycleStatus']>()
    expectTypeOf<Observation['status']>().toEqualTypeOf<MedplumObservation['status']>()
    expectTypeOf<QuestionnaireItem['type']>().toEqualTypeOf<MedplumQuestionnaireItem['type']>()

    // Spot-check the child codes themselves: 'maiden' sits under 'old', 'active'
    // under 'accepted', 'corrected' under 'amended', 'boolean' under 'question'.
    const name: HumanName = { use: 'maiden' }
    const goal: Goal = { resourceType: 'Goal', lifecycleStatus: 'active', description: {}, subject: {} }
    const observation: Observation = { resourceType: 'Observation', status: 'corrected', code: {} }
    const item: QuestionnaireItem = { linkId: 'q1', type: 'boolean' }
    expect([name.use, goal.lifecycleStatus, observation.status, item.type]).toEqual([
      'maiden',
      'active',
      'corrected',
      'boolean',
    ])
  })

  it('hands generated datatypes to Medplum-typed code without a cast', () => {
    // Both packages require the elements FHIR requires and enumerate the same
    // bindings, so a datatype read through this package, such as a column
    // result, is assignable to Medplum's type.
    expectTypeOf<Extension>().toExtend<MedplumExtension>()
    expectTypeOf<Address>().toExtend<MedplumAddress>()
    expectTypeOf<Quantity>().toExtend<MedplumQuantity>()
    expectTypeOf<HumanName>().toExtend<MedplumHumanName>()
    // A whole resource is not: `contained` and `Bundle.entry.resource` hold any
    // `{ resourceType }` here, while Medplum's `Resource` is a closed union that
    // also names Medplum's own resources.
    expectTypeOf<Patient>().not.toExtend<MedplumPatient>()
    // The other way round, a Medplum value names those resources in
    // `Reference.type`, so it enters through the lenient input type, which
    // widens a code set that names model types to string, not through the
    // generated interface. The input keeps every other code union.
    expectTypeOf<MedplumExtension>().not.toExtend<Extension>()
    expectTypeOf<MedplumPatient>().toExtend<LenientResource<'Patient'>>()
    expectTypeOf<MedplumObservation>().toExtend<LenientResource<'Observation'>>()
    expectTypeOf<MedplumAuditEvent>().toExtend<LenientResource<'AuditEvent'>>()
    expectTypeOf<MedplumBundle>().toExtend<LenientResource<'Bundle'>>()
    expectTypeOf<MedplumSearchParameter>().toExtend<LenientResource<'SearchParameter'>>()
    // ExampleScenario.instance.resourceType is a code bound to the resource
    // names, not a resource's own pin, so it widens like Reference.type.
    expectTypeOf<MedplumExampleScenario>().toExtend<LenientResource<'ExampleScenario'>>()
    // A required binding to the resource names keeps the abstract names the
    // spec's own search parameters and operations use.
    expectTypeOf<'Resource' | 'DomainResource'>().toExtend<SearchParameter['base'][number]>()
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
