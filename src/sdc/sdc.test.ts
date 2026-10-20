import { describe, expect, it } from 'vitest'

import { r4 } from '../r4/index.ts'
import { sdcScope } from './index.ts'

const ordinal = (valueDecimal: number) => [
  { url: 'http://hl7.org/fhir/StructureDefinition/ordinalValue', valueDecimal },
]
const questionnaire = {
  resourceType: 'Questionnaire',
  item: [
    {
      linkId: 'medication',
      type: 'group',
      repeats: true,
      text: 'Medication',
      item: [
        { linkId: 'name', type: 'string', text: 'Name' },
        { linkId: 'dose', type: 'quantity', text: 'Dose' },
      ],
    },
    {
      linkId: 'pain',
      type: 'choice',
      text: 'Pain',
      answerOption: [
        { valueCoding: { system: 'urn:pain', code: 'none' }, extension: ordinal(0) },
        { valueCoding: { system: 'urn:pain', code: 'severe' }, extension: ordinal(4) },
      ],
      item: [{ linkId: 'pain-note', type: 'string', text: 'Note' }],
    },
  ],
}
const response = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  subject: { reference: 'Patient/example' },
  item: [
    {
      linkId: 'medication',
      item: [
        { linkId: 'name', answer: [{ valueString: 'Aspirin' }] },
        { linkId: 'dose', answer: [{ valueQuantity: { value: 100, unit: 'mg' } }] },
      ],
    },
    {
      linkId: 'medication',
      item: [{ linkId: 'name', answer: [{ valueString: 'Ibuprofen' }] }],
    },
    {
      linkId: 'pain',
      answer: [{ valueCoding: { system: 'urn:pain', code: 'severe' }, item: [{ linkId: 'pain-note' }] }],
    },
  ],
}

describe('sdcScope().contexts()', () => {
  it('visits the response, then each item instance depth-first, with %qitem', () => {
    const visited = [...sdcScope(r4, questionnaire).contexts(response)].map(({ context, vars }) => [
      r4.evaluate("iif(%context is QuestionnaireResponse, 'root', linkId)", context, { vars }),
      vars.qitem === undefined ? [] : r4.evaluate('%qitem.text', context, { vars }),
    ])
    expect(visited).toEqual([
      [['root'], []],
      [['medication'], ['Medication']],
      [['name'], ['Name']],
      [['dose'], ['Dose']],
      [['medication'], ['Medication']],
      [['name'], ['Name']],
      [['pain'], ['Pain']],
      [['pain-note'], ['Note']],
    ])
  })

  it('binds %questionnaire for weight() at each item', () => {
    const pain = [...sdcScope(r4, questionnaire).contexts(response)].find(
      ({ context }) => r4.first("linkId = 'pain'", context) === true
    )
    expect(r4.evaluate('answer.value.weight()', pain!.context, { vars: pain!.vars })).toEqual([4])
    expect(r4.evaluate('%resource.status', pain!.context)).toEqual(['completed'])
  })
})

describe('template extraction through typed contexts', () => {
  // templateExtractContext selects the contexts; each value expression runs at one of them.
  it('builds one resource per repeated group instance', () => {
    const scope = sdcScope(r4, questionnaire)
    const [root] = scope.contexts(response)
    const medications = r4.evaluateTyped("item.where(linkId = 'medication')", root!.context)
    const statements = medications.map(medication => {
      const context = [medication]
      const vars = scope.vars(context)
      return {
        resourceType: 'MedicationStatement',
        subject: r4.first('%resource.subject', context, { vars }),
        medication: r4.first("item.where(linkId = 'name').answer.value", context, { vars }),
        dose: r4.first("item.where(linkId = 'dose').answer.value", context, { vars }),
        group: r4.first('%qitem.text', context, { vars }),
      }
    })
    expect(statements).toEqual([
      {
        resourceType: 'MedicationStatement',
        subject: { reference: 'Patient/example' },
        medication: 'Aspirin',
        dose: { value: 100, unit: 'mg' },
        group: 'Medication',
      },
      {
        resourceType: 'MedicationStatement',
        subject: { reference: 'Patient/example' },
        medication: 'Ibuprofen',
        dose: undefined,
        group: 'Medication',
      },
    ])
  })
})

describe('sdcScope().vars()', () => {
  it('gives only %questionnaire at the response root', () => {
    const root = r4.evaluateTyped('$this', response)
    expect(Object.keys(sdcScope(r4, questionnaire).vars(root))).toEqual(['questionnaire'])
  })

  it('refuses an item the Questionnaire does not define', () => {
    const items = r4.toTyped({ linkId: 'unknown' }, 'QuestionnaireResponse.item')
    expect(() => sdcScope(r4, questionnaire).vars(items)).toThrow("no item with linkId 'unknown'")
  })

  it('refuses a context that mixes linkIds', () => {
    const items = r4.evaluateTyped('item', response)
    expect(() => sdcScope(r4, questionnaire).vars(items)).toThrow('one linkId')
  })
})
