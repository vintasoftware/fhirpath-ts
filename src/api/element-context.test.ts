import { describe, expect, it } from 'vitest'

import { analyzeExpressionDetailed } from '../analyzer/analyze.ts'
import { r4, r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { FhirPathEngine } from './engine.ts'

const ordinal = (valueDecimal: number) => [
  { url: 'http://hl7.org/fhir/StructureDefinition/ordinalValue', valueDecimal },
]
const questionnaire = {
  resourceType: 'Questionnaire',
  item: [
    {
      linkId: 'group',
      type: 'group',
      repeats: true,
      item: [
        {
          linkId: 'mood',
          type: 'choice',
          answerOption: [
            { valueCoding: { system: 'urn:s', code: 'low' }, extension: ordinal(1) },
            { valueCoding: { system: 'urn:s', code: 'high' }, extension: ordinal(3) },
          ],
        },
      ],
    },
  ],
}
const low = { valueCoding: { system: 'urn:s', code: 'low' } }
const high = { valueCoding: { system: 'urn:s', code: 'high' } }
const note = { valueString: 'note', _valueString: { extension: [{ url: 'urn:x', valueBoolean: true }] } }
const response = {
  resourceType: 'QuestionnaireResponse' as const,
  status: 'completed' as const,
  item: [
    { linkId: 'group', item: [{ linkId: 'mood', answer: [low, high] }] },
    { linkId: 'group', item: [{ linkId: 'mood', answer: [high] }] },
    { linkId: 'note', answer: [note] },
  ],
}
const groups = () => r4.evaluateTyped("QuestionnaireResponse.item.where(linkId = 'group')", response)

describe('typed values as evaluation input', () => {
  it('evaluates at each element with its type, choice elements, and _field metadata', () => {
    const [first, second] = groups()
    expect(r4.evaluate('item.answer.value.code', [first!])).toEqual(['low', 'high'])
    expect(r4.evaluate('item.answer.value.code', [second!])).toEqual(['high'])
    const [noteItem] = r4.evaluateTyped("item.where(linkId = 'note')", response)
    expect(r4.evaluate('answer.value.extension.url', [noteItem!])).toEqual(['urn:x'])
    expect(r4.evaluate('answer.value is string', [noteItem!])).toEqual([true])
  })

  it('keeps $this, %context, %resource, and %rootResource distinct', () => {
    const [first] = groups()
    const [mood] = r4.evaluateTyped('item', [first!])
    const input = [mood!]
    expect(r4.evaluate('$this.linkId', input)).toEqual(['mood'])
    expect(r4.evaluate('%context.linkId', input)).toEqual(['mood'])
    expect(r4.evaluate('answer.where($this.value.code = %context.answer.first().value.code).count()', input)).toEqual([
      1,
    ])
    expect(r4.evaluate('%resource.status', input)).toEqual(['completed'])
    expect(r4.evaluate('%rootResource.item.count()', input)).toEqual([3])
  })

  it('scores repeated answers of each group instance through weight()', () => {
    const vars = { questionnaire: r4.evaluateTyped('$this', questionnaire) }
    const [first, second] = groups()
    expect(r4.evaluate('item.answer.weight()', [first!], { vars })).toEqual([1, 3])
    expect(r4.evaluate('item.answer.value.weight()', [second!], { vars })).toEqual([3])
  })

  it('gives paths inside %rootResource', () => {
    const [, second] = groups()
    expect(r4.evaluate('item.answer.value.pathname()', [second!])).toEqual([
      'QuestionnaireResponse.item[1].item[0].answer[0].value[0]',
    ])
  })

  it('reads a Bundle entry as its own resource', () => {
    const bundle = { resourceType: 'Bundle' as const, type: 'collection' as const, entry: [{ resource: response }] }
    const items = r4.evaluateTyped("Bundle.entry.resource.item.where(linkId = 'note')", bundle)
    expect(r4.evaluate('%resource.resourceType', items)).toEqual(['QuestionnaireResponse'])
    expect(r4.evaluate('%rootResource.resourceType', items)).toEqual(['QuestionnaireResponse'])
    expect(r4.evaluate('answer.pathname()', items)).toEqual(['QuestionnaireResponse.item[2].answer[0]'])
  })

  it('reads a contained resource with its container as %rootResource', () => {
    const observation = {
      resourceType: 'Observation',
      id: 'obs',
      contained: [
        { resourceType: 'Patient', id: 'p', managingOrganization: { reference: '#org' } },
        {
          resourceType: 'Organization',
          id: 'org',
          name: 'Clinic',
        },
      ],
      subject: { reference: '#p' },
    }
    const patients = r4.evaluateTyped('contained.ofType(Patient)', observation)
    expect(r4.evaluate('%resource.id', patients)).toEqual(['p'])
    expect(r4.evaluate('%rootResource.id', patients)).toEqual(['obs'])
    expect(r4.evaluate('managingOrganization.resolve().name', patients)).toEqual(['Clinic'])
    expect(r4.evaluate('managingOrganization.pathname()', patients)).toEqual([
      'Observation.contained[0].managingOrganization[0]',
    ])
  })

  it('leaves JSON input as its own resource', () => {
    expect(r4.evaluate('%resource.status', response)).toEqual(['completed'])
    expect(r4.evaluate('%rootResource = %context', response)).toEqual([true])
  })

  it('lets an env value override the derived resources', () => {
    const [first] = groups()
    const other = { resourceType: 'QuestionnaireResponse', status: 'amended' }
    expect(r4.evaluate('%resource.status', [first!], { env: { resource: other } })).toEqual(['amended'])
    expect(r4.evaluate('item.answer.first().pathname()', [first!], { env: { rootResource: other } })).toEqual([
      'QuestionnaireResponse.item[0].item[0].answer[0]',
    ])
  })

  it('refuses inputs whose context resources conflict', () => {
    const items = r4.evaluateTyped('item', response)
    const other = r4.evaluateTyped('item', { ...response, item: [{ linkId: 'x' }] })
    expect(() => r4.evaluate('linkId', [...items, ...other])).toThrow('different owning resources')
    expect(() => r4.evaluate('linkId', [...items, { linkId: 'json' }])).toThrow('mixes typed values and JSON')
  })

  it('runs strict analysis on the types of typed input', () => {
    const [first] = groups()
    expect(r4.evaluate('item.answer.value', [first!], { strict: true })).toHaveLength(2)
    expect(() => r4.evaluate('linkId - 1', [first!], { strict: true })).toThrow('Strict evaluation failed')
  })
})

describe('typed values in env', () => {
  const searchset = r4.toTyped(
    { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Medication', id: 'm1' } }] },
    'Bundle'
  )

  it('bind %context apart from the input, where $this and relative paths start', () => {
    const [first, second] = groups()
    const [mood] = r4.evaluateTyped('item', [second!])
    const options = { env: { context: [first!] } }
    expect(r4.evaluate('$this.answer.value.code', [mood!], options)).toEqual(['high'])
    expect(r4.evaluate('%context.item.answer.value.code', [mood!], options)).toEqual(['low', 'high'])
    expect(r4.evaluate('%resource.status', [mood!], options)).toEqual(['completed'])
  })

  it('keep their FHIR types and ancestry', () => {
    const root = r4.toTyped(response, 'QuestionnaireResponse')
    const [first] = r4.evaluateTyped("item.where(linkId = 'group')", root)
    const options = { env: { group: first } }
    expect(r4.evaluate('%group.item.answer.value.code', response, options)).toEqual(['low', 'high'])
    // pathname() gives paths inside the input's resource, which a JSON input is not.
    expect(r4.evaluate('%group.item.answer.first().pathname()', root, options)).toEqual([
      'QuestionnaireResponse.item[0].item[0].answer[0]',
    ])
    expect(r4.evaluate('%group.item.answer.first().pathname()', response, options)).toEqual([])
    // The same JSON is untyped, so its choice elements do not resolve.
    expect(r4.evaluate('%group.item.answer.value', response, { env: { group: response.item[0] } })).toEqual([])
  })

  it('set %resource and %rootResource for a focus outside the resource', () => {
    const [first] = groups()
    const resource = r4.toTyped(response, 'QuestionnaireResponse')
    const env = { context: [first!], resource, rootResource: resource }
    expect(r4.evaluate('entry.resource.id', searchset, { env })).toEqual(['m1'])
    expect(r4.evaluate('%resource.status', searchset, { env })).toEqual(['completed'])
    expect(r4.evaluate('%context.linkId', searchset, { env })).toEqual(['group'])
    expect(r4.evaluate('%resource.type', searchset)).toEqual(['searchset'])
  })

  it('set %resource for a copy of an item that is not inside the resource', () => {
    const [mood] = r4.evaluate("item.item.where(linkId = 'mood')", response) as { answer: unknown[] }[]
    const copy = r4.toTyped({ ...mood, answer: mood!.answer.slice(1) }, 'QuestionnaireResponse.item')
    const env = { resource: response, rootResource: response }
    expect(r4.evaluate('answer.value.code', copy, { env })).toEqual(['high'])
    expect(r4.evaluate('%resource.status', copy, { env })).toEqual(['completed'])
  })

  it('refuse an array that mixes typed values and JSON', () => {
    const [first] = groups()
    expect(() => r4.evaluate('%group', response, { env: { group: [first!, { linkId: 'json' }] } })).toThrow(
      'The env value %group mixes typed values and JSON'
    )
  })

  it('type %context, %resource, and their own names under strict evaluation', () => {
    const [first] = groups()
    const options = { env: { context: [first!], group: first }, strict: true }
    expect(r4.evaluate('%context.linkId | %group.linkId', searchset, options)).toEqual(['group'])
    expect(() => r4.evaluate('%context.lnkId', searchset, options)).toThrow('Strict evaluation failed')
    expect(() => r4.evaluate('%group.lnkId', searchset, options)).toThrow('Strict evaluation failed')
    expect(() => r4.evaluate('entry.resorce', searchset, options)).toThrow('Strict evaluation failed')
  })
})

describe('a declared root with typed input', () => {
  const answers = compile('item.answer.value', 'QuestionnaireResponse.item')

  it('accepts values of the declared type', () => {
    expect(answers.evaluate(groups().slice(0, 1), { model: r4.defaults.model! })).toHaveLength(2)
  })

  it('refuses values of another type', () => {
    expect(() => answers.evaluate(r4.evaluateTyped('$this', response), { model: r4.defaults.model! })).toThrow(
      'declares its root as FHIR.QuestionnaireResponse.item'
    )
  })

  it('refuses a contained resource under a resource root', () => {
    const observation = { resourceType: 'Observation', contained: [{ resourceType: 'Patient', id: 'p' }] }
    const patients = r4.evaluateTyped('contained', observation)
    expect(() => r4.compile('id', 'Patient').evaluate(patients)).toThrow('contained resource')
    expect(r4.compile('id', 'Resource').evaluate(r4.evaluateTyped('$this', observation))).toEqual([])
  })

  it('refuses JSON under a root other than a resource', () => {
    const nickname = { url: 'http://example.org/nickname', valueString: 'Pete' }
    const patient = { resourceType: 'Patient' as const, extension: [nickname] }
    // @ts-expect-error JSON has no owning resource for %resource
    expect(() => r4.compile('value', 'Extension').evaluate(nickname)).toThrow("toTyped(value, 'Extension'")
    // @ts-expect-error a backbone root too
    expect(() => r4.compile('linkId', 'QuestionnaireResponse.item').evaluate({ linkId: 'q' })).toThrow(
      'takes typed input'
    )
    expect(r4.compile('value', 'Extension').evaluate([])).toEqual([])
    expect(r4.compile('value', 'Extension').evaluate(r4.toTyped(nickname, 'Extension', { in: patient }))).toEqual([
      'Pete',
    ])
  })

  it('does not check JSON input', () => {
    expect(r4.compile('id', 'Patient').evaluate({ resourceType: 'Patient', id: 'p' })).toEqual(['p'])
  })
})

describe('toTyped()', () => {
  const item = response.item[2]!

  it('finds a value inside its resource and keeps its ancestry', () => {
    const typed = r4.toTyped(item, 'QuestionnaireResponse.item', { in: response })
    expect(r4.evaluate('answer.value.extension.url', typed)).toEqual(['urn:x'])
    expect(r4.evaluate('%resource.status', typed)).toEqual(['completed'])
    expect(r4.evaluate('answer.pathname()', typed)).toEqual(['QuestionnaireResponse.item[2].answer[0]'])
    expect(r4.toTyped(response, 'Resource', { in: response }).map(value => value.type)).toEqual([
      'FHIR.QuestionnaireResponse',
    ])
  })

  it('types a value without ancestry when no resource is given', () => {
    const typed = r4.toTyped({ linkId: 'q', answer: [{ valueInteger: 2 }] }, 'QuestionnaireResponse.item')
    expect(r4.evaluate('answer.value = 2', typed)).toEqual([true])
    expect(r4.evaluate('answer.value.pathname()', typed)).toEqual(['answer[0].value[0]'])
    expect(() => r4.evaluate('%resource', typed)).toThrow('%resource is not available')
    expect(() => r4.evaluate('%rootResource', typed)).toThrow('%rootResource is not available')
    expect(() => r4.evaluate('linkId', typed, { vars: { resource: typed } })).toThrow('Cannot override')
    expect(() => r4.evaluate("defineVariable('resource', 'x').select(%resource)", typed)).toThrow('Cannot override')
    expect(r4.evaluate('%resource.linkId', typed, { env: { resource: { linkId: 'host' } } })).toEqual(['host'])
  })

  it('refuses values it cannot type', () => {
    expect(() => r4.toTyped({ linkId: 'x' }, 'QuestionnaireResponse.item', { in: response })).toThrow(
      'not inside the resource'
    )
    const shared = { linkId: 'shared' }
    const twice = { resourceType: 'QuestionnaireResponse', item: [shared, shared] }
    expect(() => r4.toTyped(shared, 'QuestionnaireResponse.item', { in: twice })).toThrow('more than once')
    expect(() => r4.toTyped('note', 'string', { in: response })).toThrow('primitive')
    expect(() => r4.toTyped(item, 'Patient', { in: response })).toThrow(
      'the value is FHIR.QuestionnaireResponse.item, not FHIR.Patient'
    )
    expect(() => r4.toTyped(response, 'Patient')).toThrow('not FHIR.Patient')
    expect(() => r4.toTyped(item, 'QuestionnaireResponse.item', { in: item })).toThrow("'in' must be a resource")
    expect(() => new FhirPathEngine().toTyped(item, 'QuestionnaireResponse.item')).toThrow(
      'needs an engine with a model'
    )
    expect(() => r4.toTyped(item, 'Nope' as 'Patient')).toThrow("unknown type 'Nope'")
  })
})

describe('%resource and %rootResource types', () => {
  const resultTypes = (expression: string, inputType: string) =>
    analyzeExpressionDetailed(expression, { model: r4Model, inputType }).result.types

  it('read a backbone root as part of the resource its path starts with', () => {
    expect(resultTypes('%resource', 'QuestionnaireResponse.item')).toEqual(['FHIR.QuestionnaireResponse'])
    expect(resultTypes('%rootResource', 'QuestionnaireResponse.item')).toBeUndefined()
    expect(resultTypes('%context', 'QuestionnaireResponse.item')).toEqual(['FHIR.QuestionnaireResponse.item'])
  })

  it('know no resource for a datatype root', () => {
    expect(resultTypes('%resource', 'CodeableConcept')).toBeUndefined()
    expect(resultTypes('%rootResource', 'CodeableConcept')).toBeUndefined()
  })

  it('keep a resource root as its own resource', () => {
    expect(resultTypes('%resource', 'Patient')).toEqual(['FHIR.Patient'])
    expect(resultTypes('%rootResource', 'Patient')).toEqual(['FHIR.Patient'])
  })

  it('come from the ancestry of typed input under strict evaluation', () => {
    const observation = { resourceType: 'Observation' as const, contained: [{ resourceType: 'Patient' as const }] }
    const patients = r4.evaluateTyped('contained', observation)
    expect(r4.evaluate('%rootResource.status', patients, { strict: true })).toEqual([])
    expect(() => r4.evaluate('%rootResource.gender', patients, { strict: true })).toThrow('Strict evaluation failed')
  })
})
