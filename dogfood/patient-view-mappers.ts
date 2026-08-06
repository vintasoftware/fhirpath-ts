import type {
  Condition,
  DiagnosticReport,
  MedicationRequest,
  Observation,
  Patient,
  ServiceRequest,
} from '@medplum/fhirtypes'
import { type ColumnBuilder, defineDto, FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

import type {
  LabResultRow,
  LabView,
  MedicationDetailView,
  MedicationView,
  ProblemView,
  StatusTone,
  VitalStatus,
  VitalTrend,
} from './types'

// Real-usage module: FHIR-to-view-model mappers from a patient-portal app.
// It lives here so the high-level API keeps working the way an app uses it —
// DTO definitions, shared columns, vars joins, display tables, and enum columns,
// with @medplum/fhirtypes inputs. The test beside this file asserts every
// exported mapper end to end and runs both analyzers over every expression
// (see ANALYZED_USAGE at the bottom).

export const LOINC = 'http://loinc.org'

/** How a lab badge renders. */
type LabBadge = { label: string; tone: StatusTone; flagged: boolean }

type StatusMeta = { label: string; tone: StatusTone }

// --- resource DTOs ---
// Each DTO binds recurring chains to one resource or datatype. Registered on the
// engine below, every column becomes a function any expression can call, and each
// DTO's env tables register engine-wide with it.

const CodeableConceptDTO = defineDto({
  fhirType: 'CodeableConcept',
  columns: c => ({
    /** The text | display | code fallback. */
    displayText: c('(text | coding.display.first() | coding.first().code).first()', { type: 'string' }),
  }),
})

const MedicationRequestDTO = defineDto({
  fhirType: 'MedicationRequest',
  columns: c => ({
    medicationName: c(
      '(medication.ofType(CodeableConcept).displayText() | medication.ofType(Reference).display).first()',
      { type: 'string' }
    ),
    doseText: c(
      'dosageInstruction.first().doseAndRate.first().dose.ofType(Quantity)' +
        ".select(value.toString().combine((unit | code).first()).join(' '))",
      { type: 'string' }
    ),
    routeText: c('dosageInstruction.first().route.select(text | coding.display.first()).first()', { type: 'string' }),
    sigText: c('dosageInstruction.first().text'),
  }),
})

const ConditionDTO = defineDto({
  fhirType: 'Condition',
  columns: c => ({ clinicalStatusCode: c('clinicalStatus.coding.first().code') }),
})

/**
 * reportBadge() picks a report's badge row: the interpretation row when the Health
 * Gorilla extension carries one (only those can flag), else the workflow-status
 * row. Inside `where()` the focus is the table row being scanned, so the body
 * first saves its own input as %r to keep the report reachable by name.
 */
const DiagnosticReportDTO = defineDto({
  fhirType: 'DiagnosticReport',
  env: {
    // Health Gorilla puts the report-level interpretation (Normal / Abnormal / High …)
    // in an extension on the DiagnosticReport, using HL7 v2-0078 codes.
    hgInterpretation: 'https://www.healthgorilla.com/fhir/StructureDefinition/diagnosticreport-interpretation',
    // How each interpretation code shows on the card; `flagged` adds the warning
    // triangle. The codes are the standard HL7 interpretation codes (system v2-0078);
    // see https://hl7.org/fhir/R4/valueset-observation-interpretation.html.
    // The label/tone/flagged values are our own display choices.
    interpretationMeta: [
      { code: 'N', label: 'Normal', tone: 'success', flagged: false },
      { code: 'A', label: 'Abnormal', tone: 'warning', flagged: true },
      { code: 'AA', label: 'Critical', tone: 'danger', flagged: true },
      { code: 'H', label: 'Above Normal', tone: 'warning', flagged: true },
      { code: 'HH', label: 'Critically High', tone: 'danger', flagged: true },
      { code: 'L', label: 'Below Normal', tone: 'warning', flagged: true },
      { code: 'LL', label: 'Critically Low', tone: 'danger', flagged: true },
    ] as ({ code: string } & LabBadge)[],
    // Fallback badge per report workflow status when there's no interpretation. Carries
    // flagged: false so reportBadge() can return a row from either table as-is.
    reportStatusMeta: [
      { code: 'registered', label: 'Ordered', tone: 'info', flagged: false },
      { code: 'partial', label: 'Preliminary', tone: 'info', flagged: false },
      { code: 'preliminary', label: 'Preliminary', tone: 'info', flagged: false },
      { code: 'final', label: 'Final', tone: 'neutral', flagged: false },
      { code: 'amended', label: 'Amended', tone: 'neutral', flagged: false },
      { code: 'corrected', label: 'Corrected', tone: 'neutral', flagged: false },
      { code: 'appended', label: 'Amended', tone: 'neutral', flagged: false },
    ] as ({ code: string } & LabBadge)[],
  },
  columns: c => ({
    interpretation: c(
      'extension.where(url = %hgInterpretation).first().value.ofType(CodeableConcept).coding.first().code'
    ),
    reportBadge: c(
      "defineVariable('r')" +
        '.select((%interpretationMeta.where(code = %r.interpretation()) | %reportStatusMeta.where(code = %r.status)).first())'
    ),
  }),
})

// --- shared columns ---
// A column several DTOs use is a plain function of the builder: call it in the
// columns record and its type comes along.

/**
 * Row key: the resource id, else the row number. The expression always yields a
 * value, so the `default` exists only to type the column `string` instead of
 * `string | undefined`.
 */
const idColumn = <Root extends string>(c: ColumnBuilder<Root>) =>
  c('(id | %rowIndex.toString()).first()', { type: 'string', default: '' })

const observedAt = <Root extends string>(c: ColumnBuilder<Root>) =>
  c('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })

const medicationGroup = <Root extends string>(c: ColumnBuilder<Root>) =>
  c(
    'iif(dosageInstruction.first()' +
      '.select(asNeeded.ofType(boolean) = true or asNeeded.ofType(CodeableConcept).exists())' +
      ", 'asNeeded', 'continuous')",
    { enum: ['asNeeded', 'continuous'], default: 'continuous' }
  )

/** The badge columns every lab row renders, reading the per-row %badge binding. */
const badgeColumns = <Root extends string>(c: ColumnBuilder<Root>) => ({
  statusLabel: c('%badge.label', { type: 'string', default: 'Result' }),
  // The badge tables only hold StatusTone values; `enum` types the column as
  // that union and drops anything else, so `default` catches the unexpected.
  tone: c('%badge.tone', { enum: ['info', 'success', 'warning', 'danger', 'neutral'], default: 'neutral' }),
  flagged: c('%badge.flagged', { type: 'boolean', default: false }),
})

// One engine for every mapper, module-level so its parse cache warms once per bundle.
const fp = new FhirPathEngine({
  model: r4Model,
  env: { loinc: LOINC },
  resourceDtos: [CodeableConceptDTO, MedicationRequestDTO, ConditionDTO, DiagnosticReportDTO],
})

// --- view DTOs ---

/** Both lbs and kg on one row, so the weight trend and the BMI series come from one pass. */
const WeightRowDTO = defineDto({
  fhirType: 'Observation',
  columns: c => ({
    lbs: c("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 }),
    kg: c("value.ofType(Quantity).toQuantity('kg').value", { default: 0 }),
    at: observedAt(c),
  }),
})

const HeightRowDTO = defineDto({
  fhirType: 'Observation',
  columns: c => ({
    meters: c("value.ofType(Quantity).toQuantity('m').value", { default: 0 }),
    at: observedAt(c),
  }),
})

/** The Home-card medication view-model. */
const MedicationCardDTO = defineDto({
  fhirType: 'MedicationRequest',
  columns: c => ({
    id: idColumn(c),
    name: c('medicationName()', { type: 'string', default: 'Medication' }),
    // The sig text, else "dose • route" from the recorded parts (empty when neither exists).
    instructions: c("(sigText() | doseText().combine(routeText()).join(' • ')).first()", {
      type: 'string',
      default: '',
    }),
    group: medicationGroup(c),
  }),
})

/**
 * MedicationRequest.status display table. No rows for draft and entered-in-error:
 * the mapper filters those out before the lookup. The `unknown` row is the real
 * 'unknown' status code, not a fallback — unexpected codes take the columns' defaults.
 */
const MEDICATION_STATUS_META: ({ code: string } & StatusMeta)[] = [
  { code: 'active', label: 'Active', tone: 'success' },
  { code: 'on-hold', label: 'On Hold', tone: 'warning' },
  { code: 'stopped', label: 'Stopped', tone: 'neutral' },
  { code: 'cancelled', label: 'Cancelled', tone: 'danger' },
  { code: 'completed', label: 'Completed', tone: 'neutral' },
  { code: 'unknown', label: 'Unknown', tone: 'neutral' },
]

/** The Medications page view-model row. */
const MedicationDetailDTO = defineDto({
  fhirType: 'MedicationRequest',
  columns: c => ({
    id: idColumn(c),
    name: c('medicationName()', { type: 'string', default: 'Medication' }),
    dose: c('doseText()', { type: 'string', default: '' }),
    route: c('routeText()', { type: 'string', default: '' }),
    instructions: c('sigText()', { type: 'string', default: '' }),
    group: medicationGroup(c),
    // 'unknown' is itself a status code, so the default stays inside the inferred union.
    status: c('status', { default: 'unknown' }),
    statusLabel: c('status', { map: MEDICATION_STATUS_META, pick: 'label', default: 'Unknown' }),
    tone: c('status', { map: MEDICATION_STATUS_META, pick: 'tone', default: 'neutral' as StatusTone }),
    isActive: c.test("status = 'active'"),
    prescribedOn: c('authoredOn', { default: null }),
    // When a non-active request ended: the dispense validity end. Deliberately not
    // meta.lastUpdated — that is when the record row was last touched, not a clinical
    // end date, and the patient would see it as a real "ended on" date.
    endedOn: c("iif(status = 'active', {}, dispenseRequest.validityPeriod.end)", {
      type: 'dateTime',
      default: null,
    }),
    prescriber: c('requester.display', { default: null }),
  }),
})

/** Problem-list Condition.clinicalStatus display table. */
const PROBLEM_STATUS_META: ({ code: string } & StatusMeta)[] = [
  { code: 'active', label: 'Active', tone: 'info' },
  { code: 'recurrence', label: 'Recurrence', tone: 'danger' },
  { code: 'relapse', label: 'Relapse', tone: 'danger' },
  { code: 'remission', label: 'Remission', tone: 'warning' },
  { code: 'resolved', label: 'Resolved', tone: 'neutral' },
  { code: 'inactive', label: 'Inactive', tone: 'neutral' },
  { code: 'unknown', label: 'Unknown', tone: 'neutral' },
]

/** Title-case echo of a raw code, the label fallback for codes outside the display table. */
function titleCase(code: string): string {
  return code.charAt(0).toUpperCase() + code.slice(1)
}

/** The problem-list view-model row, keyed off clinicalStatus. */
const ProblemDTO = defineDto({
  fhirType: 'Condition',
  columns: c => ({
    id: idColumn(c),
    name: c('code.displayText()', { type: 'string', default: 'Condition' }),
    // The label needs a computed fallback (title-case the raw code), so it is an
    // `as` function; the tone's fallback is constant, so `map` + `default` do.
    statusLabel: c('clinicalStatusCode()', {
      as: (value: unknown) => PROBLEM_STATUS_META.find(row => row.code === value)?.label ?? titleCase(String(value)),
      default: 'Unknown',
    }),
    tone: c('clinicalStatusCode()', { map: PROBLEM_STATUS_META, pick: 'tone', default: 'neutral' as StatusTone }),
    lastUpdated: c('meta.lastUpdated', { default: null }),
  }),
})

/** The Lab History view-model row; the report itself carries the badge. */
const LabDTO = defineDto({
  fhirType: 'DiagnosticReport',
  vars: { badge: 'reportBadge()' },
  columns: c => ({
    ...badgeColumns(c),
    id: idColumn(c),
    name: c('code.displayText()', { type: 'string', default: 'Lab result' }),
    date: c('(effective.ofType(dateTime) | issued).first().toString()', { default: '' }),
  }),
})

/**
 * The Lab Results view-model row, one per order. `%report` joins the
 * order→report table passed per call (a linear where() scan, fine at portal
 * list sizes). `%badge` is the report's badge when one exists, else the order's
 * own state — a revoked order will never produce results, so it is cancelled
 * rather than waiting.
 */
const LabResultDTO = defineDto({
  fhirType: 'ServiceRequest',
  env: {
    // Badges for a lab order no table row can describe, because there is no report to read.
    waitingBadge: { label: 'Waiting', tone: 'warning', flagged: false } as LabBadge,
    cancelledBadge: { label: 'Cancelled', tone: 'neutral', flagged: false } as LabBadge,
  },
  vars: {
    report: '%reports.where(orderId = %context.id).report',
    badge:
      "iif(%report.exists(), %report.reportBadge(), iif(%context.status = 'revoked', %cancelledBadge, %waitingBadge))",
  },
  columns: c => ({
    ...badgeColumns(c),
    id: idColumn(c),
    // The ordered test names joined with commas; a blank join is dropped so the
    // order's own text can apply.
    name: c(
      "(code.coding.select((display | code).first()).distinct().join(', ').where($this != '') | code.text).first()",
      { type: 'string', default: 'Lab order' }
    ),
    // An order with no report shows its order date instead of a result date.
    // One literal (not a `+` concatenation): TypeScript types concatenation as
    // plain `string`, which would put the expression outside the inference subset.
    date: c(
      '(%report.effective.ofType(dateTime) | %report.issued | authoredOn | occurrence.ofType(dateTime)).first().toString()',
      { default: null }
    ),
    orderedBy: c('requester.display', { default: null }),
    reportId: c('%report.where(presentedForm.exists()).id', { type: 'string', default: null }),
  }),
})

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

// --- mappers ---

// A reading must carry a UCUM code the engine can convert ('kg', '[lb_av]', 'cm',
// '[in_i]', …). convertsToQuantity() drops a display-only unit like `unit: "lbs"`
// with no code instead of guessing what it means.
const WEIGHT_CRITERIA =
  "code.coding.exists(system = %loinc and code in ('29463-7' | '3141-9'))" +
  " and value.ofType(Quantity).convertsToQuantity('kg')"
const HEIGHT_CRITERIA =
  "code.coding.exists(system = %loinc and code = '8302-2')" + " and value.ofType(Quantity).convertsToQuantity('m')"

/** Oldest first; a reading with no parseable timestamp sorts first. */
const byObservedAt = (a: { at?: Date | undefined }, b: { at?: Date | undefined }) =>
  (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0)

function round1(value: number): number {
  return Math.round(value * 10) / 10
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

/** Standard adult BMI categories collapsed to the three view statuses (overweight + obese → high). */
function bmiStatus(bmi: number): VitalStatus {
  if (bmi < 18.5) {
    return 'low'
  }
  if (bmi < 25) {
    return 'normal'
  }
  return 'high'
}

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
  const weights = fp.project(fp.filter(observations, WEIGHT_CRITERIA), WeightRowDTO).sort(byObservedAt)
  const heights = fp.project(fp.filter(observations, HEIGHT_CRITERIA), HeightRowDTO).sort(byObservedAt)

  const vitals: VitalTrend[] = []

  const weightSeries = weights.map(row => Math.round(row.lbs))
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
    const bmiSeries = weights.map(row => round1(row.kg / (latestHeightMeters * latestHeightMeters)))
    const latestBmi = bmiSeries.at(-1)
    if (latestBmi !== undefined) {
      vitals.push({
        key: 'bmi',
        label: 'BMI',
        value: latestBmi,
        unit: 'kg/m²',
        status: bmiStatus(latestBmi),
        trendPct: trendPercent(bmiSeries),
        series: bmiSeries,
      })
    }
  }

  return vitals
}

/** Maps active MedicationRequests to the Home-card medication view-model. */
export function mapMedications(requests: MedicationRequest[]): MedicationView[] {
  return fp.project(requests, MedicationCardDTO)
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
  return fp.project(fp.filter(requests, VISIBLE_MEDICATION), MedicationDetailDTO)
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
    ProblemDTO
  )
}

/**
 * Maps lab `DiagnosticReport`s to the Lab History view-model, preserving input order (the
 * server sorts newest-first). Does not set `documentUrl`: the consuming app owns how it
 * serves binaries, so it adds that field itself.
 */
export function mapLabs(reports: DiagnosticReport[]): Omit<LabView, 'documentUrl'>[] {
  return fp.project(reports, LabDTO)
}

/**
 * Maps lab orders to the Lab Results rows. Carries `reportId` rather than a
 * `documentUrl`, because the consuming app owns how it serves binaries.
 */
export function mapLabResults(
  orders: ServiceRequest[],
  reportsByOrderId: Map<string, DiagnosticReport>
): LabResultRow[] {
  const reports = [...reportsByOrderId].map(([orderId, report]) => ({ orderId, report }))
  return fp.project(orders.filter(isTopLevelOrder), LabResultDTO, { env: { reports } })
}

// --- static-analysis surface ---

/**
 * Everything the static checks need: the engine's functions, every DTO, and the
 * standalone expressions with the type each runs against. The test beside this
 * file runs analyzeDto and analyzeExpression over it, so a typo in any
 * expression fails CI.
 */
export const ANALYZED_USAGE = {
  functions: fp.defaults.functions ?? {},
  dtos: [
    CodeableConceptDTO,
    MedicationRequestDTO,
    ConditionDTO,
    DiagnosticReportDTO,
    WeightRowDTO,
    HeightRowDTO,
    MedicationCardDTO,
    MedicationDetailDTO,
    ProblemDTO,
    LabDTO,
    LabResultDTO,
  ],
  expressions: [
    { expression: WEIGHT_CRITERIA, inputType: 'Observation' },
    { expression: HEIGHT_CRITERIA, inputType: 'Observation' },
    { expression: VISIBLE_MEDICATION, inputType: 'MedicationRequest' },
    { expression: PATIENT_DISPLAY_NAME, inputType: 'Patient' },
  ],
} as const
