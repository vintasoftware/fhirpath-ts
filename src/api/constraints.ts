import { FhirPathError } from '../errors.ts'
import { criteriaBoolean } from '../values/collection.ts'
import { isBundle, toSubjects } from './bundle.ts'
import type { Compiler, EvaluateOptions } from './compile.ts'

/** An invariant to check, shaped like FHIR's `ElementDefinition.constraint`. */
export interface FhirConstraint {
  /** Constraint id, e.g. `pat-1`. */
  key: string
  /** `error` (default) fails validation; `warning` is reported but does not. */
  severity?: 'error' | 'warning'
  /** Human-readable description of the rule. */
  human?: string
  /** FHIRPath expression that must evaluate to true. */
  expression: string
}

/** A constraint that did not hold, echoing its definition. */
export interface ConstraintIssue {
  key: string
  severity: 'error' | 'warning'
  human?: string
  expression: string
  /** Set when the expression itself failed to parse or evaluate, with the engine error. */
  error?: string
  /** For array or Bundle inputs: position of the failing resource (in the array, or in `Bundle.entry`). */
  index?: number
}

/** Minimal OperationOutcome shape; structurally assignable to the full R4 type. */
export interface OperationOutcome {
  resourceType: 'OperationOutcome'
  issue: {
    severity: 'error' | 'warning' | 'information'
    code: 'invariant' | 'informational'
    details: { text: string }
    diagnostics?: string
    /** For Bundle inputs: FHIRPath to the failing entry resource, e.g. `Bundle.entry[3].resource`. */
    expression?: string[]
  }[]
}

export interface ConstraintCheckResult {
  /** True when no error-severity constraint failed; warnings do not invalidate. */
  valid: boolean
  /** The constraints that failed (both severities), in input order. */
  issues: ConstraintIssue[]
  /** The same issues as a FHIR OperationOutcome (`issue.code = 'invariant'`, validator-style). */
  toOperationOutcome(): OperationOutcome
}

/** Implementation behind `FhirPathEngine.checkConstraints`; options come pre-merged. */
export function evaluateConstraints(
  input: unknown,
  constraints: readonly FhirConstraint[],
  options: EvaluateOptions,
  compile: Compiler
): ConstraintCheckResult {
  const bundle = isBundle(input)
  const issues: ConstraintIssue[] = []
  for (const subject of toSubjects(input)) {
    for (const constraint of constraints) {
      const issue: ConstraintIssue = {
        key: constraint.key,
        severity: constraint.severity ?? 'error',
        expression: constraint.expression,
        ...(constraint.human === undefined ? {} : { human: constraint.human }),
        ...(subject.index === undefined ? {} : { index: subject.index }),
      }
      try {
        if (!criteriaBoolean(compile(constraint.expression).evaluateTyped(subject.value, options))) {
          issues.push(issue)
        }
      } catch (error) {
        issue.error = error instanceof FhirPathError ? error.message : String(error)
        issues.push(issue)
      }
    }
  }
  return {
    valid: issues.every(issue => issue.severity !== 'error'),
    issues,
    toOperationOutcome: () => toOperationOutcome(issues, bundle),
  }
}

function toOperationOutcome(issues: ConstraintIssue[], bundle: boolean): OperationOutcome {
  if (issues.length === 0) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'information', code: 'informational', details: { text: 'All constraints passed' } }],
    }
  }
  return {
    resourceType: 'OperationOutcome',
    issue: issues.map(issue => ({
      severity: issue.severity,
      code: 'invariant',
      details: { text: issue.human ?? `Constraint ${issue.key} failed` },
      diagnostics: issue.error === undefined ? issue.expression : `${issue.expression} (${issue.error})`,
      ...(bundle && issue.index !== undefined ? { expression: [`Bundle.entry[${issue.index}].resource`] } : {}),
    })),
  }
}
