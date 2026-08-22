import type { AnalyzerVariable } from './declarations.ts'

/** Internal source-analysis metadata. A symbol keeps it out of the public AnalyzeOptions contract. */
export const SOURCE_VARIABLE_DEFAULTS = Symbol('sourceVariableDefaults')

export interface SourceVariableDefaults {
  /** Final normalized engine-default vars value names in Object.entries order. */
  values: readonly string[]
  /** Engine-default varTypes declarations. */
  declarations: Readonly<Record<string, AnalyzerVariable>>
}

/** Ordered vars metadata shared by source extraction and loaded-context analysis. */
export interface SourceVariablePlan {
  values: readonly string[]
  declarations: Readonly<Record<string, AnalyzerVariable>>
  inheritsDeclarations: boolean
  before?: string
}
