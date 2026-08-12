import { column, criteria, defineDto, type DtoOptions, FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

import type { StatusTone, VitalStatus } from './types'

// The DTO half of a real-usage module: the row shapes a patient-portal app
// projects, plus the engine that projects them. DTOs live in a `*.dto.ts` file by
// convention, which is how `fhirpath-check` finds and imports them — it then
// analyzes every column against this engine's own functions and env. The mappers
// that consume these rows are beside this file, in patient-view-mappers.ts.

export const LOINC = 'http://loinc.org'

/** How a lab badge renders. */
type LabBadge = { label: string; tone: StatusTone; flagged: boolean }

type StatusChoice = { code: string; label: string; tone: StatusTone }

// --- resource DTOs ---
// Each one binds recurring chains to a resource or datatype. Registered on the
// engine below, every column becomes a function any expression can call, and a
// DTO's own `static env` tables travel with its columns rather than joining the
// engine's env.

export class CodeableConceptDTO extends defineDto('CodeableConcept') {
  /** The text | display | code fallback. */
  @column('(text | coding.display.first() | coding.first().code).first()')
  displayText!: string | undefined
}

export class MedicationRequestDTO extends defineDto('MedicationRequest') {
  @column('(medication.ofType(CodeableConcept).displayText() | medication.ofType(Reference).display).first()', {
    type: 'string',
  })
  medicationName!: string | undefined

  @column(
    'dosageInstruction.first().doseAndRate.first().dose.ofType(Quantity)' +
      ".select(value.toString().combine((unit | code).first()).join(' '))"
  )
  doseText!: string | undefined

  @column('dosageInstruction.first().route.select(text | coding.display.first()).first()')
  routeText!: string | undefined

  @column('dosageInstruction.first().text')
  sigText!: string | undefined
}

export class ConditionDTO extends defineDto('Condition') {
  @column('clinicalStatus.coding.first().code')
  clinicalStatusCode!: string | undefined
}

/**
 * Health Gorilla puts the report-level interpretation (Normal / Abnormal / High …)
 * in an extension on the DiagnosticReport, using HL7 v2-0078 codes.
 */
const HG_INTERPRETATION = 'https://www.healthgorilla.com/fhir/StructureDefinition/diagnosticreport-interpretation'

/**
 * How each interpretation code shows on the card; `flagged` adds the warning
 * triangle. The codes are the standard HL7 interpretation codes (system v2-0078);
 * see https://hl7.org/fhir/R4/valueset-observation-interpretation.html.
 * The label/tone/flagged values are our own display choices.
 */
const INTERPRETATION_CHOICES: ({ code: string } & LabBadge)[] = [
  { code: 'N', label: 'Normal', tone: 'success', flagged: false },
  { code: 'A', label: 'Abnormal', tone: 'warning', flagged: true },
  { code: 'AA', label: 'Critical', tone: 'danger', flagged: true },
  { code: 'H', label: 'Above Normal', tone: 'warning', flagged: true },
  { code: 'HH', label: 'Critically High', tone: 'danger', flagged: true },
  { code: 'L', label: 'Below Normal', tone: 'warning', flagged: true },
  { code: 'LL', label: 'Critically Low', tone: 'danger', flagged: true },
]

/**
 * Fallback badge per report workflow status when there's no interpretation. Carries
 * flagged: false so reportBadge() can return a row from either table as-is.
 */
const REPORT_STATUS_CHOICES: ({ code: string } & LabBadge)[] = [
  { code: 'registered', label: 'Ordered', tone: 'info', flagged: false },
  { code: 'partial', label: 'Preliminary', tone: 'info', flagged: false },
  { code: 'preliminary', label: 'Preliminary', tone: 'info', flagged: false },
  { code: 'final', label: 'Final', tone: 'neutral', flagged: false },
  { code: 'amended', label: 'Amended', tone: 'neutral', flagged: false },
  { code: 'corrected', label: 'Corrected', tone: 'neutral', flagged: false },
  { code: 'appended', label: 'Amended', tone: 'neutral', flagged: false },
]

export class DiagnosticReportDTO extends defineDto('DiagnosticReport') {
  // The badge tables belong to this DTO: its columns read them, projected or
  // called, and no other expression on the engine can see them.
  static env = {
    hgInterpretation: HG_INTERPRETATION,
    interpretationChoices: INTERPRETATION_CHOICES,
    reportStatusChoices: REPORT_STATUS_CHOICES,
  }

  @column('extension.where(url = %hgInterpretation).first().value.ofType(CodeableConcept).coding.first().code')
  interpretation!: string | undefined

  /**
   * The report's badge row: the interpretation row when the Health Gorilla
   * extension carries one (only those can flag), else the workflow-status row.
   * Inside `where()` the focus is the table row being scanned, so the body first
   * saves its own input as %r to keep the report reachable by name.
   */
  @column(
    "defineVariable('r')" +
      '.select((%interpretationChoices.where(code = %r.interpretation()) | %reportStatusChoices.where(code = %r.status)).first())'
  )
  reportBadge!: LabBadge | undefined
}

// --- shared view-row bases ---
// A column several view rows share lives on a base class they extend; the two
// generic ones are factories because their rows sit on different resources.

/**
 * Row key: the resource id, else the row number. The expression always yields a
 * value, so the `default` exists only to type the column `string` instead of
 * `string | undefined`.
 */
type KeyedRoot = 'Condition' | 'DiagnosticReport' | 'MedicationRequest' | 'ServiceRequest'
type KeyedRowBase<Root extends KeyedRoot, Options extends DtoOptions> = (new () => InstanceType<
  ReturnType<typeof defineDto<Root, Options>>
> & { id: string }) & {
  readonly fhirType: Root
}

// Check the shared field against the supported roots once, then preserve the
// caller's exact root and options for decorators on each derived row.
function keyedRow<const Root extends KeyedRoot, const Options extends DtoOptions = Record<never, never>>(
  fhirType: Root,
  options?: Options
): KeyedRowBase<Root, Options>
function keyedRow(fhirType: KeyedRoot, options?: DtoOptions) {
  class KeyedRow extends defineDto(fhirType, options) {
    @column('(id | %rowIndex.toString()).first()', { default: '' })
    id!: string
  }
  return KeyedRow
}

/** The badge columns every lab row renders, reading the per-row %badge binding. */
function badgedRow<const Root extends KeyedRoot, const Options extends DtoOptions = Record<never, never>>(
  fhirType: Root,
  options?: Options
) {
  class BadgedRow extends keyedRow(fhirType, options) {
    @column('%badge.label', { type: 'string', default: 'Result' })
    statusLabel!: string

    // The badge tables only hold StatusTone values; `enum` types the column as
    // that union and drops anything else, so `default` catches the unexpected.
    @column('%badge.tone', { enum: ['info', 'success', 'warning', 'danger', 'neutral'], default: 'neutral' })
    tone!: StatusTone

    @column('%badge.flagged', { type: 'boolean', default: false })
    flagged!: boolean
  }
  return BadgedRow
}

// One engine for every mapper, module-level so its parse cache warms once per bundle.
export const fp = new FhirPathEngine({
  model: r4Model,
  env: { loinc: LOINC },
  resourceDtos: [CodeableConceptDTO, MedicationRequestDTO, ConditionDTO, DiagnosticReportDTO],
})

// --- view DTOs ---

/** One decimal place, shared by the weight rows and the trend maths in the mappers. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Every vitals row reads the same observation timestamp. */
export class ObservationRow extends defineDto('Observation') {
  @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
  at!: Date | undefined

  /** Oldest first; a reading with no parseable timestamp sorts first. */
  static byObservedAt(a: ObservationRow, b: ObservationRow): number {
    return (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0)
  }
}

/** Both lbs and kg on one row, so the weight trend and the BMI series come from one pass. */
export class WeightRow extends ObservationRow {
  @column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
  lbs!: number

  @column("value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
  kg!: number

  get roundedLbs(): number {
    return Math.round(this.lbs)
  }

  /** BMI for this reading against a height in metres, to one decimal. */
  bmi(heightMeters: number): number {
    return round1(this.kg / (heightMeters * heightMeters))
  }

  /** Standard adult BMI categories collapsed to the three view statuses (overweight + obese → high). */
  static bmiStatus(bmi: number): VitalStatus {
    if (bmi < 18.5) {
      return 'low'
    }
    return bmi < 25 ? 'normal' : 'high'
  }
}

export class HeightRow extends ObservationRow {
  @column("value.ofType(Quantity).toQuantity('m').value", { default: 0 })
  meters!: number
}

/** What both medication views share: the key, the name, and the dosing group. */
export class MedicationRow extends keyedRow('MedicationRequest') {
  @column('medicationName()', { type: 'string', default: 'Medication' })
  name!: string

  @column(
    'iif(dosageInstruction.first()' +
      '.select(asNeeded.ofType(boolean) = true or asNeeded.ofType(CodeableConcept).exists())' +
      ", 'asNeeded', 'continuous')",
    { enum: ['asNeeded', 'continuous'], default: 'continuous' }
  )
  group!: 'asNeeded' | 'continuous'
}

/** The Home-card medication view-model. */
export class MedicationCardRow extends MedicationRow {
  // The sig text, else "dose • route" from the recorded parts (empty when neither exists).
  @column("(sigText() | doseText().combine(routeText()).join(' • ')).first()", { type: 'string', default: '' })
  instructions!: string
}

/**
 * MedicationRequest.status display choices. No rows for draft and entered-in-error:
 * the mapper filters those out before the lookup. The `unknown` row is the real
 * 'unknown' status code, not a fallback — unexpected codes take the columns' defaults.
 */
const MEDICATION_STATUS_CHOICES: StatusChoice[] = [
  { code: 'active', label: 'Active', tone: 'success' },
  { code: 'on-hold', label: 'On Hold', tone: 'warning' },
  { code: 'stopped', label: 'Stopped', tone: 'neutral' },
  { code: 'cancelled', label: 'Cancelled', tone: 'danger' },
  { code: 'completed', label: 'Completed', tone: 'neutral' },
  { code: 'unknown', label: 'Unknown', tone: 'neutral' },
]

/** The Medications page view-model row. */
export class MedicationDetailRow extends MedicationRow {
  @column('doseText()', { type: 'string', default: '' })
  dose!: string

  @column('routeText()', { type: 'string', default: '' })
  route!: string

  @column('sigText()', { type: 'string', default: '' })
  instructions!: string

  // 'unknown' is itself a status code, so the default stays inside the inferred union.
  @column('status', { default: 'unknown' })
  status!: string

  @column('status', { choices: MEDICATION_STATUS_CHOICES, pick: 'label', default: 'Unknown' })
  statusLabel!: string

  @column('status', { choices: MEDICATION_STATUS_CHOICES, pick: 'tone', default: 'neutral' })
  tone!: StatusTone

  @criteria("status = 'active'")
  isActive!: boolean

  @column('authoredOn', { default: null })
  prescribedOn!: string | null

  // When a non-active request ended: the dispense validity end. Deliberately not
  // meta.lastUpdated — that is when the record row was last touched, not a clinical
  // end date, and the patient would see it as a real "ended on" date.
  @column("iif(status = 'active', {}, dispenseRequest.validityPeriod.end)", { default: null })
  endedOn!: string | null

  @column('requester.display', { default: null })
  prescriber!: string | null
}

/** Problem-list Condition.clinicalStatus display choices. */
const PROBLEM_STATUS_CHOICES: StatusChoice[] = [
  { code: 'active', label: 'Active', tone: 'info' },
  { code: 'recurrence', label: 'Recurrence', tone: 'danger' },
  { code: 'relapse', label: 'Relapse', tone: 'danger' },
  { code: 'remission', label: 'Remission', tone: 'warning' },
  { code: 'resolved', label: 'Resolved', tone: 'neutral' },
  { code: 'inactive', label: 'Inactive', tone: 'neutral' },
  { code: 'unknown', label: 'Unknown', tone: 'neutral' },
]

/** The problem-list view-model row, keyed off clinicalStatus. */
export class ProblemRow extends keyedRow('Condition') {
  @column('code.displayText()', { type: 'string', default: 'Condition' })
  name!: string

  @column('clinicalStatusCode()', { type: 'code', default: '' })
  statusCode!: string

  // The tone's fallback is a constant, so choices + default do it; the label
  // needs a computed one, so it reads the code back off the row.
  @column('clinicalStatusCode()', { choices: PROBLEM_STATUS_CHOICES, pick: 'tone', default: 'neutral' })
  tone!: StatusTone

  @column('meta.lastUpdated', { default: null })
  lastUpdated!: string | null

  /** The display label, title-casing a raw code outside the display choices. */
  get statusLabel(): string {
    return PROBLEM_STATUS_CHOICES.find(row => row.code === this.statusCode)?.label ?? this.titleCase(this.statusCode)
  }

  private titleCase(code: string): string {
    return code.charAt(0).toUpperCase() + code.slice(1)
  }
}

/** The Lab History view-model row; the report itself carries the badge. */
export class LabRow extends badgedRow('DiagnosticReport', { vars: { badge: 'reportBadge()' } }) {
  @column('code.displayText()', { type: 'string', default: 'Lab result' })
  name!: string

  @column('(effective.ofType(dateTime) | issued).first().toString()', { default: '' })
  date!: string
}

/**
 * The Lab Results view-model row, one per order. `%report` joins the
 * order→report table passed per call (a linear where() scan, fine at portal
 * list sizes). `%badge` is the report's badge when one exists, else the order's
 * own state — a revoked order will never produce results, so it is cancelled
 * rather than waiting.
 */
export class LabResultRow extends badgedRow('ServiceRequest', {
  // mapLabResults passes the order→report table per call, so the DTO declares
  // the name rather than owning the data.
  callerEnv: ['reports'],
  vars: {
    report: '%reports.where(orderId = %context.id).report',
    badge:
      "iif(%report.exists(), %report.reportBadge(), iif(%context.status = 'revoked', %cancelledBadge, %waitingBadge))",
  },
}) {
  // Badges for a lab order no table row can describe, because there is no report to read.
  static env = {
    waitingBadge: { label: 'Waiting', tone: 'warning', flagged: false } as LabBadge,
    cancelledBadge: { label: 'Cancelled', tone: 'neutral', flagged: false } as LabBadge,
  }

  // The ordered test names joined with commas; a blank join is dropped so the
  // order's own text can apply.
  @column(
    "(code.coding.select((display | code).first()).distinct().join(', ').where($this != '') | code.text).first()",
    { default: 'Lab order' }
  )
  name!: string

  // An order with no report shows its order date instead of a result date.
  // One literal (not a `+` concatenation): TypeScript types concatenation as
  // plain `string`, which would put the expression outside the inference subset.
  @column(
    '(%report.effective.ofType(dateTime) | %report.issued | authoredOn | occurrence.ofType(dateTime)).first().toString()',
    { default: null }
  )
  date!: string | null

  @column('requester.display', { default: null })
  orderedBy!: string | null

  @column('%report.where(presentedForm.exists()).id', { type: 'string', default: null })
  reportId!: string | null
}
