import type {
  Condition,
  DiagnosticReport,
  MedicationRequest,
  Observation,
  Patient,
  ServiceRequest,
} from '@medplum/fhirtypes'
import { column, declareColumn, FhirPathEngine } from 'fhirpath-ts'
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
// DTO classes, declared columns, vars joins, display tables, and enum columns,
// with @medplum/fhirtypes inputs. The test beside this file asserts every
// exported mapper end to end and runs both analyzers over every expression
// (see ANALYZED_USAGE at the bottom).

export const LOINC = 'http://loinc.org'

/** How a lab badge renders. */
type LabBadge = { label: string; tone: StatusTone; flagged: boolean }

type StatusMeta = { label: string; tone: StatusTone }

// --- resource DTOs ---
// Each class binds recurring chains to one resource or datatype. Registered on the
// engine below, every column becomes a function any expression can call, and each
// class's env tables register engine-wide with it.

class CodeableConceptDTO {
  static readonly fhirType = 'CodeableConcept'
  /** The text | display | code fallback. */
  displayText = column('(text | coding.display.first() | coding.first().code).first()', { type: 'string' })
}

class MedicationRequestDTO {
  static readonly fhirType = 'MedicationRequest'
  medicationName = column(
    '(medication.ofType(CodeableConcept).displayText() | medication.ofType(Reference).display).first()',
    { type: 'string' }
  )
  doseText = column(
    'dosageInstruction.first().doseAndRate.first().dose.ofType(Quantity)' +
      ".select(value.toString().combine((unit | code).first()).join(' '))",
    { type: 'string' }
  )
  routeText = column('dosageInstruction.first().route.select(text | coding.display.first()).first()', {
    type: 'string',
  })
  // The resource-name root lets the type layer infer this column (relative
  // paths have no root the type system can see); the runtime treats both the
  // same. Datatype DTOs must keep relative paths — a datatype-name root
  // matches nothing at runtime.
  sigText = column('MedicationRequest.dosageInstruction.first().text')
}

class ConditionDTO {
  static readonly fhirType = 'Condition'
  clinicalStatusCode = column('Condition.clinicalStatus.coding.first().code')
}

/**
 * reportBadge() picks a report's badge row: the interpretation row when the Health
 * Gorilla extension carries one (only those can flag), else the workflow-status
 * row. Inside `where()` the focus is the table row being scanned, so the body
 * first saves its own input as %r to keep the report reachable by name.
 */
class DiagnosticReportDTO {
  static readonly fhirType = 'DiagnosticReport'
  static readonly env = {
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
  }
  interpretation = column(
    'DiagnosticReport.extension.where(url = %hgInterpretation).first().value.ofType(CodeableConcept).coding.first().code'
  )
  reportBadge = column(
    "defineVariable('r')" +
      '.select((%interpretationMeta.where(code = %r.interpretation()) | %reportStatusMeta.where(code = %r.status)).first())'
  )
}

// --- shared columns, declared once and registered engine-wide ---

/**
 * Row key: the resource id, else the row number. The expression always yields a
 * value, so the `default` exists only to type the column `string` instead of
 * `string | undefined`.
 */
const IdColumn = declareColumn('rowKey', '(id | %rowIndex.toString()).first()', { type: 'string', default: '' })

const ObservedAt = declareColumn('observedAt', '(effective.ofType(dateTime) | issued).first()', { as: 'Date' })

const GroupColumn = declareColumn(
  'medicationGroup',
  'iif(dosageInstruction.first()' +
    '.select(asNeeded.ofType(boolean) = true or asNeeded.ofType(CodeableConcept).exists())' +
    ", 'asNeeded', 'continuous')",
  { enum: ['asNeeded', 'continuous'], default: 'continuous' }
)

// One engine for every mapper, module-level so its parse cache warms once per bundle.
const fp = new FhirPathEngine({
  model: r4Model,
  env: { loinc: LOINC },
  resourceDtos: [CodeableConceptDTO, MedicationRequestDTO, ConditionDTO, DiagnosticReportDTO],
  columns: [IdColumn, ObservedAt, GroupColumn],
})

