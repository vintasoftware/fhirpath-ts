import { describe, expectTypeOf, it } from 'vitest'

import { compile, type CustomFunction, type EvaluateOptions } from '../api/compile.ts'
import { type EngineOptions, FhirPathEngine } from '../api/engine.ts'
import type { Condition, DiagnosticReport, Patient } from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'
import type { FhirpathResult, FhirpathTypeContext, FhirpathTypeContextOf, FhirpathTypeDeclaration } from './infer.ts'

describe('typed host context', () => {
  it('types declared environment values and normalizes leading percent signs', () => {
    type Context = {
      env: {
        '%report': { type: 'DiagnosticReport' }
        fallback: { type: 'string'; collection: true }
      }
    }
    expectTypeOf<FhirpathResult<'%report.status.combine(%fallback)', Context>>().toEqualTypeOf<string[]>()
    expectTypeOf<
      FhirpathResult<
        '%practitioner.resolve().name.given',
        { env: { practitioner: { type: 'Reference'; targets: 'Practitioner' } } }
      >
    >().toEqualTypeOf<string[]>()
  })

  it('keeps deliberately widened declarations opaque', () => {
    const declaration: FhirpathTypeDeclaration = { type: 'DiagnosticReport' }
    const _context = { env: { report: declaration } } satisfies FhirpathTypeContext
    expectTypeOf<FhirpathResult<'%report.status', typeof _context>>().toEqualTypeOf<unknown[]>()
  })

  it('rejects malformed standalone contexts and degrades unrecognized result types', () => {
    // @ts-expect-error envTypez is not a FHIRPath context field
    type _InvalidContextKey = FhirpathResult<'%report.status', { envTypez: { report: { type: 'DiagnosticReport' } } }>
    // @ts-expect-error env must contain FHIRPath type declarations
    type _InvalidEnvironment = FhirpathResult<'%report.status', { env: 42 }>
    // @ts-expect-error declaration type names must come from the generated model
    type _InvalidTypeName = FhirpathResult<'%report.status', { env: { report: { type: 'DiagnosticReprot' } } }>

    type UnknownFunctionType = {
      functions: { mystery: { signature: { result: { types: ['NotInTheModel'] } } } }
    }
    expectTypeOf<FhirpathResult<'mystery()', UnknownFunctionType>>().toEqualTypeOf<unknown[]>()
  })

  it('types signatures, expression bodies, local overlays, criteria, and overloads', () => {
    const _functions = {
      nativeStatus: {
        fn: () => 'final',
        signature: { result: { types: ['string'], single: true } },
      },
      display: { expression: '(text | coding.display).first()' },
      labelled: {
        expression: '%prefix & text',
        envTypes: { prefix: { type: 'string' } },
      },
      holds: { expression: 'text', criteria: true },
      render: {
        overloads: [
          {
            fn: () => 'patient',
            signature: { input: { types: ['Patient'] }, result: { types: ['string'], single: true } },
          },
          {
            fn: () => 1,
            signature: { input: { types: ['Observation'] }, result: { types: ['integer'], single: true } },
          },
        ],
      },
    } as const satisfies Record<string, CustomFunction>
    type Context = { functions: typeof _functions }

    expectTypeOf<FhirpathResult<'nativeStatus()', Context>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Condition.code.display()', Context>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Condition.code.labelled()', Context>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Condition.code.holds()', Context>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'Patient.render()', Context>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Observation.render()', Context>>().toEqualTypeOf<number[]>()
  })

  it('captures engine defaults and lets per-call declarations win by name', () => {
    const report: DiagnosticReport = { resourceType: 'DiagnosticReport', status: 'final', code: {} }
    const engine = new FhirPathEngine({
      model: r4Model,
      env: { report },
      envTypes: { report: { type: 'DiagnosticReport' } },
    })
    const fromDefault = engine.evaluate('%report.status')
    const fromCall = engine.evaluate('%report.active', undefined, {
      env: { report: { resourceType: 'Patient', active: true } },
      envTypes: { report: { type: 'Patient' } },
    })
    const projected = engine.project({ resourceType: 'Patient', id: 'p1' }, { status: '%report.status' })
    expectTypeOf(fromDefault).toEqualTypeOf<string[]>()
    expectTypeOf(fromCall).toEqualTypeOf<boolean[]>()
    expectTypeOf(projected).toEqualTypeOf<{ status: string | undefined }>()
  })

  it('infers literal vars and lets varTypes override their inferred bodies', () => {
    const patient: Patient = { resourceType: 'Patient', active: true }
    const engine = new FhirPathEngine({ model: r4Model })
    const inferred = engine.evaluate('%status', patient, { vars: { status: 'Patient.gender' } })
    const overridden = engine.evaluate('%status.active', patient, {
      vars: { status: 'Patient.gender' },
      varTypes: { status: { type: 'Patient' } },
    })
    const dependent = engine.evaluate('%label', patient, {
      vars: { status: 'Patient.gender', label: "%status & '!'" },
      varTypes: { status: { type: 'string' } },
    })
    expectTypeOf(inferred).toEqualTypeOf<string[]>()
    expectTypeOf(overridden).toEqualTypeOf<boolean[]>()
    expectTypeOf(dependent).toEqualTypeOf<string[]>()

    type ForwardContext = FhirpathTypeContextOf<{
      vars: { first: '%later.name.given'; later: 'Patient' }
    }>
    expectTypeOf<FhirpathResult<'%first', ForwardContext>>().toEqualTypeOf<unknown[]>()
  })

  it('refines compiled and bound expressions while preserving an explicit result override', () => {
    const report: DiagnosticReport = { resourceType: 'DiagnosticReport', status: 'final', code: {} }
    const compiled = compile('%report.status')
    const refined = compiled.evaluate(undefined, {
      env: { report },
      envTypes: { report: { type: 'DiagnosticReport' } },
    })
    const explicit = compile<'%report.status', unknown, number[]>('%report.status')
    const explicitResult = explicit.evaluate(undefined, {
      env: { report },
      envTypes: { report: { type: 'DiagnosticReport' } },
    })
    const bound = new FhirPathEngine({
      env: { report },
      envTypes: { report: { type: 'DiagnosticReport' } },
    }).compile('%report.status')

    expectTypeOf(refined).toEqualTypeOf<string[]>()
    expectTypeOf(explicitResult).toEqualTypeOf<number[]>()
    expectTypeOf(bound.evaluate()).toEqualTypeOf<string[]>()
  })

  it('infers the literal source of a compiled expression-function body', () => {
    const functions = {
      displayText: {
        expression: compile('(text | coding.display.first() | coding.first().code).first()', 'CodeableConcept'),
        signature: { input: { types: ['CodeableConcept'] } },
      },
    } satisfies Record<string, CustomFunction>
    type Context = FhirpathTypeContextOf<{ functions: typeof functions }>
    expectTypeOf<FhirpathResult<'Condition.code.displayText()', Context>>().toEqualTypeOf<string[]>()
    const condition: Condition = { resourceType: 'Condition', code: { text: 'Hypertension' } }
    const result = new FhirPathEngine({ model: r4Model, functions }).evaluate('Condition.code.displayText()', condition)

    expectTypeOf(result).toEqualTypeOf<string[]>()
  })

  it('injects resource roots and projection row variables', () => {
    const patient: Patient = { resourceType: 'Patient', id: 'p1' }
    const engine = new FhirPathEngine({ model: r4Model })
    const relative = engine.evaluate('name.given', patient)
    const contextId = engine.evaluate('%context.id | %resource.id | %rootResource.id', patient)
    const row = engine.project(patient, { id: 'id', position: '%rowIndex.toString()' })

    expectTypeOf(relative).toEqualTypeOf<string[]>()
    expectTypeOf(contextId).toEqualTypeOf<string[]>()
    expectTypeOf(row).toEqualTypeOf<{ id: string | undefined; position: string | undefined }>()
  })

  it('keeps old untyped options source-compatible and opaque', () => {
    const options = { env: { report: {} } }
    const result = new FhirPathEngine().evaluate('%report.status', undefined, options)
    expectTypeOf(result).toEqualTypeOf<unknown[]>()
  })

  it('degrades an invalid overlapping env and var declaration instead of choosing one', () => {
    type Context = {
      env: { shared: { type: 'Patient' } }
      vars: { shared: { type: 'DiagnosticReport' } }
    }
    expectTypeOf<FhirpathResult<'%shared.id', Context>>().toEqualTypeOf<unknown[]>()
  })

  it('checks values and cardinality when declarations share one literal options object', () => {
    void new FhirPathEngine({
      env: { report: { resourceType: 'DiagnosticReport', status: 'final', code: {} } },
      envTypes: { report: { type: 'DiagnosticReport' } },
    })

    void new FhirPathEngine({
      // @ts-expect-error the visible value contradicts its DiagnosticReport declaration
      env: { report: { resourceType: 'Patient' } },
      envTypes: { report: { type: 'DiagnosticReport' } },
    })
    // @ts-expect-error a declaration with singleton cardinality cannot accept a two-item literal
    void new FhirPathEngine({ env: { status: ['final', 'amended'] }, envTypes: { status: { type: 'string' } } })
  })

  it('rejects unknown keys on every inferred per-call options route', () => {
    const engine = new FhirPathEngine()
    const bound = engine.compile('%report.status')
    const compiled = compile('%report.status')
    const typo = { envTypez: { report: { type: 'DiagnosticReport' } } }

    const assertInvalidOptions = () => {
      // @ts-expect-error envTypez is not an evaluate option
      engine.evaluate('%report.status', undefined, typo)
      // @ts-expect-error envTypez is not an evaluate option
      engine.first('%report.status', undefined, typo)
      // @ts-expect-error envTypez is not a project option
      engine.project({ resourceType: 'Patient' }, { status: '%report.status' }, typo)
      // @ts-expect-error envTypez is not a bound-expression option
      bound.evaluate(undefined, typo)
      // @ts-expect-error envTypez is not a bound-expression option
      bound.first(undefined, typo)
      // @ts-expect-error envTypez is not a compiled-expression option
      compiled.evaluate(undefined, typo)
    }
    void assertInvalidOptions
  })

  it('accepts named option extensions and index-signature records', () => {
    interface AppOptions extends EvaluateOptions {
      requestId: string
    }
    interface AppEngineOptions extends EngineOptions {
      requestId: string
    }

    const engine = new FhirPathEngine()
    const bound = engine.compile('Patient.id')
    const compiled = compile('Patient.id')
    const assertAcceptedOptions = (app: AppOptions, engineOptions: AppEngineOptions, wide: Record<string, unknown>) => {
      void new FhirPathEngine(app)
      void new FhirPathEngine(engineOptions)
      void new FhirPathEngine(wide)
      engine.evaluate('Patient.id', undefined, app)
      engine.evaluate('Patient.id', undefined, wide)
      engine.first('Patient.id', undefined, app)
      engine.first('Patient.id', undefined, wide)
      engine.project({ resourceType: 'Patient' }, { id: 'Patient.id' }, app)
      engine.project({ resourceType: 'Patient' }, { id: 'Patient.id' }, wide)
      bound.evaluate(undefined, app)
      bound.evaluate(undefined, wide)
      bound.first(undefined, app)
      bound.first(undefined, wide)
      compiled.evaluate(undefined, app)
      compiled.evaluate(undefined, wide)
    }
    void assertAcceptedOptions
  })

  it('leaves widened option spreads open and lets satisfies check their construction', () => {
    const engine = new FhirPathEngine()
    const assertSpreadBehavior = (base: EvaluateOptions) => {
      const open = { ...base, envTypez: { report: { type: 'DiagnosticReport' } } }
      engine.evaluate('%report.status', undefined, open)

      // @ts-expect-error satisfies checks the explicit typo even beside a widened spread
      const checked = { ...base, envTypez: { report: { type: 'DiagnosticReport' } } } satisfies EvaluateOptions
      void checked
    }
    void assertSpreadBehavior
  })
})
