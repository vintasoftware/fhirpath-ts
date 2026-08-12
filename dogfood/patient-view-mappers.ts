import type {
  Condition,
  DiagnosticReport,
  MedicationRequest,
  Observation,
  Patient,
  ServiceRequest,
} from '@medplum/fhirtypes'
import { fhirpath } from 'fhirpath-ts'

import {
  fp,
  HeightRow,
  LabResultRow,
  LabRow,
  MedicationCardRow,
  MedicationDetailRow,
  ObservationRow,
  ProblemRow,
  round1,
  WeightRow,
} from './patient-view.dto.ts'
import type {
  LabResultRow as LabResultView,
  LabView,
  MedicationDetailView,
  MedicationView,
  ProblemView,
  VitalTrend,
} from './types'

// Real-usage module: FHIR-to-view-model mappers from a patient-portal app. It
// lives here so the high-level API keeps working the way an app uses it — the
// row shapes are in patient-view.dto.ts beside this file, and these are the
// functions an app calls. The test beside this file asserts every exported mapper
// end to end, and runs `fhirpath-check` over this directory's DTOs. Nothing in
// here needs listing for the checkers: the DTOs are discovered, every literal is
// a checked call site, and the shared expressions declare their own root.

// --- helpers ---

// One literal each, not a `+` concatenation: a concatenated argument is dynamic,
// and these are the expressions only `fhirpath(expr, root)` can make checkable —
// they live in a `const` and are evaluated elsewhere, so the root travels with
// the declaration.
// prettier-ignore
const PATIENT_DISPLAY_NAME = fhirpath("(Patient.name.where(use = 'official') | Patient.name).first().select(iif(given.exists(), given.first().combine(family).join(' '), (text | family).first()))", 'Patient')

/** Greeting and avatar name, e.g. "Mary Miller": first given name + family, else `text`, family, or "there". */
export function patientDisplayName(patient: Patient): string {
  return fp.first(PATIENT_DISPLAY_NAME, patient) ?? 'there'
}

// A record with no status fails this criteria (empty → false). R4 makes
// MedicationRequest.status 1..1, so that only affects malformed records, and
// hiding a statusless record from the patient is the safe direction.
const VISIBLE_MEDICATION = fhirpath("(status in ('entered-in-error' | 'draft')).not()", 'MedicationRequest')

/**
 * Whether a MedicationRequest may be shown to the patient. Drops entered-in-error
 * and draft records so a data-entry mistake or an unsent draft never reaches them.
 * This rule lives only here: `mapMedicationDetails` applies it itself, and
 * server code that fetches requests outside the mapper's path filters with it too.
 */
export function isVisibleMedicationRequest(request: MedicationRequest): boolean {
  return fp.test(request, VISIBLE_MEDICATION)
}

/**
 * Whether this request is an order of its own, rather than one line of another order.
 *
 * Health Gorilla splits an order into a parent plus one child per ordered test, each child naming the
 * parent in `basedOn`. Looks for a missing parent rather than for children,
 * so a single-test order still counts. A one-hop check, so plain TS rather than an expression.
 */
export function isTopLevelOrder(order: ServiceRequest): boolean {
  return !order.basedOn?.length
}

/** Percent change of the last reading vs the previous one; null with fewer than two points or a zero base. */
function trendPercent(series: number[]): number | null {
  const previous = series[series.length - 2]
  const latest = series[series.length - 1]
  if (previous === undefined || latest === undefined || previous === 0) {
    return null
  }
  return round1(((latest - previous) / previous) * 100)
}

// --- mappers ---

// A reading must carry a UCUM code the engine can convert ('kg', '[lb_av]', 'cm',
// '[in_i]', …). convertsToQuantity() drops a display-only unit like `unit: "lbs"`
// with no code instead of guessing what it means.
// prettier-ignore
const WEIGHT_CRITERIA = fhirpath("code.coding.exists(system = %loinc and code in ('29463-7' | '3141-9')) and value.ofType(Quantity).convertsToQuantity('kg')", 'Observation')
// prettier-ignore
const HEIGHT_CRITERIA = fhirpath("code.coding.exists(system = %loinc and code = '8302-2') and value.ofType(Quantity).convertsToQuantity('m')", 'Observation')

