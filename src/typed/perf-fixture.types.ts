// tsc-perf fixture: keeps roughly a hundred typed expressions in the normal
// typecheck run so type-level inference cost regressions surface in CI.
import type { FhirpathResult, StateOf } from './infer.ts'

export type T001 = FhirpathResult<'Patient.name.given'>
export type T002 = FhirpathResult<'Patient.name.family'>
export type T003 = FhirpathResult<'Patient.birthDate'>
export type T004 = FhirpathResult<'Patient.active'>
export type T005 = FhirpathResult<'Patient.telecom.value'>
export type T006 = FhirpathResult<'Patient.address.city'>
export type T007 = FhirpathResult<'Patient.identifier.value'>
export type T008 = FhirpathResult<'Patient.contact.name.family'>
export type T009 = FhirpathResult<'Patient.name.first().given'>
export type T010 = FhirpathResult<'Patient.name.exists()'>
export type T011 = FhirpathResult<'Patient.name.count()'>
export type T012 = FhirpathResult<"Patient.name.where(use = 'official').family">
export type T013 = FhirpathResult<'Patient.name.select(given)'>
export type T014 = FhirpathResult<'Patient.deceased'>
export type T015 = FhirpathResult<'Patient.gender'>
export type T016 = FhirpathResult<'Patient.maritalStatus.coding.code'>
export type T017 = FhirpathResult<'Patient.communication.language.text'>
export type T018 = FhirpathResult<'Patient.name[0].family'>
export type T019 = FhirpathResult<'Patient.managingOrganization.reference'>
export type T020 = FhirpathResult<'Patient.link.other.reference'>
export type T021 = FhirpathResult<'Observation.status'>
export type T022 = FhirpathResult<'Observation.code.coding.system'>
export type T023 = FhirpathResult<'Observation.value.ofType(Quantity).unit'>
export type T024 = FhirpathResult<'Observation.issued'>
export type T025 = FhirpathResult<'Observation.category.coding.code'>
export type T026 = FhirpathResult<'Observation.component.code.text'>
export type T027 = FhirpathResult<'Observation.subject.reference'>
export type T028 = FhirpathResult<'Observation.referenceRange.low.value'>
export type T029 = FhirpathResult<'Observation.interpretation.text'>
export type T030 = FhirpathResult<'Observation.effective'>
export type T031 = FhirpathResult<'Bundle.entry.fullUrl'>
export type T032 = FhirpathResult<'Bundle.type'>
export type T033 = FhirpathResult<'Bundle.total'>
export type T034 = FhirpathResult<'Bundle.entry.request.method'>
export type T035 = FhirpathResult<'Bundle.link.url'>
export type T036 = FhirpathResult<'Encounter.status'>
export type T037 = FhirpathResult<'Encounter.class.code'>
export type T038 = FhirpathResult<'Encounter.period.start'>
export type T039 = FhirpathResult<'Encounter.participant.individual.reference'>
export type T040 = FhirpathResult<'Encounter.reasonCode.text'>
export type T041 = FhirpathResult<'Encounter.location.location.display'>
export type T042 = FhirpathResult<'MedicationRequest.status'>
export type T043 = FhirpathResult<'MedicationRequest.intent'>
export type T044 = FhirpathResult<'MedicationRequest.medication'>
export type T045 = FhirpathResult<'MedicationRequest.dosageInstruction.text'>
export type T046 = FhirpathResult<'MedicationRequest.dispenseRequest.quantity.value'>
export type T047 = FhirpathResult<'MedicationRequest.authoredOn'>
export type T048 = FhirpathResult<'MedicationRequest.requester.display'>
export type T049 = FhirpathResult<'Condition.clinicalStatus.coding.code'>
export type T050 = FhirpathResult<'Condition.severity.text'>
export type T051 = FhirpathResult<'Condition.onset'>
export type T052 = FhirpathResult<'Condition.recordedDate'>
export type T053 = FhirpathResult<'Condition.bodySite.coding.display'>
export type T054 = FhirpathResult<'Condition.stage.summary.text'>
export type T055 = FhirpathResult<'DiagnosticReport.status'>
export type T056 = FhirpathResult<'DiagnosticReport.conclusion'>
export type T057 = FhirpathResult<'DiagnosticReport.result.reference'>
export type T058 = FhirpathResult<'DiagnosticReport.issued'>
export type T059 = FhirpathResult<'DiagnosticReport.category.text'>
export type T060 = FhirpathResult<'AllergyIntolerance.clinicalStatus.coding.code'>
export type T061 = FhirpathResult<'AllergyIntolerance.criticality'>
export type T062 = FhirpathResult<'AllergyIntolerance.reaction.severity'>
export type T063 = FhirpathResult<'AllergyIntolerance.reaction.manifestation.text'>
export type T064 = FhirpathResult<'AllergyIntolerance.onset'>
export type T065 = FhirpathResult<'Immunization.status'>
export type T066 = FhirpathResult<'Immunization.vaccineCode.text'>
export type T067 = FhirpathResult<'Immunization.occurrence'>
export type T068 = FhirpathResult<'Immunization.lotNumber'>
export type T069 = FhirpathResult<'Immunization.doseQuantity.value'>
export type T070 = FhirpathResult<'Appointment.status'>
export type T071 = FhirpathResult<'Appointment.start'>
export type T072 = FhirpathResult<'Appointment.end'>
export type T073 = FhirpathResult<'Appointment.participant.actor.display'>
export type T074 = FhirpathResult<'Appointment.description'>
export type T075 = FhirpathResult<'CarePlan.status'>
export type T076 = FhirpathResult<'CarePlan.intent'>
export type T077 = FhirpathResult<'CarePlan.title'>
export type T078 = FhirpathResult<'CarePlan.activity.detail.status'>
export type T079 = FhirpathResult<'CarePlan.period.end'>
export type T080 = FhirpathResult<'Procedure.status'>
export type T081 = FhirpathResult<'Procedure.code.text'>
export type T082 = FhirpathResult<'Procedure.performed'>
export type T083 = FhirpathResult<'Procedure.outcome.text'>
export type T084 = FhirpathResult<'Procedure.performer.actor.display'>
export type T085 = FhirpathResult<'Questionnaire.status'>
export type T086 = FhirpathResult<'Questionnaire.title'>
export type T087 = FhirpathResult<'Questionnaire.item.text'>
export type T088 = FhirpathResult<'Questionnaire.item.item.linkId'>
export type T089 = FhirpathResult<'Questionnaire.item.type'>
export type T090 = FhirpathResult<'QuestionnaireResponse.status'>
export type T091 = FhirpathResult<'QuestionnaireResponse.item.answer.value'>
export type T092 = FhirpathResult<'QuestionnaireResponse.item.linkId'>
export type T093 = FhirpathResult<'QuestionnaireResponse.authored'>
export type T094 = FhirpathResult<'ValueSet.status'>
export type T095 = FhirpathResult<'ValueSet.url'>
export type T096 = FhirpathResult<'ValueSet.expansion.contains.code'>
export type T097 = FhirpathResult<'ValueSet.compose.include.system'>
export type T098 = FhirpathResult<"Observation.value.ofType(Quantity).toQuantity('kg').value">
export type T099 = FhirpathResult<"Observation.value.ofType(Quantity).toQuantity('kg.m/s2').value">
export type T100 = FhirpathResult<'Patient.birthDate.toDate()'>
export type T101 = FhirpathResult<'Patient.birthDate.convertsToDateTime()'>
export type T102 = FhirpathResult<"Patient.name.given.join(', ')">
export type T103 = FhirpathResult<'Patient.name.family.first().toChars()'>
export type T104 = FhirpathResult<'Patient.name.given.first().toString()'>
export type T105 = FhirpathResult<"Patient.name.where(given.first() = 'Peter').family">
export type T106 = FhirpathResult<'Patient.name.where(use.exists() and given.exists()).given'>
export type T107 = FhirpathResult<"Patient.name.exists(use = 'official')">
export type T108 = FhirpathResult<'Patient.name.select(given.first()).count()'>
export type T109 = FhirpathResult<"MedicationRequest.dosageInstruction.text.join('; ')">
export type T110 = FhirpathResult<'Observation.component.value.ofType(Quantity).value.first().toString()'>
// Fixed-return batch 2 (string/boolean/numeric) and identity functions.
export type T111 = FhirpathResult<'Patient.name.family.first().trim()'>
export type T112 = FhirpathResult<'Patient.name.given.first().substring(0, 1)'>
export type T113 = FhirpathResult<"Patient.name.family.first().replace('mers', 'm')">
export type T114 = FhirpathResult<"Patient.name.family.first().matches('^Ch')">
export type T115 = FhirpathResult<"Patient.name.given.first().startsWith('Pe')">
export type T116 = FhirpathResult<"Patient.name.given.first().indexOf('e')">
export type T117 = FhirpathResult<'Patient.name.count().toDecimal().round()'>
export type T118 = FhirpathResult<'Patient.name.count().sqrt()'>
export type T119 = FhirpathResult<'Patient.name.given.distinct()'>
export type T120 = FhirpathResult<'Patient.name.given.skip(1).take(2)'>
export type T121 = FhirpathResult<"Patient.name.given.first().split('e')">
export type T122 = FhirpathResult<'Patient.name.all(use.exists())'>
// Union groups, top-level unions, and %var roots.
export type T123 = FhirpathResult<'Patient.name.given | Patient.name.family'>
export type T124 = FhirpathResult<'(Patient.name.given | Patient.name.family).first()'>
export type T125 =
  FhirpathResult<'(DiagnosticReport.effective.ofType(dateTime) | DiagnosticReport.issued).first().toString()'>
