import { defineDto, FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

export class PatientRow extends defineDto('Patient') {
  family = this.column('name.family.first()', { default: '' })
}

export const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [PatientRow] })
