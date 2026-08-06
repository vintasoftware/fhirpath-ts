import type {
  Condition,
  DiagnosticReport,
  MedicationRequest,
  Observation,
  Patient,
  ServiceRequest,
} from '@medplum/fhirtypes'

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
// end to end, analyzes the expressions no checker can discover (see
// ANALYZED_EXPRESSIONS), and runs `fhirpath-check` over this directory's DTOs.

// --- helpers ---

const PATIENT_DISPLAY_NAME =
  "(Patient.name.where(use = 'official') | Patient.name).first()" +
  ".select(iif(given.exists(), given.first().combine(family).join(' '), (text | family).first()))"

/** Greeting and avatar name, e.g. "Mary Miller": first given name + family, else `text`, family, or "there". */
export function patientDisplayName(patient: Patient): string {
  return fp.first(PATIENT_DISPLAY_NAME, patient, { type: 'string' }) ?? 'there'
}

// A record with no status fails this criteria (empty → false). R4 makes
// MedicationRequest.status 1..1, so that only affects malformed records, and
// hiding a statusless record from the patient is the safe direction.
const VISIBLE_MEDICATION = "(status in ('entered-in-error' | 'draft')).not()"

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
const WEIGHT_CRITERIA =
  "code.coding.exists(system = %loinc and code in ('29463-7' | '3141-9'))" +
  " and value.ofType(Quantity).convertsToQuantity('kg')"
const HEIGHT_CRITERIA =
  "code.coding.exists(system = %loinc and code = '8302-2')" + " and value.ofType(Quantity).convertsToQuantity('m')"

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
 * Maps MedicationRequests (active and past) to the Medications page view-model.
 * Adds status, dose, route, prescriber, and start/stop dates for the fuller list.
 * Unlike the Home card, `instructions` is the sig text only (no dose • route
 * fallback) because the detail row renders dose and route on their own. Stays
 * focused on the FHIR shape: the caller pairs the result with the resolved pharmacy.
 *
 * Applies the visibility rule itself (see isVisibleMedicationRequest), so the
 * status decode and the view's derived counts stay correct even when a caller
 * passes the raw resource set.
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

// --- static-analysis surface ---

/**
 * The expressions here that no checker can find on its own: they live in `const`s
 * (shared between a mapper and the exported predicate beside it), so every source
 * walker sees a variable rather than a literal, and they belong to no DTO. The
 * test beside this file analyzes each against the type it runs on.
 *
 * Nothing else needs listing. The DTOs are discovered — `fhirpath-check` imports
 * `patient-view.dto.ts` and checks every one against the engine it exports — and
 * every literal expression is checked by the ESLint rule.
 */
export const ANALYZED_EXPRESSIONS = [
  { expression: WEIGHT_CRITERIA, inputType: 'Observation' },
  { expression: HEIGHT_CRITERIA, inputType: 'Observation' },
  { expression: VISIBLE_MEDICATION, inputType: 'MedicationRequest' },
  { expression: PATIENT_DISPLAY_NAME, inputType: 'Patient' },
] as const