/**
 * Builds the vitals view-model from vital-sign Observations. Weight comes straight
 * from body-weight readings (as a trend, no range status). BMI is derived per
 * weight reading using the latest height, and carries a range status. Only vitals
 * with data are returned.
 *
 * toQuantity() does the unit conversion with exact decimals. The series math and
 * time sorting stay in TypeScript, next to the trend arithmetic.
 */
export function mapVitals(observations: Observation[]): VitalTrend[] {
  const weights = fp.project(fp.filter(observations, WEIGHT_CRITERIA), WeightRow).sort(ObservationRow.byObservedAt)
  const heights = fp.project(fp.filter(observations, HEIGHT_CRITERIA), HeightRow).sort(ObservationRow.byObservedAt)

  const vitals: VitalTrend[] = []

  const weightSeries = weights.map(row => row.roundedLbs)
  const latestWeight = weightSeries.at(-1)
  if (latestWeight !== undefined) {
    vitals.push({
      key: 'weight',
      label: 'Weight',
      value: latestWeight,
      unit: 'lbs',
      status: null,
      trendPct: trendPercent(weightSeries),
      series: weightSeries,
    })
  }

  const latestHeightMeters = heights.at(-1)?.meters
  if (latestHeightMeters && latestHeightMeters > 0) {
    const bmiSeries = weights.map(row => row.bmi(latestHeightMeters))
    const latestBmi = bmiSeries.at(-1)
    if (latestBmi !== undefined) {
      vitals.push({
        key: 'bmi',
        label: 'BMI',
        value: latestBmi,
        unit: 'kg/m²',
        status: WeightRow.bmiStatus(latestBmi),
        trendPct: trendPercent(bmiSeries),
        series: bmiSeries,
      })
    }
  }

  return vitals
}

/** Maps active MedicationRequests to the Home-card medication view-model. */
export function mapMedications(requests: MedicationRequest[]): MedicationView[] {
  return fp.project(requests, MedicationCardRow)
}

/**
 * Maps visible medication requests for the details page. Instructions contain
 * only sig text because dose and route have separate fields. The caller adds the
 * resolved pharmacy.
 */
export function mapMedicationDetails(requests: MedicationRequest[]): MedicationDetailView[] {
  return fp.project(fp.filter(requests, VISIBLE_MEDICATION), MedicationDetailRow)
}

/**
 * Maps problem-list Conditions to the problem view-model. Conditions marked
 * `entered-in-error` are dropped, since a retracted problem must never show to the patient
 * and there is no server-side FHIR modifier for that in this repo. Dropping them here means every
 * caller gets the same list, so the returned array can be shorter than the input.
 */
export function mapProblems(conditions: Condition[]): ProblemView[] {
  return fp.project(
    fp.filter(conditions, "(verificationStatus.coding.code contains 'entered-in-error').not()"),
    ProblemRow
  )
}

/**
 * Maps lab `DiagnosticReport`s to the Lab History view-model, preserving input order (the
 * server sorts newest-first). Does not set `documentUrl`: the consuming app owns how it
 * serves binaries, so it adds that field itself.
 */
export function mapLabs(reports: DiagnosticReport[]): Omit<LabView, 'documentUrl'>[] {
  return fp.project(reports, LabRow)
}

/**
 * Maps lab orders to the Lab Results rows. Carries `reportId` rather than a
 * `documentUrl`, because the consuming app owns how it serves binaries.
 */
export function mapLabResults(
  orders: ServiceRequest[],
  reportsByOrderId: Map<string, DiagnosticReport>
): LabResultView[] {
  const reports = [...reportsByOrderId].map(([orderId, report]) => ({ orderId, report }))
  return fp.project(orders.filter(isTopLevelOrder), LabResultRow, { env: { reports } })
}
