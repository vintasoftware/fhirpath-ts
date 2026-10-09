import { describe, expect, it } from 'vitest'

import { analyzeExpression, analyzeExpressionDetailed } from '../analyzer/index.ts'
import { compile, type EvaluateOptions } from '../api/compile.ts'
import { FhirPathEngine } from '../api/engine.ts'
import { evaluate } from '../api/evaluate.ts'
import type { Patient } from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'

const options: EvaluateOptions = { model: r4Model }

/** `count` items; the one at `index` is `target`, the rest are fillers. */
function itemsWith(count: number, index: number, target: object): object[] {
  return Array.from({ length: count }, (_, position) =>
    position === index ? target : { linkId: `filler-${position}` }
  )
}

const questionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  item: itemsWith(3, 2, {
    linkId: 'i1',
    item: itemsWith(9, 8, {
      linkId: 'i2',
      item: itemsWith(2, 1, {
        linkId: 'i508',
        item: itemsWith(2, 1, {
          linkId: 'i534',
          answer: [{ valueCoding: { system: 'http://example.org', code: 'c' } }],
        }),
      }),
    }),
  }),
}

const coding = { system: 'http://loinc.org', code: '8480-6' }
const otherCoding = { system: 'http://loinc.org', code: '8462-4' }

const observation = {
  resourceType: 'Observation',
  status: 'final',
  code: { coding: [coding] },
  valueQuantity: { value: 120, unit: 'mmHg' },
  component: Array.from({ length: 24 }, (_, index) => ({
    code: { coding: [index === 0 || index === 23 ? coding : otherCoding] },
  })),
}

const patient = {
  resourceType: 'Patient',
  birthDate: '1974-12-25',
  _birthDate: {
    id: 'bd',
    extension: [{ url: 'http://example.org/birthTime', valueDateTime: '1974-12-25T14:35:45-05:00' }],
  },
  name: [
    {
      family: 'Chalmers',
      given: ['Peter', null, 'James'],
      _given: [null, { id: 'g1', extension: [{ url: 'http://example.org/x' }] }],
    },
    { family: 'Windsor' },
  ],
  managingOrganization: { reference: '#org' },
  contained: [
    { resourceType: 'Practitioner', id: 'pr' },
    { resourceType: 'Organization', id: 'org', name: 'ACME' },
  ],
}

/** The same names, as the typed engine methods accept them. */
const typedPatient: Patient = { resourceType: 'Patient', name: [{ family: 'Chalmers' }, { family: 'Windsor' }] }