// --- view DTOs ---

/** Both lbs and kg on one row, so the weight trend and the BMI series come from one pass. */
class WeightRowDTO {
  static readonly fhirType = 'Observation'
  lbs = column("Observation.value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
  kg = column("Observation.value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
  at = ObservedAt()
}

class HeightRowDTO {
  static readonly fhirType = 'Observation'
  meters = column("Observation.value.ofType(Quantity).toQuantity('m').value", { default: 0 })
  at = ObservedAt()
}

/** The Home-card medication view-model. */
class MedicationCardDTO {
  static readonly fhirType = 'MedicationRequest'
  id = IdColumn()
  name = column('MedicationRequest.medicationName()', { type: 'string', default: 'Medication' })
  // The sig text, else "dose • route" from the recorded parts (empty when neither exists).
  instructions = column(
    "(MedicationRequest.sigText() | MedicationRequest.doseText().combine(MedicationRequest.routeText()).join(' • ')).first()",
    { type: 'string', default: '' }
  )
  group = GroupColumn()
}

/** The Medications page view-model row. */
class MedicationDetailDTO {
  static readonly fhirType = 'MedicationRequest'
  /**
   * MedicationRequest.status display table. No rows for draft and entered-in-error:
   * the mapper filters those out before the lookup. The `unknown` row is the real
   * 'unknown' status code, not a fallback — unexpected codes take the columns' defaults.
   */
  static readonly statusMeta: ({ code: string } & StatusMeta)[] = [
    { code: 'active', label: 'Active', tone: 'success' },
    { code: 'on-hold', label: 'On Hold', tone: 'warning' },
    { code: 'stopped', label: 'Stopped', tone: 'neutral' },
    { code: 'cancelled', label: 'Cancelled', tone: 'danger' },
    { code: 'completed', label: 'Completed', tone: 'neutral' },
    { code: 'unknown', label: 'Unknown', tone: 'neutral' },
  ]
  id = IdColumn()
  name = column('MedicationRequest.medicationName()', { type: 'string', default: 'Medication' })
  dose = column('MedicationRequest.doseText()', { type: 'string', default: '' })
  route = column('MedicationRequest.routeText()', { type: 'string', default: '' })
  instructions = column('MedicationRequest.sigText()', { type: 'string', default: '' })
  group = GroupColumn()
  // 'unknown' is itself a status code, so the default stays inside the inferred union.
  status = column('MedicationRequest.status', { default: 'unknown' })
  statusLabel = column('MedicationRequest.status', {
    map: MedicationDetailDTO.statusMeta,
    pick: 'label',
    default: 'Unknown',
  })
  tone = column('MedicationRequest.status', {
    map: MedicationDetailDTO.statusMeta,
    pick: 'tone',
    default: 'neutral' as StatusTone,
  })
  isActive = column({ test: "MedicationRequest.status = 'active'" })
  prescribedOn = column('MedicationRequest.authoredOn', { default: null })
  // When a non-active request ended: the dispense validity end. Deliberately not
  // meta.lastUpdated — that is when the record row was last touched, not a clinical
  // end date, and the patient would see it as a real "ended on" date.
  endedOn = column(
    "iif(MedicationRequest.status = 'active', {}, MedicationRequest.dispenseRequest.validityPeriod.end)",
    { type: 'dateTime', default: null }
  )
  prescriber = column('MedicationRequest.requester.display', { default: null })
}

/** The problem-list view-model row, keyed off clinicalStatus. */
class ProblemDTO {
  static readonly fhirType = 'Condition'
  /** Problem-list Condition.clinicalStatus display table. */
  static readonly statusMeta: ({ code: string } & StatusMeta)[] = [
    { code: 'active', label: 'Active', tone: 'info' },
    { code: 'recurrence', label: 'Recurrence', tone: 'danger' },
    { code: 'relapse', label: 'Relapse', tone: 'danger' },
    { code: 'remission', label: 'Remission', tone: 'warning' },
    { code: 'resolved', label: 'Resolved', tone: 'neutral' },
    { code: 'inactive', label: 'Inactive', tone: 'neutral' },
    { code: 'unknown', label: 'Unknown', tone: 'neutral' },
  ]

  /** Title-case echo of a raw code, the label fallback for codes outside the display table. */
  private static titleCase(code: string): string {
    return code.charAt(0).toUpperCase() + code.slice(1)
  }

  id = IdColumn()
  name = column('Condition.code.displayText()', { type: 'string', default: 'Condition' })
  // The label needs a computed fallback (title-case the raw code), so it is an
  // `as` function; the tone's fallback is constant, so `map` + `default` do.
  statusLabel = column('Condition.clinicalStatusCode()', {
    as: value => ProblemDTO.statusMeta.find(row => row.code === value)?.label ?? ProblemDTO.titleCase(String(value)),
    default: 'Unknown',
  })
  tone = column('Condition.clinicalStatusCode()', {
    map: ProblemDTO.statusMeta,
    pick: 'tone',
    default: 'neutral' as StatusTone,
  })
  lastUpdated = column('Condition.meta.lastUpdated', { default: null })
}

/** The badge columns every lab row renders, reading the per-row %badge binding. */
class LabBadgeRow {
  statusLabel = column('%badge.label', { type: 'string', default: 'Result' })
  // The badge tables only hold StatusTone values; `enum` types the column as
  // that union and drops anything else, so `default` catches the unexpected.
  tone = column('%badge.tone', { enum: ['info', 'success', 'warning', 'danger', 'neutral'], default: 'neutral' })
  flagged = column('%badge.flagged', { type: 'boolean', default: false })
}

/** The Lab History view-model row; the report itself carries the badge. */
class LabDTO extends LabBadgeRow {
  static readonly fhirType = 'DiagnosticReport'
  static readonly vars = { badge: 'reportBadge()' }
  id = IdColumn()
  name = column('DiagnosticReport.code.displayText()', { type: 'string', default: 'Lab result' })
  date = column('(DiagnosticReport.effective.ofType(dateTime) | DiagnosticReport.issued).first().toString()', {
    type: 'string',
    default: '',
  })
}

/**
 * The Lab Results view-model row, one per order. `%report` joins the
 * order→report table passed per call (a linear where() scan, fine at portal
 * list sizes). `%badge` is the report's badge when one exists, else the order's
 * own state — a revoked order will never produce results, so it is cancelled
 * rather than waiting.
 */
class LabResultDTO extends LabBadgeRow {
  static readonly fhirType = 'ServiceRequest'
  static readonly env = {
    // Badges for a lab order no table row can describe, because there is no report to read.
    waitingBadge: { label: 'Waiting', tone: 'warning', flagged: false } as LabBadge,
    cancelledBadge: { label: 'Cancelled', tone: 'neutral', flagged: false } as LabBadge,
  }
  static readonly vars = {
    report: '%reports.where(orderId = %context.id).report',
    badge:
      "iif(%report.exists(), %report.reportBadge(), iif(%context.status = 'revoked', %cancelledBadge, %waitingBadge))",
  }
  id = IdColumn()
  // The ordered test names joined with commas; a blank join is dropped so the
  // order's own text can apply.
  name = column(
    "(ServiceRequest.code.coding.select((display | code).first()).distinct().join(', ')" +
      ".where($this != '') | ServiceRequest.code.text).first()",
    { type: 'string', default: 'Lab order' }
  )
  // An order with no report shows its order date instead of a result date.
  date = column(
    '(%report.effective.ofType(dateTime) | %report.issued' +
      ' | ServiceRequest.authoredOn | ServiceRequest.occurrence.ofType(dateTime)).first().toString()',
    { type: 'string', default: null }
  )
  orderedBy = column('ServiceRequest.requester.display', { default: null })
  reportId = column('%report.where(presentedForm.exists()).id', { type: 'string', default: null })
}

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
 * Everything the static checks need: the engine's functions, every DTO class,
 * and the standalone expressions with the type each runs against. The test
 * beside this file runs analyzeDto and analyzeExpression over it, so a typo
 * in any expression fails CI.
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
