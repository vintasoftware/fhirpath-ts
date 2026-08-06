import { describe, expect, it } from 'vitest'

import { r4Model } from '../r4/index.ts'
import { canonicalFocusType, typeSatisfies, typesOverlap, valueKindOfTypeName } from './type-compat.ts'

describe('canonicalFocusType', () => {
  it.each([
    ['Patient', 'FHIR.Patient'],
    // A runtime value's type is already prefixed; resolveType does not strip its
    // own prefix, so the local-name fallback is what canonicalizes it.
    ['FHIR.Patient', 'FHIR.Patient'],
    ['CodeableConcept', 'FHIR.CodeableConcept'],
    ['FHIR.code', 'FHIR.code'],
    // A backbone element resolves under its full path, not its local name.
    ['Patient.contact', 'FHIR.Patient.contact'],
    ['System.String', 'System.String'],
    ['System.Quantity', 'System.Quantity'],
  ])('canonicalizes %s', (raw, expected) => {
    expect(canonicalFocusType(r4Model, raw)).toBe(expected)
  })

  it.each(['Object', 'Nonesuch', 'Acme.Widget'])('leaves %s unknown, so callers stay silent', raw => {
    expect(canonicalFocusType(r4Model, raw)).toBeUndefined()
  })
})

describe('typeSatisfies', () => {
  it('walks the model hierarchy in one direction only', () => {
    expect(typeSatisfies(r4Model, 'FHIR.SimpleQuantity', 'FHIR.Quantity')).toBe(true)
    expect(typeSatisfies(r4Model, 'FHIR.Quantity', 'FHIR.SimpleQuantity')).toBe(false)
  })

  it('reaches System types through the FHIR-primitive twins', () => {
    expect(typeSatisfies(r4Model, 'FHIR.code', 'System.String')).toBe(true)
    expect(typeSatisfies(r4Model, 'System.String', 'FHIR.code')).toBe(false)
  })
})

describe('typesOverlap', () => {
  const overlapping: [string, string][] = [
    ['FHIR.CodeableConcept', 'FHIR.CodeableConcept'],
    // Either direction of the hierarchy: a Quantity column reached on a
    // Dosage.doseAndRate.dose, and a SimpleQuantity column on a Quantity.
    ['FHIR.SimpleQuantity', 'FHIR.Quantity'],
    ['FHIR.Quantity', 'FHIR.SimpleQuantity'],
    // The two spellings of a quantity, which no model bridges.
    ['System.Quantity', 'FHIR.Quantity'],
    // Sibling primitives behave identically, so neither is a provable mistake.
    ['FHIR.code', 'FHIR.uri'],
    ['FHIR.code', 'System.String'],
    ['FHIR.dateTime', 'System.DateTime'],
    ['FHIR.Patient', 'FHIR.DomainResource'],
  ]
  it.each(overlapping)('%s and %s can be the same value', (a, b) => {
    expect(typesOverlap(r4Model, a, b)).toBe(true)
  })

  const disjoint: [string, string][] = [
    ['FHIR.CodeableConcept', 'FHIR.code'],
    ['FHIR.CodeableConcept', 'FHIR.Quantity'],
    ['FHIR.Patient', 'FHIR.Observation'],
    ['FHIR.Patient.contact', 'FHIR.CodeableConcept'],
    ['FHIR.code', 'FHIR.integer'],
    ['System.String', 'FHIR.Quantity'],
  ]
  it.each(disjoint)('%s and %s can never be the same value', (a, b) => {
    expect(typesOverlap(r4Model, a, b)).toBe(false)
  })

  it('keeps every complex type distinct, unlike the value kinds', () => {
    // Both are Complex, so a kind-only rule would call them compatible.
    expect(valueKindOfTypeName('FHIR.CodeableConcept')).toBe('Complex')
    expect(valueKindOfTypeName('FHIR.Patient')).toBe('Complex')
    expect(typesOverlap(r4Model, 'FHIR.CodeableConcept', 'FHIR.Patient')).toBe(false)
  })
})