describe('pathname()', () => {
  it('gives the spec QuestionnaireResponse path, with an indexer on every element', () => {
    expect(
      evaluate(
        "item.item.item.where(linkId = 'i508').item.where(linkId='i534').answer.value.pathname()",
        questionnaireResponse,
        options
      )
    ).toEqual(['QuestionnaireResponse.item[2].item[8].item[1].item[1].answer[0].value[0]'])
  })

  it('traces the spec obs-7 component paths', () => {
    const traced: string[] = []
    const result = evaluate(
      "component.code.where(coding.intersect(%resource.code.coding).trace('component', pathname()).exists()).empty()",
      observation,
      { ...options, trace: (_name, values) => traced.push(...values.map(value => String(value.value))) }
    )
    expect(result).toEqual([false])
    expect(traced).toEqual([
      'Observation.component[0].code[0].coding[0]',
      'Observation.component[23].code[0].coding[0]',
    ])
  })

  it('drops the indexers of elements that are not arrays with short = true', () => {
    expect(evaluate('Observation.code.coding.pathname(true)', observation, options)).toEqual([
      'Observation.code.coding[0]',
    ])
    expect(evaluate('Observation.value.pathname(true)', observation, options)).toEqual(['Observation.value'])
    expect(evaluate('Observation.value.pathname(false)', observation, options)).toEqual(['Observation.value[0]'])
    expect(evaluate('Observation.value.pathname({})', observation, options)).toEqual(['Observation.value[0]'])
    expect(() => evaluate("Observation.value.pathname('yes')", observation, options)).toThrow(
      'pathname() expects a Boolean argument, found System.String'
    )
    // `name` is an array in the model, so it keeps its indexer even with one entry.
    expect(evaluate('Patient.name.family.pathname(true)', patient, options)).toEqual([
      'Patient.name[0].family',
      'Patient.name[1].family',
    ])
  })

  it('names a choice element by its stem with a model, and by its JSON key without one', () => {
    expect(evaluate('Observation.value.pathname()', observation, options)).toEqual(['Observation.value[0]'])
    expect(evaluate('Observation.valueQuantity.unit.pathname()', observation)).toEqual([
      'Observation.valueQuantity[0].unit[0]',
    ])
  })

  it('counts JSON array positions, including null entries and primitives present only through _field', () => {
    expect(evaluate('Patient.name.given.pathname()', patient, options)).toEqual([
      'Patient.name[0].given[0]',
      'Patient.name[0].given[1]',
      'Patient.name[0].given[2]',
    ])
    expect(evaluate('Patient.name.given.pathname()', patient)).toEqual([
      'Patient.name[0].given[0]',
      'Patient.name[0].given[2]',
    ])
    expect(evaluate('Patient.name.given.extension.pathname()', patient, options)).toEqual([
      'Patient.name[0].given[1].extension[0]',
    ])
  })

  it('reaches primitive extensions through navigation, extension(), and children()', () => {
    expect(evaluate('Patient.birthDate.extension.pathname()', patient, options)).toEqual([
      'Patient.birthDate[0].extension[0]',
    ])
    expect(
      evaluate("Patient.birthDate.extension('http://example.org/birthTime').value.pathname(true)", patient, options)
    ).toEqual(['Patient.birthDate.extension[0].value'])
    expect(evaluate('Patient.birthDate.children().pathname()', patient, options)).toEqual([
      'Patient.birthDate[0].extension[0]',
      'Patient.birthDate[0].id[0]',
    ])
    expect(evaluate('Patient.name.given[1].children().pathname()', patient, options)).toEqual([
      'Patient.name[0].given[1].id[0]',
      'Patient.name[0].given[1].extension[0]',
    ])
    expect(evaluate('Patient.birthDate.id.pathname(true)', patient, options)).toEqual(['Patient.birthDate.id'])
    // An `extension` that is not an array still has a place, without an indexer.
    const single = { resourceType: 'Patient', birthDate: '1974-12-25', _birthDate: { extension: { url: 'x' } } }
    expect(evaluate('Patient.birthDate.extension.pathname(true)', single, options)).toEqual([
      'Patient.birthDate.extension',
    ])
  })

  it('follows children(), descendants(), and repeat()', () => {
    expect(evaluate('Patient.name[1].children().pathname()', patient, options)).toEqual(['Patient.name[1].family[0]'])
    expect(evaluate('Patient.name[0].children().pathname(true)', patient)).toEqual([
      'Patient.name[0].family',
      'Patient.name[0].given[0]',
      'Patient.name[0].given[2]',
    ])
    expect(evaluate("Patient.descendants().where($this = 'ACME').pathname()", patient, options)).toEqual([
      'Patient.contained[1].name[0]',
    ])
    expect(evaluate("repeat(item).where(linkId = 'i534').pathname(true)", questionnaireResponse, options)).toEqual([
      'QuestionnaireResponse.item[2].item[8].item[1].item[1]',
    ])
  })

  it('keeps the path of items that pass through unchanged', () => {
    expect(
      evaluate(
        "iif(true, Patient.name.where(family = 'Windsor')).first().select($this).ofType(HumanName).pathname()",
        patient,
        options
      )
    ).toEqual(['Patient.name[1]'])
    expect(evaluate('(Patient.name[1] | Patient.name[0]).pathname()', patient, options)).toEqual([
      'Patient.name[1]',
      'Patient.name[0]',
    ])
    expect(evaluate("defineVariable('n', name[1]).select(%n.family).pathname()", patient, options)).toEqual([
      'Patient.name[1].family[0]',
    ])
  })

  it('leaves out computed values and values from outside the input', () => {
    expect(evaluate('Patient.name.family.first().upper().pathname()', patient, options)).toEqual([])
    expect(evaluate("(Patient.name.family | 'x' | 1 + 1).pathname()", patient, options)).toEqual([
      'Patient.name[0].family[0]',
      'Patient.name[1].family[0]',
    ])
    expect(evaluate('Patient.birthDate.getValue().pathname()', patient, options)).toEqual([])
    expect(evaluate('%outside.name.pathname()', patient, { ...options, env: { outside: patient } })).toEqual([])
  })

  it('places resolved contained resources and Bundle entries inside the input resource', () => {
    expect(evaluate('Patient.managingOrganization.resolve().name.pathname()', patient, options)).toEqual([
      'Patient.contained[1].name[0]',
    ])
    expect(evaluate("Patient.managingOrganization.select('#'.resolve()).pathname()", patient, options)).toEqual([
      'Patient',
    ])
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          fullUrl: 'http://example.org/Patient/1',
          resource: { resourceType: 'Patient', id: '1', managingOrganization: { reference: 'Organization/2' } },
        },
        {
          fullUrl: 'http://example.org/Organization/2',
          resource: { resourceType: 'Organization', id: '2', name: 'Org' },
        },
      ],
    }
    expect(
      evaluate("'urn:uuid:empty'.resolve().pathname()", { ...bundle, entry: [{ fullUrl: 'urn:uuid:empty' }] })
    ).toEqual([])
    const expression = 'Bundle.entry.resource.ofType(Patient).managingOrganization.resolve().name'
    expect(evaluate(`${expression}.pathname()`, bundle, options)).toEqual(['Bundle.entry[1].resource[0].name[0]'])
    expect(evaluate(`${expression}.pathname(true)`, bundle, options)).toEqual(['Bundle.entry[1].resource.name'])
  })

  it('starts at the root resource, which %resource and %context share', () => {
    expect(evaluate('pathname()', patient, options)).toEqual(['Patient'])
    expect(evaluate('%resource.name.family.pathname()', patient, options)).toEqual([
      'Patient.name[0].family[0]',
      'Patient.name[1].family[0]',
    ])
    expect(evaluate('%context.name[1].pathname()', patient, options)).toEqual(['Patient.name[1]'])
    expect(evaluate('name.pathname()', [patient, patient], options)).toEqual([
      'Patient.name[0]',
      'Patient.name[1]',
      'Patient.name[0]',
      'Patient.name[1]',
    ])
  })

  it('gives paths relative to a root that is not a resource', () => {
    expect(evaluate('given.pathname()', { given: ['a', 'b'] })).toEqual(['given[0]', 'given[1]'])
    expect(evaluate('pathname()', { given: ['a'] })).toEqual([])
    expect(evaluate("'abc'.pathname()", undefined)).toEqual([])
  })

  it('delimits element names that are not plain identifiers', () => {
    expect(evaluate('`odd-key`.`as`.pathname()', { 'odd-key': { as: 1 } })).toEqual(['`odd-key`[0].`as`[0]'])
  })

  it('reaches items through var bodies, host function bodies and instance selectors', () => {
    const withVar = { ...options, vars: { located: 'name.pathname()' } }
    expect(evaluate('%located', patient, withVar)).toEqual(['Patient.name[0]', 'Patient.name[1]'])
    const withFunction = { ...options, functions: { locate: { expression: 'pathname()' } } }
    expect(evaluate('Patient.name.family.locate()', patient, withFunction)).toEqual([
      'Patient.name[0].family[0]',
      'Patient.name[1].family[0]',
    ])
    const withOverloads = {
      ...options,
      functions: {
        same: { fn: (input: unknown[]) => input },
        locate: {
          overloads: [
            { expression: 'family', signature: { input: { types: ['HumanName'] } } },
            { expression: 'pathname()', signature: { input: { types: ['string'] } } },
          ],
        },
      },
    }
    expect(evaluate('Patient.name.family.locate()', patient, withOverloads)).toEqual([
      'Patient.name[0].family[0]',
      'Patient.name[1].family[0]',
    ])
    expect(evaluate('Patient.select(Coding { code: name.first().pathname() }).code', patient, options)).toEqual([
      'Patient.name[0]',
    ])
  })

  it("leaves out items read from another evaluation's input", () => {
    const names = compile('Patient.name').evaluateTyped(typedPatient, options)
    expect(names[0]).toStrictEqual({ type: 'FHIR.HumanName', value: typedPatient.name?.[0] })
    expect(evaluate('%names.pathname()', patient, { ...options, vars: { names } })).toEqual([])
    expect(evaluate('Patient.name.pathname()', typedPatient, { ...options, vars: { names } })).toEqual([
      'Patient.name[0]',
      'Patient.name[1]',
    ])
  })

  it('works inside a DTO column body, directly and through another DTO', () => {
    const base = new FhirPathEngine({ model: r4Model })
    class NameDto extends base.defineDto('HumanName') {
      located = this.column('pathname()', { collection: true })
    }
    const withName = base.register(NameDto)
    class PatientDto extends withName.defineDto('Patient') {
      namePaths = this.column('name.located()', { collection: true })
      familyPaths = this.column('name.family.pathname(true)', { collection: true })
    }
    const fp = withName.register(PatientDto)
    expect(fp.evaluate('Patient.name.located()', typedPatient)).toEqual(['Patient.name[0]', 'Patient.name[1]'])
    // A caller's same-name function leaves the column's own table, which still calls pathname().
    const replaced = { functions: { located: { expression: 'family' } } }
    expect(fp.evaluate('Patient.namePaths()', typedPatient, replaced)).toEqual(['Patient.name[0]', 'Patient.name[1]'])
    expect(fp.project(typedPatient, PatientDto)).toEqual(
      expect.objectContaining({
        namePaths: ['Patient.name[0]', 'Patient.name[1]'],
        familyPaths: ['Patient.name[0].family', 'Patient.name[1].family'],
      })
    )
  })

  it('projects plain columns that call pathname()', () => {
    const fp = new FhirPathEngine({ model: r4Model })
    expect(fp.project(typedPatient, { first: 'name.first().pathname()' })).toEqual({ first: 'Patient.name[0]' })
  })

  it('has an analyzer signature: Strings, at most one per input item, and a Boolean argument', () => {
    const result = analyzeExpressionDetailed('Patient.name.pathname(true)', { model: r4Model })
    expect(result.diagnostics).toEqual([])
    expect(result.result.types).toEqual(['System.String'])
    expect(
      analyzeExpression("Patient.name.pathname('yes')", { model: r4Model }).map(diagnostic => diagnostic.code)
    ).toEqual(['operand-type'])
  })
})
