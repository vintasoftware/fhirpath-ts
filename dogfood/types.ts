// The view-model types the mappers produce — the shapes a UI package would
// declare. Projected DTO rows must satisfy them, so a column type drifting
// (say, a tone widening to string) is a compile error here.

export type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

export type VitalStatus = 'low' | 'normal' | 'high'

export interface VitalTrend {
  key: string
  label: string
  value: number
  unit: string
  status: VitalStatus | null
  trendPct: number | null
  series: number[]
}

export interface MedicationView {
  id: string
  name: string
  instructions: string
  group: 'asNeeded' | 'continuous'
}

export interface MedicationDetailView extends MedicationView {
  dose: string
  route: string
  status: string
  statusLabel: string
  tone: StatusTone
  isActive: boolean
  prescribedOn: string | null
  endedOn: string | null
  prescriber: string | null
}

export interface ProblemView {
  id: string
  name: string
  statusLabel: string
  tone: StatusTone
  lastUpdated: string | null
}

export interface LabView {
  id: string
  name: string
  statusLabel: string
  tone: StatusTone
  flagged: boolean
  date: string
  documentUrl: string
}

export interface LabResultRow {
  id: string
  name: string
  date: string | null
  statusLabel: string
  tone: StatusTone
  flagged: boolean
  orderedBy: string | null
  reportId: string | null
}
