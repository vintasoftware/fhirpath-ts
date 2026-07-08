import { describe, expect, it } from 'vitest'

import { evaluate } from '../api/evaluate.ts'
import { r4Model } from './index.ts'

describe('r4Model type resolution', () => {
  it('resolves resources, datatypes, and primitives', () => {
    expect(r4Model.resolveType('Patient')).toBe('FHIR.Patient')
    expect(r4Model.resolveType('HumanName')).toBe('FHIR.HumanName')
    expect(r4Model.resolveType('string')).toBe('FHIR.string')
    expect(r4Model.resolveType('Nope')).toBeUndefined()
  })

  it('knows the type hierarchy', () => {
    expect(r4Model.isSubtypeOf('FHIR.Patient', 'FHIR.DomainResource')).toBe(true)
    expect(r4Model.isSubtypeOf('FHIR.Patient', 'FHIR.Resource')).toBe(true)
    expect(r4Model.isSubtypeOf('FHIR.Patient', 'FHIR.Patient')).toBe(true)
    expect(r4Model.isSubtypeOf('FHIR.Patient', 'FHIR.Observation')).toBe(false)
    expect(r4Model.isSubtypeOf('FHIR.Quantity', 'FHIR.Element')).toBe(true)
    expect(r4Model.isSubtypeOf('System.Integer', 'FHIR.Resource')).toBe(false)
  })
})

describe('r4Model element lookup', () => {
  it('finds plain elements with cardinality', () => {
    expect(r4Model.getElement('FHIR.Patient', 'birthDate')).toEqual({
      types: ['date'],
      isCollection: false,
      isChoice: false,
    })
    expect(r4Model.getElement('FHIR.Patient', 'name')).toEqual({
      types: ['HumanName'],
      isCollection: true,
      isChoice: false,
    })
    expect(r4Model.getElement('FHIR.HumanName', 'given')).toEqual({
      types: ['string'],
      isCollection: true,
      isChoice: false,
    })
    expect(r4Model.getElement('FHIR.Patient', 'nope')).toBeUndefined()
    expect(r4Model.getElement('FHIR.Nope', 'x')).toBeUndefined()
  })

  it('resolves choice elements by stem name', () => {
    const value = r4Model.getElement('FHIR.Observation', 'value')
    expect(value?.isCollection).toBe(false)
    expect(value?.types).toContain('Quantity')
    expect(value?.types).toContain('string')
    expect(value?.types).toContain('CodeableConcept')
    const deceased = r4Model.getElement('FHIR.Patient', 'deceased')
    expect(deceased?.types).toEqual(['boolean', 'dateTime'])
    expect(deceased?.isChoice).toBe(true)
    expect(value?.isChoice).toBe(true)
  })

  it('types backbone elements by their path and finds their children', () => {
    expect(r4Model.getElement('FHIR.Patient', 'contact')?.types).toEqual(['Patient.contact'])
    expect(r4Model.getElement('Patient.contact', 'name')?.types).toEqual(['HumanName'])
  })

  it('gives inline components the correct base: Element vs BackboneElement', () => {
    // Patient.contact is a BackboneElement; Timing.repeat is a plain Element. The
    // generator must not hardcode BackboneElement for every inline component.
    expect(r4Model.isSubtypeOf('Patient.contact', 'BackboneElement')).toBe(true)
    expect(r4Model.isSubtypeOf('Timing.repeat', 'Element')).toBe(true)
    expect(r4Model.isSubtypeOf('Timing.repeat', 'BackboneElement')).toBe(false)
  })

  it('follows contentReference recursion', () => {
    expect(r4Model.getElement('FHIR.Questionnaire', 'item')?.types).toEqual(['Questionnaire.item'])
    expect(r4Model.getElement('Questionnaire.item', 'item')?.types).toEqual(['Questionnaire.item'])
    expect(r4Model.getElement('Questionnaire.item', 'text')?.types).toEqual(['string'])
  })

  it('inherits elements from base types', () => {
    expect(r4Model.getElement('FHIR.Patient', 'id')?.types).toEqual(['System.String'])
    expect(r4Model.getElement('FHIR.Patient', 'extension')?.isCollection).toBe(true)
    expect(r4Model.getElement('FHIR.Observation', 'contained')?.types).toEqual(['Resource'])
  })
})

describe('model-aware evaluation', () => {
  const patient = { resourceType: 'Patient', id: 'p', name: [{ given: ['Ann'] }] }

  it('the root type rule uses the hierarchy', () => {
    expect(evaluate('Resource.id', patient, { model: r4Model })).toEqual(['p'])
    expect(evaluate('DomainResource.name.given', patient, { model: r4Model })).toEqual(['Ann'])
    // A mismatched root type navigates to empty (the analyzer flags it statically).
    expect(evaluate('Observation.id', patient, { model: r4Model })).toEqual([])
  })

  it('is resolves model types for resources', () => {
    // Model-typed navigation of non-resource elements (name -> HumanName) arrives
    // with the FHIR-extras phase; resources already carry their type here.
    expect(evaluate('$this is DomainResource', patient, { model: r4Model })).toEqual([true])
    expect(evaluate('$this is Observation', patient, { model: r4Model })).toEqual([false])
  })
})