export type T126 = FhirpathResult<'((Patient.name.given | Patient.name.family) | Patient.id).first()'>
export type T127 = FhirpathResult<'Patient.name.select((given | family).first())'>
export type T128 =
  FhirpathResult<'MedicationRequest.dosageInstruction.first().route.select(text | coding.display.first()).first()'>
export type T129 = FhirpathResult<'%rowIndex.toString()'>
export type T130 =
  FhirpathResult<'(%report.effective.ofType(dateTime) | %report.issued | ServiceRequest.authoredOn | ServiceRequest.occurrence.ofType(dateTime)).first().toString()'>
export type T131 = FhirpathResult<'(id | %rowIndex.toString()).first()'>
export type T132 = FhirpathResult<"Patient.name.where(family = 'a|b').given">
export type T133 = FhirpathResult<'Patient.name.where(a.exists()).given'>
export type T134 = FhirpathResult<'Patient.name.select(given.first()).count()'>
// The type-level function registry (custom-function calls and relative StateOf).
type DemoFns = {
  displayText: { in: 'CodeableConcept'; out: 'string' }
  rowKey: { in: string; out: 'opaque' }
}
export type T135 = FhirpathResult<'Condition.code.displayText()', DemoFns>
export type T136 = FhirpathResult<'Patient.name.displayText()', DemoFns>
export type T137 = StateOf<'(text | coding.display.first() | coding.first().code).first()', 'CodeableConcept'>
export type T138 = StateOf<
  '(medication.ofType(CodeableConcept).displayText() | medication.ofType(Reference).display).first()',
  'MedicationRequest',
  DemoFns
>
export type T139 = StateOf<
  'dosageInstruction.first().route.select(text | coding.display.first()).first()',
  'MedicationRequest'
>
