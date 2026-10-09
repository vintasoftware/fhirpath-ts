import { FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

const base = new FhirPathEngine({ model: r4Model })

export class PatientRow extends base.defineDto('Patient') {
  family = this.column('name.family.first()', { default: '' })
}

export const engine = base.register(PatientRow)
