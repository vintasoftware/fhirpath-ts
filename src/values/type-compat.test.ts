import { describe, expect, it } from 'vitest'

import { r4Model } from '../r4/index.ts'
import { canonicalFocusType, typesOverlap, unsatisfiedInput, valueKindOfTypeName } from './type-compat.ts'

describe('canonicalFocusType', () => {
  it.each([
    ['Patient', 'FHIR.Patient'],
    // A runtime value's type already carries the prefix, and resolveType does
    // not strip its own prefix, so the local-name fallback canonicalizes it.
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

  it('reaches System types through the FHIR-primitive twins, in one direction each', () => {
    // The underlying subtyping is directional; typesOverlap asks both ways, so
    // a String-declared function accepts a code focus and the reverse.
    expect(typesOverlap(r4Model, 'FHIR.code', 'System.String')).toBe(true)
    expect(typesOverlap(r4Model, 'System.String', 'FHIR.code')).toBe(true)
  })

  it('keeps every complex type distinct, unlike the value kinds', () => {
    // Both are Complex, so a kind-only rule would call them compatible.
    expect(valueKindOfTypeName('FHIR.CodeableConcept')).toBe('Complex')
    expect(valueKindOfTypeName('FHIR.Patient')).toBe('Complex')
    expect(typesOverlap(r4Model, 'FHIR.CodeableConcept', 'FHIR.Patient')).toBe(false)
  })
})

describe('unsatisfiedInput', () => {
  const wants = (declared: string[], focus: string[]) => unsatisfiedInput(r4Model, declared, focus)

  it('proves the mistake, naming both sides canonically', () => {
    expect(wants(['CodeableConcept'], ['FHIR.code'])).toEqual({
      wanted: ['FHIR.CodeableConcept'],
      found: ['FHIR.code'],
    })
    // Local and canonical spellings of the declaration agree.
    expect(wants(['FHIR.CodeableConcept'], ['FHIR.code'])?.wanted).toEqual(['FHIR.CodeableConcept'])
  })

  it('says nothing whenever nothing is proven', () => {
    // Compatible focus, either direction of the hierarchy.
    expect(wants(['CodeableConcept'], ['FHIR.CodeableConcept'])).toBeUndefined()
    expect(wants(['Quantity'], ['FHIR.SimpleQuantity'])).toBeUndefined()
    // One fitting candidate is enough, wherever it sits in the collection.
    expect(wants(['CodeableConcept'], ['FHIR.code', 'FHIR.CodeableConcept'])).toBeUndefined()
    expect(wants(['CodeableConcept'], ['FHIR.CodeableConcept', 'FHIR.code'])).toBeUndefined()
    // A focus type no model describes, and an empty focus.
    expect(wants(['CodeableConcept'], ['Object'])).toBeUndefined()
    expect(wants(['CodeableConcept'], [])).toBeUndefined()
    // A declaration this model cannot resolve, no declaration, no model.
    expect(wants(['Widget'], ['FHIR.code'])).toBeUndefined()
    expect(wants([], ['FHIR.code'])).toBeUndefined()
    expect(unsatisfiedInput(r4Model, undefined, ['FHIR.code'])).toBeUndefined()
    expect(unsatisfiedInput(undefined, ['CodeableConcept'], ['FHIR.code'])).toBeUndefined()
  })

  it('dedupes the focus it reports, and stops at the first item that fits', () => {
    expect(wants(['CodeableConcept'], ['FHIR.code', 'FHIR.code', 'FHIR.uri'])?.found).toEqual(['FHIR.code', 'FHIR.uri'])
    // The fitting item ends the scan, so nothing behind it is read. This fails
    // if the loop ever goes back to reading the whole collection first.
    const lazy = (function* () {
      yield 'FHIR.CodeableConcept'
      throw new Error('scanned past the item that fits')
    })()
    expect(unsatisfiedInput(r4Model, ['CodeableConcept'], lazy)).toBeUndefined()
  })
})
